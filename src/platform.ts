import type { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';

import { DiscoveredFan, discoverFans } from './discovery';
import { FanAccessory, FanAccessoryContext, sanitizeName } from './fanAccessory';
import { FanInfo, FanState, ModernFormsClient, parseHost } from './modernFormsApi';
import {
  COMMAND_COALESCE_MS,
  DEFAULT_POLLING_INTERVAL_SECONDS,
  DISCOVERY_INTERVAL_MS,
  DISCOVERY_LISTEN_MS,
  MIN_POLLING_INTERVAL_SECONDS,
  OFFLINE_AFTER_FAILURES,
  ON_DEMAND_REFRESH_MIN_INTERVAL_MS,
  PLATFORM_NAME,
  PLUGIN_NAME,
  REDISCOVERY_MIN_INTERVAL_MS,
} from './settings';

export interface ModernFormsPlatformConfig {
  /** Fans to add by address, in addition to (or instead of) discovery. */
  hosts: string[];
  /** Find fans automatically with mDNS. */
  discovery: boolean;
  /** Background status check per fan; 0 means only when HomeKit reads it. */
  pollingIntervalSeconds: number;
}

/** Timing knobs, overridable in tests. */
export interface PlatformTiming {
  discoveryIntervalMs: number;
  discoveryListenMs: number;
  rediscoveryMinIntervalMs: number;
  refreshMinIntervalMs: number;
  coalesceMs: number;
  offlineAfterFailures: number;
}

export type PlatformClient = Pick<ModernFormsClient, 'host' | 'getInfo' | 'getState' | 'setState'>;

export interface PlatformDeps {
  createClient?: (host: string) => PlatformClient;
  discover?: (listenMs: number) => Promise<DiscoveredFan[]>;
  timing?: Partial<PlatformTiming>;
}

/** Validates the raw Homebridge config, returning a list of problems if invalid. */
export function parseConfig(config: PlatformConfig): ModernFormsPlatformConfig | string[] {
  const errors: string[] = [];

  const hosts: string[] = [];
  if (Array.isArray(config.hosts)) {
    for (const entry of config.hosts) {
      if (typeof entry !== 'string') {
        errors.push('"hosts" must be a list of IP addresses or host names');
        continue;
      }
      if (!entry.trim()) {
        continue;
      }
      try {
        parseHost(entry);
        if (!hosts.includes(entry.trim())) {
          hosts.push(entry.trim());
        }
      } catch (error) {
        errors.push((error as Error).message);
      }
    }
  } else if (config.hosts !== undefined && config.hosts !== null && config.hosts !== '') {
    errors.push('"hosts" must be a list of IP addresses or host names');
  }

  let discovery = true;
  if (config.discovery !== undefined && config.discovery !== null) {
    if (typeof config.discovery === 'boolean') {
      discovery = config.discovery;
    } else {
      errors.push('"discovery" must be true or false');
    }
  }
  if (!discovery && !hosts.length && !errors.length) {
    errors.push('add the fans\' addresses to "hosts" when "discovery" is off');
  }

  let pollingIntervalSeconds = DEFAULT_POLLING_INTERVAL_SECONDS;
  if (config.pollingIntervalSeconds !== undefined && config.pollingIntervalSeconds !== null && config.pollingIntervalSeconds !== '') {
    const parsed = Number(config.pollingIntervalSeconds);
    if (!Number.isFinite(parsed) || parsed < 0) {
      errors.push('"pollingIntervalSeconds" must be 0 (off) or a number of seconds');
    } else {
      pollingIntervalSeconds = parsed === 0 ? 0 : Math.max(parsed, MIN_POLLING_INTERVAL_SECONDS);
    }
  }

  return errors.length ? errors : { hosts, discovery, pollingIntervalSeconds };
}

/** "02:00:00:0a:bc:01" -> "0200000ABC01"; undefined unless it's a full MAC address. */
export function normalizeMac(mac: string | undefined): string | undefined {
  const hex = (mac ?? '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  return hex.length === 12 ? hex : undefined;
}

/**
 * Finds fans (mDNS discovery and/or configured addresses), keeps one
 * accessory per fan, and follows fans whose IP address changes. Fans are
 * identified by MAC address, so a new IP never creates a duplicate.
 *
 * Accessories are never removed automatically: a fan that's powered off at
 * the wall, or whose web server is stuck, just shows "No Response".
 */
export class ModernFormsPlatform implements DynamicPlatformPlugin {
  /** Accessories restored from the Homebridge cache or added since, keyed by UUID. */
  private readonly accessories = new Map<string, PlatformAccessory<FanAccessoryContext>>();
  /** Active handlers, keyed by UUID. */
  private readonly handlers = new Map<string, FanAccessory>();
  private readonly settings?: ModernFormsPlatformConfig;
  private readonly timing: PlatformTiming;
  private readonly createClient: (host: string) => PlatformClient;
  private readonly discover: (listenMs: number) => Promise<DiscoveredFan[]>;
  private scanTimer?: NodeJS.Timeout;
  private rediscoverTimer?: NodeJS.Timeout;
  private scanning?: Promise<void>;
  private lastScanAt = 0;
  private stopped = false;
  private lastDiscoveryError?: string;
  /** Hosts of unknown fans that failed to answer, so each outage is logged once. */
  private readonly failingHosts = new Set<string>();

  constructor(
    readonly log: Logger,
    config: PlatformConfig,
    readonly api: API,
    deps: PlatformDeps = {},
  ) {
    this.timing = {
      discoveryIntervalMs: DISCOVERY_INTERVAL_MS,
      discoveryListenMs: DISCOVERY_LISTEN_MS,
      rediscoveryMinIntervalMs: REDISCOVERY_MIN_INTERVAL_MS,
      refreshMinIntervalMs: ON_DEMAND_REFRESH_MIN_INTERVAL_MS,
      coalesceMs: COMMAND_COALESCE_MS,
      offlineAfterFailures: OFFLINE_AFTER_FAILURES,
      ...deps.timing,
    };
    this.createClient = deps.createClient ?? ((host) => new ModernFormsClient({ host, debug: (message) => log.debug(message) }));
    this.discover = deps.discover ?? ((listenMs) => discoverFans({ listenMs }));

    const parsed = parseConfig(config);
    if (Array.isArray(parsed)) {
      this.log.error(`Invalid configuration, plugin disabled: ${parsed.join('; ')}`);
      return;
    }
    this.settings = parsed;
    const requested = Number(config.pollingIntervalSeconds);
    if (requested > 0 && requested < MIN_POLLING_INTERVAL_SECONDS) {
      this.log.warn(`pollingIntervalSeconds ${requested} is below the minimum; using ${MIN_POLLING_INTERVAL_SECONDS}`);
    }

    this.api.on('didFinishLaunching', () => this.start());
    this.api.on('shutdown', () => this.stop());
  }

  /** Called by Homebridge for each accessory restored from its cache. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug(`Restoring cached accessory: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory as PlatformAccessory<FanAccessoryContext>);
  }

  start(): void {
    if (!this.settings || this.stopped) {
      return;
    }
    const broken: PlatformAccessory[] = [];
    for (const accessory of this.accessories.values()) {
      const { info, host } = accessory.context;
      if (!info?.clientId || typeof host !== 'string' || !host) {
        broken.push(accessory);
        continue;
      }
      this.log.info(`Restored ${accessory.displayName} (${host})`);
      const handler = this.createHandler(accessory, this.createClient(host));
      this.handlers.set(accessory.UUID, handler);
      void handler.refresh(true);
    }
    if (broken.length) {
      for (const accessory of broken) {
        this.accessories.delete(accessory.UUID);
      }
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, broken);
    }

    void this.scan();
    this.scanTimer = setInterval(() => void this.scan(), this.timing.discoveryIntervalMs);
    this.scanTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = undefined;
    }
    if (this.rediscoverTimer) {
      clearTimeout(this.rediscoverTimer);
      this.rediscoverTimer = undefined;
    }
    for (const handler of this.handlers.values()) {
      handler.dispose();
    }
  }

  /**
   * Looks for fans: runs discovery (if on) and probes configured hosts that
   * aren't known yet. Coalesced with a scan already running.
   */
  scan(): Promise<void> {
    if (this.scanning) {
      return this.scanning;
    }
    this.lastScanAt = Date.now();
    this.scanning = this.runScan().finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
  }

  private async runScan(): Promise<void> {
    const settings = this.settings!;
    const candidates = new Map<string, DiscoveredFan | undefined>();
    if (settings.discovery) {
      try {
        const found = await this.discover(this.timing.discoveryListenMs);
        this.log.debug(`Discovery found ${found.length} fan(s): ${found.map((f) => `${f.name} at ${f.address}`).join(', ') || 'none'}`);
        for (const fan of found) {
          candidates.set(fan.port === 80 ? fan.address : `${fan.address}:${fan.port}`, fan);
        }
        if (this.lastDiscoveryError) {
          this.log.info('Fan discovery is working again');
          this.lastDiscoveryError = undefined;
        }
      } catch (error) {
        const message = (error as Error).message;
        if (message !== this.lastDiscoveryError) {
          this.log.warn(`Fan discovery failed (add the fans' IP addresses under "hosts" if this persists): ${message}`);
          this.lastDiscoveryError = message;
        }
      }
    }
    for (const host of settings.hosts) {
      if (!candidates.has(host)) {
        candidates.set(host, undefined);
      }
    }

    for (const [host, discovered] of candidates) {
      if (this.stopped) {
        return;
      }
      await this.consider(host, discovered);
    }
  }

  /** Adds the fan at `host`, or points a known fan at it if it moved. */
  private async consider(host: string, discovered: DiscoveredFan | undefined): Promise<void> {
    const mac = normalizeMac(discovered?.mac);
    if (mac) {
      const handler = this.handlers.get(this.uuidFor(mac));
      if (handler) {
        this.follow(handler, host);
        return;
      }
    }
    if ([...this.handlers.values()].some((handler) => handler.host === host)) {
      return;
    }

    const client = this.createClient(host);
    let info: FanInfo;
    let state: FanState | undefined;
    try {
      info = await client.getInfo();
      state = await client.getState().catch(() => undefined);
    } catch (error) {
      const message = `Unable to reach the fan at ${host}: ${(error as Error).message}`;
      if (this.failingHosts.has(host)) {
        this.log.debug(message);
      } else {
        this.failingHosts.add(host);
        this.log.warn(`${message} (will keep trying)`);
      }
      return;
    }
    if (this.failingHosts.delete(host)) {
      this.log.info(`The fan at ${host} is reachable again`);
    }
    if (this.stopped) {
      return;
    }

    const uuid = this.uuidFor(normalizeMac(info.mac) ?? info.clientId);
    const existing = this.handlers.get(uuid);
    if (existing) {
      // The same fan under another address (e.g. a host name and its IP).
      this.follow(existing, host, client);
      return;
    }

    const name = sanitizeName(info.deviceName || discovered?.name);
    this.log.info(`Adding ${name} (${host})`);
    const accessory = new this.api.platformAccessory<FanAccessoryContext>(name, uuid, this.api.hap.Categories.FAN);
    accessory.context.info = info;
    accessory.context.host = host;
    accessory.context.state = state;
    this.accessories.set(uuid, accessory);
    this.handlers.set(uuid, this.createHandler(accessory, client));
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
  }

  /**
   * Moves a known fan to `host` when its address changed. A configured
   * address is only abandoned while it isn't answering.
   */
  private follow(handler: FanAccessory, host: string, client?: PlatformClient): void {
    if (handler.host === host) {
      return;
    }
    if (handler.isOnline && this.settings!.hosts.includes(handler.host)) {
      return;
    }
    this.log.info(`${handler.name} is now at ${host} (was ${handler.host})`);
    handler.setClient(client ?? this.createClient(host));
  }

  /**
   * A fan stopped answering; its IP may have changed, so look again now, or
   * as soon as the last scan is old enough.
   */
  private rediscover(): void {
    if (this.stopped || this.rediscoverTimer) {
      return;
    }
    const wait = this.lastScanAt + this.timing.rediscoveryMinIntervalMs - Date.now();
    if (wait <= 0) {
      void this.scan();
      return;
    }
    this.rediscoverTimer = setTimeout(() => {
      this.rediscoverTimer = undefined;
      void this.scan();
    }, wait);
    this.rediscoverTimer.unref?.();
  }

  private uuidFor(id: string): string {
    return this.api.hap.uuid.generate(`modernforms:${id}`);
  }

  private createHandler(accessory: PlatformAccessory<FanAccessoryContext>, client: PlatformClient): FanAccessory {
    return new FanAccessory({
      api: this.api,
      log: this.log,
      client,
      pollingIntervalMs: this.settings!.pollingIntervalSeconds * 1000,
      refreshMinIntervalMs: this.timing.refreshMinIntervalMs,
      coalesceMs: this.timing.coalesceMs,
      offlineAfterFailures: this.timing.offlineAfterFailures,
      onUnreachable: () => this.rediscover(),
    }, accessory);
  }
}
