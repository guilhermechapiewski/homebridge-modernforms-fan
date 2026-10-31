import type { Characteristic, CharacteristicValue, PlatformAccessory } from 'homebridge';
import { HomebridgeAPI } from 'homebridge/lib/api';

import {
  describeCommand,
  describeState,
  FanAccessory,
  FanAccessoryContext,
  formatFirmware,
  percentToSpeed,
  sanitizeName,
  speedToPercent,
} from '../src/fanAccessory';
import { FanCommand, FanState, ModernFormsApiError } from '../src/modernFormsApi';
import { makeInfo, makeLogger, makeState } from './helpers';

describe('helpers', () => {
  it('maps the six fan speeds to HomeKit percentages and back', () => {
    expect([1, 2, 3, 4, 5, 6].map(speedToPercent)).toEqual([17, 33, 50, 67, 83, 100]);
    expect([1, 8, 9, 17, 25, 33, 40, 50, 67, 83, 91, 92, 100].map(percentToSpeed)).toEqual([1, 1, 1, 1, 2, 2, 2, 3, 4, 5, 5, 6, 6]);
    for (const speed of [1, 2, 3, 4, 5, 6]) {
      expect(percentToSpeed(speedToPercent(speed))).toBe(speed);
    }
  });

  it.each([
    ['Living Room Fan', 'Living Room Fan'],
    ['  #Patio Fan!  ', 'Patio Fan'],
    ['***', 'Modern Forms Fan'],
    [undefined, 'Modern Forms Fan'],
  ])('sanitizeName(%p) -> %p', (input, expected) => {
    expect(sanitizeName(input)).toBe(expected);
  });

  it.each([
    ['02.00.0052', '2.0.52'],
    ['1.17', '1.17'],
    ['01.03.0021.5', undefined],
    ['v1', undefined],
    [undefined, undefined],
  ])('formatFirmware(%p) -> %p', (input, expected) => {
    expect(formatFirmware(input)).toBe(expected);
  });

  it('describes states and commands for the log', () => {
    expect(describeState(makeState({ fanOn: true, fanSpeed: 4, lightOn: true, lightBrightness: 40 }), true))
      .toBe('fan on at speed 4 (forward/summer), light on at 40%');
    expect(describeState(makeState({ fanDirection: 'reverse' }), false)).toBe('fan off (reverse/winter)');
    expect(describeCommand({ fanOn: true, fanSpeed: 2, fanDirection: 'forward', lightOn: false, lightBrightness: 10 }))
      .toBe('fan on, speed 2, forward/summer, light off, brightness 10%');
  });
});

