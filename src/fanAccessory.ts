import type { API, CharacteristicValue, Logger, PlatformAccessory, Service } from 'homebridge';

import {
  FAN_SPEED_MAX,
  FAN_SPEED_MIN,
  FanCommand,
  FanInfo,
  FanState,
  LIGHT_BRIGHTNESS_MAX,
  LIGHT_BRIGHTNESS_MIN,
  ModernFormsClient,
} from './modernFormsApi';

export interface FanAccessoryContext {
  info: FanInfo;
  /** Where the fan was last reached (IP address or host name, optionally with :port). */
  host: string;
  /** Last known status; restored on restart until the fan answers. */
  state?: FanState;
}

export type FanClient = Pick<ModernFormsClient, 'host' | 'getState' | 'setState'>;

export interface FanAccessoryDeps {
  api: API;
  log: Logger;
  client: FanClient;
  /** Background status check; 0 turns it off. */
  pollingIntervalMs: number;
  /** Minimum gap between refreshes triggered by HomeKit reads. */
  refreshMinIntervalMs: number;
  /** Writes arriving within this window are sent as one command. */
  coalesceMs: number;
  /** Consecutive failures before showing "No Response". */
  offlineAfterFailures: number;
  /** Called when the fan stops answering (its IP address may have changed). */
  onUnreachable?: () => void;
  now?: () => number;
}

const DEFAULT_STATE: FanState = { fanOn: false, fanSpeed: FAN_SPEED_MIN, fanDirection: 'forward', lightOn: false, lightBrightness: LIGHT_BRIGHTNESS_MAX };

/** HomeKit's 0-100 % rotation speed for a fan speed of 1-6. */
export function speedToPercent(speed: number): number {
  return Math.round((speed * 100) / FAN_SPEED_MAX);
}

/** The nearest fan speed (1-6) for a HomeKit rotation speed above 0 %. */
export function percentToSpeed(percent: number): number {
  return Math.min(FAN_SPEED_MAX, Math.max(FAN_SPEED_MIN, Math.round((percent * FAN_SPEED_MAX) / 100)));
}