describe('FanAccessory', () => {
  const api = new HomebridgeAPI();
  const { Service, Characteristic, HAPStatus } = api.hap;

  let log: ReturnType<typeof makeLogger>;
  let fan: FanState;
  let client: {
    host: string;
    getState: jest.Mock<Promise<FanState>, []>;
    setState: jest.Mock<Promise<FanState>, [FanCommand]>;
  };
  let onUnreachable: jest.Mock;
  let handler: FanAccessory | undefined;

  const makeAccessory = (context: Partial<FanAccessoryContext> = {}) => {
    const accessory = new api.platformAccessory<FanAccessoryContext>('Sunroom Fan', api.hap.uuid.generate(Math.random().toString()));
    Object.assign(accessory.context, { info: makeInfo(), host: '192.0.2.10', state: makeState(), ...context });
    return accessory;
  };

  const build = (accessory: PlatformAccessory<FanAccessoryContext> = makeAccessory(), pollingIntervalMs = 0) => {
    handler = new FanAccessory({
      api, log, client, pollingIntervalMs, refreshMinIntervalMs: 5_000, coalesceMs: 50, offlineAfterFailures: 2, onUnreachable,
    }, accessory);
    const fanService = accessory.getService(Service.Fanv2)!;
    const lightService = accessory.getService(Service.Lightbulb);
    return {
      handler,
      accessory,
      active: fanService.getCharacteristic(Characteristic.Active),
      speed: fanService.getCharacteristic(Characteristic.RotationSpeed),
      direction: fanService.getCharacteristic(Characteristic.RotationDirection),
      // Only undefined for fans without a light kit, which these tests check separately.
      lightOn: lightService?.getCharacteristic(Characteristic.On) as Characteristic,
      brightness: lightService?.getCharacteristic(Characteristic.Brightness) as Characteristic,
    };
  };

  /** Writes like HomeKit does (several characteristics in one go) and lets the batch go out. */
  const write = async (...writes: [Characteristic, CharacteristicValue][]) => {
    const results = writes.map(([characteristic, value]) => characteristic.handleSetRequest(value).then(() => undefined, (e) => e));
    await jest.advanceTimersByTimeAsync(100);
    return Promise.all(results);
  };

  beforeEach(() => {
    jest.useFakeTimers();
    log = makeLogger();
    fan = makeState();
    client = {
      host: '192.0.2.10',
      getState: jest.fn(async () => ({ ...fan })),
      setState: jest.fn(async (command: FanCommand) => {
        fan = { ...fan, ...command };
        return { ...fan };
      }),
    };
    onUnreachable = jest.fn();
    handler = undefined;
  });

  afterEach(() => {
    handler?.dispose();
    jest.useRealTimers();
  });

  describe('setup', () => {
    it('exposes a Fanv2 and a Lightbulb with the fan details', () => {
      const { accessory } = build(makeAccessory({ state: makeState({ fanOn: true, fanSpeed: 2, lightOn: true, lightBrightness: 40 }) }));
      const info = accessory.getService(Service.AccessoryInformation)!;
      expect(info.getCharacteristic(Characteristic.Manufacturer).value).toBe('Modern Forms');
      expect(info.getCharacteristic(Characteristic.Model).value).toBe('1801-60');
      expect(info.getCharacteristic(Characteristic.SerialNumber).value).toBe('02:00:00:00:00:01');
      expect(info.getCharacteristic(Characteristic.FirmwareRevision).value).toBe('2.0.52');

      const fanService = accessory.getService(Service.Fanv2)!;
      expect(fanService.isPrimaryService).toBe(true);
      expect(fanService.getCharacteristic(Characteristic.Name).value).toBe('Sunroom Fan');
      expect(fanService.getCharacteristic(Characteristic.Active).value).toBe(1);
      expect(fanService.getCharacteristic(Characteristic.RotationSpeed).value).toBe(33);
      expect(fanService.getCharacteristic(Characteristic.RotationDirection).value).toBe(Characteristic.RotationDirection.COUNTER_CLOCKWISE);
      const light = accessory.getService(Service.Lightbulb)!;
      expect(light.getCharacteristic(Characteristic.Name).value).toBe('Sunroom Fan Light');
      expect(light.getCharacteristic(Characteristic.On).value).toBe(true);
      expect(light.getCharacteristic(Characteristic.Brightness).value).toBe(40);
    });

    it('names WAC fans after WAC', () => {
      const { accessory } = build(makeAccessory({ info: makeInfo({ clientId: 'WAC_020000000003' }) }));
      expect(accessory.getService(Service.AccessoryInformation)!.getCharacteristic(Characteristic.Manufacturer).value).toBe('WAC Lighting');
    });

    it('has no Lightbulb for a fan without a light kit, and drops a cached one', () => {
      const accessory = makeAccessory();
      accessory.addService(Service.Lightbulb, 'old');
      accessory.context.info = makeInfo({ lightType: '' });
      build(accessory);
      expect(accessory.getService(Service.Lightbulb)).toBeUndefined();
    });

    it('reuses cached services instead of duplicating them', () => {
      const accessory = makeAccessory();
      build(accessory).handler.dispose();
      build(accessory);
      expect(accessory.services.filter((s) => s.UUID === Service.Fanv2.UUID)).toHaveLength(1);
      expect(accessory.services.filter((s) => s.UUID === Service.Lightbulb.UUID)).toHaveLength(1);
    });
  });

  describe('reads', () => {
    it('answers from the last known state and refreshes in the background, throttled', async () => {
      const { active, speed } = build();
      fan = makeState({ fanOn: true, fanSpeed: 6 });
      await expect(active.handleGetRequest()).resolves.toBe(0);
      expect(client.getState).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(0);
      expect(client.getState).toHaveBeenCalledTimes(1);
      // The fresh status lands after HAP has answered, so it sticks.
      expect(active.value).toBe(1);
      expect(speed.value).toBe(100);
      expect(log.info).toHaveBeenCalledWith('Sunroom Fan changed outside Apple Home: fan on at speed 6 (forward/summer), light off');

      await speed.handleGetRequest();
      await jest.advanceTimersByTimeAsync(0);
      expect(client.getState).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(5_000);
      await speed.handleGetRequest();
      await jest.advanceTimersByTimeAsync(0);
      expect(client.getState).toHaveBeenCalledTimes(2);
    });

    it('maps reverse to clockwise', async () => {
      const { direction } = build(makeAccessory({ state: makeState({ fanDirection: 'reverse' }) }));
      await expect(direction.handleGetRequest()).resolves.toBe(Characteristic.RotationDirection.CLOCKWISE);
    });

    it('polls in the background when configured', async () => {
      build(makeAccessory(), 60_000);
      await jest.advanceTimersByTimeAsync(59_999);
      expect(client.getState).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(client.getState).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(client.getState).toHaveBeenCalledTimes(2);
    });

    it('shows "No Response" before the first status is known', async () => {
      const { active } = build(makeAccessory({ state: undefined }));
      client.getState.mockReturnValue(new Promise(() => undefined));
      await expect(active.handleGetRequest()).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    });
  });

  describe('writes', () => {
    it('turns the fan on and off', async () => {
      const { active } = build();
      await write([active, 1]);
      expect(client.setState).toHaveBeenLastCalledWith({ fanOn: true });
      await write([active, 0]);
      expect(client.setState).toHaveBeenLastCalledWith({ fanOn: false });
      expect(log.info).toHaveBeenCalledWith('Sunroom Fan: fan on');
    });

    it('sets the speed, turning the fan on, and snaps HomeKit to the real speed', async () => {
      const { speed, active } = build();
      await write([speed, 40]);
      expect(client.setState).toHaveBeenCalledWith({ fanOn: true, fanSpeed: 2 });
      expect(speed.value).toBe(33);
      expect(active.value).toBe(1);
    });

    it('lets an explicit off win over the speed in the same write (scenes)', async () => {
      const { speed, active } = build(makeAccessory({ state: makeState({ fanOn: true }) }));
      await write([active, 0], [speed, 67]);
      expect(client.setState).toHaveBeenCalledTimes(1);
      expect(client.setState).toHaveBeenCalledWith({ fanOn: false, fanSpeed: 4 });
    });

    it('turns the fan off at 0 %', async () => {
      const { speed } = build(makeAccessory({ state: makeState({ fanOn: true }) }));
      await write([speed, 0]);
      expect(client.setState).toHaveBeenCalledWith({ fanOn: false });
    });

    it('sets the direction', async () => {
      const { direction } = build();
      await write([direction, Characteristic.RotationDirection.CLOCKWISE]);
      expect(client.setState).toHaveBeenLastCalledWith({ fanDirection: 'reverse' });
      await write([direction, Characteristic.RotationDirection.COUNTER_CLOCKWISE]);
      expect(client.setState).toHaveBeenLastCalledWith({ fanDirection: 'forward' });
    });

    it('sets the brightness before turning a dark light on, so it does not flash at the old level', async () => {
      const { lightOn, brightness } = build();
      await write([lightOn, true], [brightness, 30]);
      expect(client.setState.mock.calls).toEqual([[{ lightBrightness: 30 }], [{ lightOn: true }]]);
      expect(brightness.value).toBe(30);
    });

    it('turns a dark light on with a brightness-only write, in the same order', async () => {
      const { brightness } = build();
      await write([brightness, 70]);
      expect(client.setState.mock.calls).toEqual([[{ lightBrightness: 70 }], [{ lightOn: true }]]);
    });

    it('dims a lit light with one request', async () => {
      const { brightness } = build(makeAccessory({ state: makeState({ lightOn: true }) }));
      await write([brightness, 20]);
      expect(client.setState.mock.calls).toEqual([[{ lightOn: true, lightBrightness: 20 }]]);
    });

    it('turns the light off at 0 % and with On=false', async () => {
      const { lightOn, brightness } = build(makeAccessory({ state: makeState({ lightOn: true }) }));
      await write([brightness, 0]);
      expect(client.setState).toHaveBeenLastCalledWith({ lightOn: false });
      await write([lightOn, false]);
      expect(client.setState).toHaveBeenLastCalledWith({ lightOn: false });
    });

    it('merges writes to the fan and the light into one request', async () => {
      const { active, lightOn } = build();
      await write([active, 1], [lightOn, true]);
      expect(client.setState.mock.calls).toEqual([[{ fanOn: true, lightOn: true }]]);
    });

    it('keeps showing a write while it is in flight, even if a stale refresh lands', async () => {
      const { active } = build();
      let finish!: (state: FanState) => void;
      client.setState.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
      const pending = active.handleSetRequest(1);
      await jest.advanceTimersByTimeAsync(100);
      // A refresh answered by the fan before it processed the command.
      await handler!.refresh(true);
      expect(active.value).toBe(1);
      await expect(active.handleGetRequest()).resolves.toBe(1);
      expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('changed outside Apple Home'));
      finish(makeState({ fanOn: true }));
      await pending;
      await jest.advanceTimersByTimeAsync(0);
      expect(active.value).toBe(1);
    });

    it('fails the write and reverts HomeKit when the fan does not answer', async () => {
      const { active } = build();
      client.setState.mockRejectedValueOnce(new ModernFormsApiError('No answer within 4000ms', undefined, true));
      const [error] = await write([active, 1]);
      expect(error).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      expect(log.error).toHaveBeenCalledWith('Failed to update Sunroom Fan (fan on): No answer within 4000ms');
      expect(active.value).toBe(0);
    });
  });

  describe('reachability', () => {
    it('shows "No Response" after two failures in a row, asks for rediscovery, and recovers', async () => {
      const { active, lightOn } = build();
      client.getState.mockRejectedValue(new ModernFormsApiError('Network error: connect ECONNREFUSED', undefined, true));
      await handler!.refresh(true);
      await expect(active.handleGetRequest()).resolves.toBe(0);
      expect(handler!.isOnline).toBe(true);

      await handler!.refresh(true);
      expect(handler!.isOnline).toBe(false);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Sunroom Fan at 192.0.2.10 is not responding'));
      expect(onUnreachable).toHaveBeenCalledTimes(1);
      await expect(active.handleGetRequest()).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      await expect(lightOn.handleGetRequest()).rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);

      await handler!.refresh(true);
      expect(onUnreachable).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledTimes(1);

      client.getState.mockImplementation(async () => makeState({ fanOn: true }));
      await handler!.refresh(true);
      expect(handler!.isOnline).toBe(true);
      expect(log.info).toHaveBeenCalledWith('Sunroom Fan is responding again');
      await expect(active.handleGetRequest()).resolves.toBe(1);
    });

    it('switches to a new address and refreshes from it', async () => {
      const { accessory } = build();
      const updated = jest.spyOn(api, 'updatePlatformAccessories').mockImplementation(() => undefined);
      const moved = { ...client, host: '192.0.2.99', getState: jest.fn(async () => makeState({ lightOn: true })) };
      handler!.setClient(moved);
      await jest.advanceTimersByTimeAsync(0);
      expect(handler!.host).toBe('192.0.2.99');
      expect(accessory.context.host).toBe('192.0.2.99');
      expect(updated).toHaveBeenCalledWith([accessory]);
      expect(moved.getState).toHaveBeenCalled();
      expect(accessory.context.state?.lightOn).toBe(true);
      updated.mockRestore();
    });

    it('ignores the result of a refresh from the old address', async () => {
      const { accessory } = build();
      let finish!: (state: FanState) => void;
      client.getState.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
      void handler!.refresh(true);
      const updated = jest.spyOn(api, 'updatePlatformAccessories').mockImplementation(() => undefined);
      handler!.setClient({ ...client, host: '192.0.2.99', getState: jest.fn(() => new Promise<FanState>(() => undefined)) });
      finish(makeState({ fanOn: true }));
      await jest.advanceTimersByTimeAsync(0);
      expect(accessory.context.state?.fanOn).toBe(false);
      updated.mockRestore();
    });

    it('fails pending writes when disposed', async () => {
      const { active } = build();
      const result = active.handleSetRequest(1).catch((e) => e);
      handler!.dispose();
      await expect(result).resolves.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      await jest.advanceTimersByTimeAsync(100);
      expect(client.setState).not.toHaveBeenCalled();
    });
  });
});