/** HomeKit names must start and end with a letter or number. */
export function sanitizeName(name: string | undefined, fallback = 'Modern Forms Fan'): string {
  const cleaned = (name ?? '')
    .replace(/[^\p{L}\p{N} '’.,-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  return cleaned || fallback;
}

/** HAP wants FirmwareRevision as up to three plain numbers: "02.00.0052" becomes "2.0.52". */
export function formatFirmware(version: string | undefined): string | undefined {
  if (!version || !/^\d+(\.\d+){0,2}$/.test(version)) {
    return undefined;
  }
  return version.split('.').map((part) => String(Number(part))).join('.');
}

export function describeState(state: FanState, hasLight: boolean): string {
  const fan = state.fanOn ? `fan on at speed ${state.fanSpeed}` : 'fan off';
  const direction = state.fanDirection === 'reverse' ? 'reverse/winter' : 'forward/summer';
  const light = state.lightOn ? `light on at ${state.lightBrightness}%` : 'light off';
  return hasLight ? `${fan} (${direction}), ${light}` : `${fan} (${direction})`;
}

export function describeCommand(command: FanCommand): string {
  const parts: string[] = [];
  if (command.fanOn !== undefined) {
    parts.push(command.fanOn ? 'fan on' : 'fan off');
  }
  if (command.fanSpeed !== undefined) {
    parts.push(`speed ${command.fanSpeed}`);
  }
  if (command.fanDirection !== undefined) {
    parts.push(command.fanDirection === 'reverse' ? 'reverse/winter' : 'forward/summer');
  }
  if (command.lightOn !== undefined) {
    parts.push(command.lightOn ? 'light on' : 'light off');
  }
  if (command.lightBrightness !== undefined) {
    parts.push(`brightness ${command.lightBrightness}%`);
  }
  return parts.join(', ');
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * Exposes one fan to HomeKit: a Fan (on/off, speed, direction) plus a
 * Lightbulb (on/off, brightness) when the fan has a light kit.
 *
 * Reads are answered instantly from the last known status and trigger a
 * throttled background refresh, so HomeKit never waits on the fan. Writes
 * that arrive together are merged into one command.
 */
export class FanAccessory {
  private readonly fanService: Service;
  private readonly lightService?: Service;
  private readonly now: () => number;
  private client: FanClient;
  private online = true;
  private failures = 0;
  private lastRefreshAt = 0;
  private refreshing?: Promise<void>;
  private pollTimer?: NodeJS.Timeout;
  private disposed = false;

  /** Explicit writes not sent yet. */
  private pending: FanCommand = {};
  /** "On" implied by a speed/brightness write; an explicit on/off in the same batch wins. */
  private implied: FanCommand = {};
  private waiters: Waiter[] = [];
  private flushTimer?: NodeJS.Timeout;
  /** Commands sent but not answered yet, oldest first. */
  private inFlight: FanCommand[] = [];

  constructor(
    private readonly deps: FanAccessoryDeps,
    readonly accessory: PlatformAccessory<FanAccessoryContext>,
  ) {
    const { Service: S, Characteristic: C } = deps.api.hap;
    this.now = deps.now ?? Date.now;
    this.client = deps.client;
    const { info } = accessory.context;

    const infoService = accessory.getService(S.AccessoryInformation) ?? accessory.addService(S.AccessoryInformation);
    infoService
      .setCharacteristic(C.Manufacturer, /^WAC_/i.test(info.clientId) ? 'WAC Lighting' : 'Modern Forms')
      .setCharacteristic(C.Model, info.fanType || 'Smart Fan')
      .setCharacteristic(C.SerialNumber, info.mac || info.clientId);
    const firmware = formatFirmware(info.firmwareVersion);
    if (firmware) {
      infoService.setCharacteristic(C.FirmwareRevision, firmware);
    }

    this.fanService = this.ensureService(S.Fanv2, accessory.displayName);
    this.fanService.setPrimaryService(true);
    this.fanService.getCharacteristic(C.Active)
      .onGet(() => this.read((s) => (s.fanOn ? C.Active.ACTIVE : C.Active.INACTIVE)))
      .onSet((value) => this.write({ fanOn: value === C.Active.ACTIVE }));
    this.fanService.getCharacteristic(C.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(() => this.read((s) => speedToPercent(s.fanSpeed)))
      .onSet((value) => {
        const percent = Number(value);
        return percent > 0
          ? this.write({ fanSpeed: percentToSpeed(percent) }, { fanOn: true })
          : this.write({ fanOn: false });
      });
    this.fanService.getCharacteristic(C.RotationDirection)
      // Summer mode turns counter-clockwise seen from below, pushing air down.
      .onGet(() => this.read((s) => (s.fanDirection === 'reverse'
        ? C.RotationDirection.CLOCKWISE
        : C.RotationDirection.COUNTER_CLOCKWISE)))
      .onSet((value) => this.write({ fanDirection: value === C.RotationDirection.CLOCKWISE ? 'reverse' : 'forward' }));

    const staleLight = accessory.getService(S.Lightbulb);
    if (info.lightType) {
      this.lightService = staleLight ?? this.ensureService(S.Lightbulb, `${accessory.displayName} Light`);
      this.lightService.getCharacteristic(C.On)
        .onGet(() => this.read((s) => s.lightOn))
        .onSet((value) => this.write({ lightOn: value === true || value === 1 }));
      this.lightService.getCharacteristic(C.Brightness)
        .onGet(() => this.read((s) => s.lightBrightness))
        .onSet((value) => {
          const brightness = Number(value);
          return brightness > 0
            ? this.write({ lightBrightness: Math.min(LIGHT_BRIGHTNESS_MAX, Math.max(LIGHT_BRIGHTNESS_MIN, Math.round(brightness))) },
              { lightOn: true })
            : this.write({ lightOn: false });
        });
    } else if (staleLight) {
      accessory.removeService(staleLight);
    }

    this.push();
    if (deps.pollingIntervalMs > 0) {
      this.pollTimer = setInterval(() => void this.refresh(), deps.pollingIntervalMs);
      this.pollTimer.unref?.();
    }
  }

  get name(): string {
    return this.accessory.displayName;
  }

  get host(): string {
    return this.client.host;
  }

  get isOnline(): boolean {
    return this.online;
  }

  /** Points the accessory at a new address (the fan's IP changed) and refreshes. */
  setClient(client: FanClient): void {
    this.client = client;
    this.accessory.context.host = client.host;
    this.persist();
    void this.refresh(true);
  }

  /** Stops timers; pending writes fail. */
  dispose(): void {
    this.disposed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const { HapStatusError, HAPStatus } = this.deps.api.hap;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
    }
  }

  /**
   * Reads the fan's status. Throttled (unless `force`) and coalesced with a
   * refresh already running; changes are pushed to HomeKit.
   */
  refresh(force = false): Promise<void> {
    if (this.refreshing) {
      return this.refreshing;
    }
    const now = this.now();
    if (this.disposed || (!force && now - this.lastRefreshAt < this.deps.refreshMinIntervalMs)) {
      return Promise.resolve();
    }
    this.lastRefreshAt = now;
    const client = this.client;
    this.refreshing = (async () => {
      try {
        const state = await client.getState();
        if (!this.disposed && client === this.client) {
          this.succeeded();
          this.apply(state, true);
        }
      } catch (error) {
        if (!this.disposed && client === this.client) {
          this.failed(`Unable to read the status of ${this.name}: ${(error as Error).message}`);
        }
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  /** The status HomeKit should see: last known, with unconfirmed writes on top. */
  private displayed(): FanState {
    return Object.assign({}, DEFAULT_STATE, this.accessory.context.state, ...this.inFlight, this.implied, this.pending);
  }

  private read<T extends CharacteristicValue>(pick: (state: FanState) => T): T {
    // HomeKit is looking (Home app, widget, Siri): answer now from the last
    // known status and refresh in the background. The refresh starts after
    // HAP has sent this answer, so a quick result can't be overwritten by it.
    setTimeout(() => void this.refresh(), 0);
    if (!this.online || !this.accessory.context.state) {
      const { HapStatusError, HAPStatus } = this.deps.api.hap;
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return pick(this.displayed());
  }

  /** Queues a write; resolves once the fan has confirmed it. */
  private write(command: FanCommand, implied: FanCommand = {}): Promise<void> {
    Object.assign(this.pending, command);
    Object.assign(this.implied, implied);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), this.deps.coalesceMs);
    }
    return new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private async flush(): Promise<void> {
    this.flushTimer = undefined;
    const batch: FanCommand = { ...this.implied, ...this.pending };
    const waiters = this.waiters.splice(0);
    this.pending = {};
    this.implied = {};
    this.inFlight.push(batch);
    const client = this.client;
    const { HapStatusError, HAPStatus } = this.deps.api.hap;

    this.deps.log.info(`${this.name}: ${describeCommand(batch)}`);
    try {
      let state: FanState;
      const { lightBrightness, ...rest } = batch;
      if (batch.lightOn === true && lightBrightness !== undefined && !this.accessory.context.state?.lightOn) {
        // Turning the light on and setting its brightness in one request makes
        // it flash at the old brightness first; set the brightness first.
        await client.setState({ lightBrightness });
        state = await client.setState(rest);
      } else {
        state = await client.setState(batch);
      }
      this.inFlight.splice(this.inFlight.indexOf(batch), 1);
      this.succeeded();
      this.apply(state, false);
      waiters.forEach((waiter) => waiter.resolve());
      // HAP stores the written value once the write resolves; push what the
      // fan actually did (e.g. 40 % snaps to speed 2, 33 %) after that.
      setTimeout(() => this.push(), 0);
    } catch (error) {
      this.inFlight.splice(this.inFlight.indexOf(batch), 1);
      const message = (error as Error).message;
      this.deps.log.error(`Failed to update ${this.name} (${describeCommand(batch)}): ${message}`);
      this.failed(message, false);
      waiters.forEach((waiter) => waiter.reject(new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)));
      // Undo what HomeKit was showing optimistically.
      setTimeout(() => this.push(), 0);
    }
  }

  /** Records a status from the fan and pushes it to HomeKit. */
  private apply(state: FanState, fromRefresh: boolean): void {
    const context = this.accessory.context;
    const previous = context.state;
    context.state = state;
    const changed = !previous || (Object.keys(state) as (keyof FanState)[]).some((key) => state[key] !== previous[key]);
    if (fromRefresh && previous && changed && !this.inFlight.length && !this.flushTimer) {
      this.deps.log.info(`${this.name} changed outside Apple Home: ${describeState(state, !!this.lightService)}`);
    }
    this.push();
  }

  private succeeded(): void {
    this.failures = 0;
    if (!this.online) {
      this.online = true;
      this.deps.log.info(`${this.name} is responding again`);
    }
  }

  private failed(message: string, log = true): void {
    this.failures++;
    if (this.online && this.failures >= this.deps.offlineAfterFailures) {
      this.online = false;
      this.deps.log.warn(`${this.name} at ${this.client.host} is not responding; it shows "No Response" until it answers again (${message})`);
      this.push();
      this.deps.onUnreachable?.();
    } else if (log) {
      this.deps.log.debug(message);
    }
  }

  /** Sends the current status (or "No Response") to HomeKit. */
  private push(): void {
    const { Characteristic: C, HapStatusError, HAPStatus } = this.deps.api.hap;
    if (!this.online || !this.accessory.context.state) {
      const error = new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      if (!this.online) {
        this.fanService.updateCharacteristic(C.Active, error);
        this.lightService?.updateCharacteristic(C.On, error);
      }
      return;
    }
    const state = this.displayed();
    this.fanService.updateCharacteristic(C.Active, state.fanOn ? C.Active.ACTIVE : C.Active.INACTIVE);
    this.fanService.updateCharacteristic(C.RotationSpeed, speedToPercent(state.fanSpeed));
    this.fanService.updateCharacteristic(C.RotationDirection, state.fanDirection === 'reverse'
      ? C.RotationDirection.CLOCKWISE
      : C.RotationDirection.COUNTER_CLOCKWISE);
    if (this.lightService) {
      this.lightService.updateCharacteristic(C.On, state.lightOn);
      this.lightService.updateCharacteristic(C.Brightness, state.lightBrightness);
    }
  }

  private ensureService(type: API['hap']['Service']['Fanv2'] | API['hap']['Service']['Lightbulb'], name: string): Service {
    const { Characteristic: C } = this.deps.api.hap;
    const existing = this.accessory.getService(type);
    if (existing) {
      return existing;
    }
    const service = this.accessory.addService(type, name);
    service.setCharacteristic(C.Name, name);
    return service;
  }

  /** Saves the accessory context to Homebridge's cache. */
  private persist(): void {
    this.deps.api.updatePlatformAccessories([this.accessory]);
  }
}
