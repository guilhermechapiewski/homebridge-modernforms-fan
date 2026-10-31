import type { PlatformAccessory, PlatformConfig } from 'homebridge';
import { HomebridgeAPI } from 'homebridge/lib/api';

import type { DiscoveredFan } from '../src/discovery';
import type { FanAccessoryContext } from '../src/fanAccessory';
import { FanCommand, FanInfo, FanState, ModernFormsApiError } from '../src/modernFormsApi';
import { ModernFormsPlatform, normalizeMac, parseConfig } from '../src/platform';
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings';
import { makeInfo, makeLogger, makeState } from './helpers';

const baseConfig: PlatformConfig = { platform: PLATFORM_NAME };

describe('parseConfig', () => {
  it('applies defaults (discovery on, 60 s checks)', () => {
    expect(parseConfig(baseConfig)).toEqual({ hosts: [], discovery: true, pollingIntervalSeconds: 60 });
  });

  it('accepts hosts, trimming and de-duplicating them', () => {
    expect(parseConfig({ ...baseConfig, hosts: [' 192.0.2.10 ', '', 'fan.local:8080', '192.0.2.10'], discovery: false }))
      .toEqual({ hosts: ['192.0.2.10', 'fan.local:8080'], discovery: false, pollingIntervalSeconds: 60 });
  });

  it('allows 0 (background checks off) and raises short intervals to the 10 s minimum', () => {
    expect(parseConfig({ ...baseConfig, pollingIntervalSeconds: 0 })).toMatchObject({ pollingIntervalSeconds: 0 });
    expect(parseConfig({ ...baseConfig, pollingIntervalSeconds: '5' })).toMatchObject({ pollingIntervalSeconds: 10 });
    expect(parseConfig({ ...baseConfig, pollingIntervalSeconds: '' })).toMatchObject({ pollingIntervalSeconds: 60 });
  });

  it('needs hosts when discovery is off', () => {
    expect(parseConfig({ ...baseConfig, discovery: false })).toEqual(['add the fans\' addresses to "hosts" when "discovery" is off']);
  });

  it('reports every problem at once', () => {
    expect(parseConfig({ ...baseConfig, hosts: ['http://192.0.2.10', 7], discovery: 'yes', pollingIntervalSeconds: -1 })).toEqual([
      '"http://192.0.2.10" is not a valid host (use an IP address or host name, optionally with :port)',
      '"hosts" must be a list of IP addresses or host names',
      '"discovery" must be true or false',
      '"pollingIntervalSeconds" must be 0 (off) or a number of seconds',
    ]);
    expect(parseConfig({ ...baseConfig, hosts: '192.0.2.10' })).toEqual(['"hosts" must be a list of IP addresses or host names']);
  });
});

describe('normalizeMac', () => {
  it.each([
    ['02:00:00:0a:bc:01', '0200000ABC01'],
    ['0200000ABC01', '0200000ABC01'],
    ['02:00', undefined],
    [undefined, undefined],
  ])('%p -> %p', (input, expected) => {
    expect(normalizeMac(input)).toBe(expected);
  });
});

/** A fake fan reachable at `host`. */
interface FakeFan {
  info: FanInfo;
  state: FanState;
  reachable: boolean;
}

describe('ModernFormsPlatform', () => {
  let api: HomebridgeAPI;
  let log: ReturnType<typeof makeLogger>;
  let fans: Map<string, FakeFan>;
  let discovered: DiscoveredFan[];
  let discover: jest.Mock<Promise<DiscoveredFan[]>, [number]>;
  let clientsCreated: string[];
  let registered: PlatformAccessory<FanAccessoryContext>[];
  let unregistered: PlatformAccessory[];
  let platform: ModernFormsPlatform | undefined;

  const unreachable = () => new ModernFormsApiError('Network error: connect EHOSTUNREACH', undefined, true);

  const createClient = (host: string) => {
    clientsCreated.push(host);
    const fan = () => {
      const found = fans.get(host);
      if (!found?.reachable) {
        throw unreachable();
      }
      return found;
    };
    return {
      host,
      getInfo: jest.fn(async () => ({ ...fan().info })),
      getState: jest.fn(async () => ({ ...fan().state })),
      setState: jest.fn(async (command: FanCommand) => {
        const target = fan();
        target.state = { ...target.state, ...command };
        return { ...target.state };
      }),
    };
  };

  const addFan = (host: string, mac: string, name: string, state: Partial<FanState> = {}) => {
    fans.set(host, { info: makeInfo({ clientId: `MF_${mac.replace(/:/g, '')}`, mac, deviceName: name }), state: makeState(state), reachable: true });
  };

  const ad = (address: string, mac: string): DiscoveredFan => ({ name: `MF_Fan_${mac.slice(-8).replace(/:/g, '')}`, address, port: 80, mac });

  const launch = async (config: Partial<PlatformConfig> = {}, cached: PlatformAccessory[] = []) => {
    platform = new ModernFormsPlatform(log, { ...baseConfig, ...config } as PlatformConfig, api, {
      createClient,
      discover,
      timing: { discoveryIntervalMs: 300_000, discoveryListenMs: 10, rediscoveryMinIntervalMs: 60_000, coalesceMs: 10 },
    });
    for (const accessory of cached) {
      platform.configureAccessory(accessory);
    }
    api.signalFinished();
    await jest.advanceTimersByTimeAsync(0);
    return platform;
  };

  const cachedAccessory = (host: string, mac: string, name: string) => {
    const accessory = new api.platformAccessory<FanAccessoryContext>(name, api.hap.uuid.generate(`modernforms:${mac.replace(/:/g, '')}`));
    accessory.context.info = makeInfo({ clientId: `MF_${mac.replace(/:/g, '')}`, mac, deviceName: name });
    accessory.context.host = host;
    accessory.context.state = makeState();
    return accessory;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    api = new HomebridgeAPI();
    log = makeLogger();
    fans = new Map();
    discovered = [];
    discover = jest.fn(async (_listenMs: number) => discovered);
    clientsCreated = [];
    registered = [];
    unregistered = [];
    jest.spyOn(api, 'registerPlatformAccessories').mockImplementation((_plugin, _platform, accessories) => {
      registered.push(...(accessories as PlatformAccessory<FanAccessoryContext>[]));
    });
    jest.spyOn(api, 'unregisterPlatformAccessories').mockImplementation((_plugin, _platform, accessories) => {
      unregistered.push(...accessories);
    });
    jest.spyOn(api, 'updatePlatformAccessories').mockImplementation(() => undefined);
    platform = undefined;
  });

  afterEach(() => {
    platform?.stop();
    jest.useRealTimers();
  });

  it('adds every discovered fan, named as in the Modern Forms app', async () => {
    addFan('192.0.2.10', '02:00:00:00:00:01', 'Living Room Fan', { fanOn: true, fanSpeed: 4 });
    addFan('192.0.2.11', '02:00:00:00:00:02', 'Patio Fan');
    discovered = [ad('192.0.2.10', '02:00:00:00:00:01'), ad('192.0.2.11', '02:00:00:00:00:02')];
    await launch();

    expect(discover).toHaveBeenCalledWith(10);
    expect(registered.map((a) => [a.displayName, a.context.host])).toEqual([['Living Room Fan', '192.0.2.10'], ['Patio Fan', '192.0.2.11']]);
    expect(api.registerPlatformAccessories).toHaveBeenCalledWith(PLUGIN_NAME, PLATFORM_NAME, expect.any(Array));
    expect(registered[0].category).toBe(api.hap.Categories.FAN);
    expect(registered[0].UUID).toBe(api.hap.uuid.generate('modernforms:020000000001'));
    expect(registered[0].context.state).toMatchObject({ fanOn: true, fanSpeed: 4 });
    expect(log.info).toHaveBeenCalledWith('Adding Living Room Fan (192.0.2.10)');
  });

  it('includes a non-default port in the host', async () => {
    addFan('192.0.2.10:8080', '02:00:00:00:00:01', 'Living Room Fan');
    discovered = [{ ...ad('192.0.2.10', '02:00:00:00:00:01'), port: 8080 }];
    await launch();
    expect(registered[0].context.host).toBe('192.0.2.10:8080');
  });

  it('adds configured hosts with discovery off', async () => {
    addFan('192.0.2.10', '02:00:00:00:00:01', 'Living Room Fan');
    await launch({ discovery: false, hosts: ['192.0.2.10'] });
    expect(discover).not.toHaveBeenCalled();
    expect(registered.map((a) => a.displayName)).toEqual(['Living Room Fan']);
  });

  it('does not duplicate a fan that is both configured and discovered', async () => {
    addFan('192.0.2.10', '02:00:00:00:00:01', 'Living Room Fan');
    addFan('fan.local', '02:00:00:00:00:01', 'Living Room Fan');
    discovered = [ad('192.0.2.10', '02:00:00:00:00:01')];
    await launch({ hosts: ['fan.local', '192.0.2.10'] });
    expect(registered).toHaveLength(1);
  });

  it('logs an unreachable fan once per outage and adds it once it answers', async () => {
    addFan('192.0.2.10', '02:00:00:00:00:01', 'Living Room Fan');
    fans.get('192.0.2.10')!.reachable = false;
    await launch({ discovery: false, hosts: ['192.0.2.10'] });
    expect(log.warn).toHaveBeenCalledWith('Unable to reach the fan at 192.0.2.10: Network error: connect EHOSTUNREACH (will keep trying)');

    await jest.advanceTimersByTimeAsync(300_000);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(registered).toHaveLength(0);

    fans.get('192.0.2.10')!.reachable = true;
    await jest.advanceTimersByTimeAsync(300_000);
    expect(log.info).toHaveBeenCalledWith('The fan at 192.0.2.10 is reachable again');
    expect(registered).toHaveLength(1);
  });

  it('restores cached fans right away and keeps them when discovery misses them', async () => {
    addFan('192.0.2.10', '02:00:00:00:00:01', 'Living Room Fan', { lightOn: true });
    const cached = cachedAccessory('192.0.2.10', '02:00:00:00:00:01', 'Living Room Fan');
    await launch({}, [cached]);
    expect(log.info).toHaveBeenCalledWith('Restored Living Room Fan (192.0.2.10)');
    expect(cached.context.state?.lightOn).toBe(true);
    expect(registered).toHaveLength(0);
    expect(unregistered).toHaveLength(0);
    expect(cached.getService(api.hap.Service.Fanv2)).toBeDefined();
  });

  it('drops cached accessories it cannot use', async () => {
    const broken = new api.platformAccessory<FanAccessoryContext>('Old', api.hap.uuid.generate('old'));
    await launch({}, [broken]);
    expect(unregistered).toEqual([broken]);
  });

  it('follows a fan to its new IP address by MAC, without probing it', async () => {
    const cached = cachedAccessory('192.0.2.10', '02:00:00:00:00:01', 'Living Room Fan');
    addFan('192.0.2.20', '02:00:00:00:00:01', 'Living Room Fan', { fanOn: true });
    discovered = [ad('192.0.2.20', '02:00:00:00:00:01')];
    await launch({}, [cached]);
    expect(log.info).toHaveBeenCalledWith('Living Room Fan is now at 192.0.2.20 (was 192.0.2.10)');
    expect(cached.context.host).toBe('192.0.2.20');
    expect(cached.context.state?.fanOn).toBe(true);
    expect(registered).toHaveLength(0);
  });

  it('keeps a configured address while the fan answers there', async () => {
    addFan('fan.local', '02:00:00:00:00:01', 'Living Room Fan');
    addFan('192.0.2.10', '02:00:00:00:00:01', 'Living Room Fan');
    const cached = cachedAccessory('fan.local', '02:00:00:00:00:01', 'Living Room Fan');
    discovered = [ad('192.0.2.10', '02:00:00:00:00:01')];
    await launch({ hosts: ['fan.local'] }, [cached]);
    expect(cached.context.host).toBe('fan.local');
  });

  it('looks for a fan again when it stops answering (its IP may have changed)', async () => {
    addFan('192.0.2.10', '02:00:00:00:00:01', 'Living Room Fan');
    discovered = [ad('192.0.2.10', '02:00:00:00:00:01')];
    await launch({ pollingIntervalSeconds: 10 });
    expect(discover).toHaveBeenCalledTimes(1);

    // The router hands the fan a new address.
    fans.set('192.0.2.30', fans.get('192.0.2.10')!);
    fans.delete('192.0.2.10');
    discovered = [ad('192.0.2.30', '02:00:00:00:00:01')];
    await jest.advanceTimersByTimeAsync(20_000);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Living Room Fan at 192.0.2.10 is not responding'));
    // The startup scan was under a minute ago, so rediscovery waits until it's a minute old.
    expect(discover).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(40_000);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(registered[0].context.host).toBe('192.0.2.30');
    await jest.advanceTimersByTimeAsync(10_000);
    expect(log.info).toHaveBeenCalledWith('Living Room Fan is responding again');
  });

  it('keeps working when discovery fails, logging it once', async () => {
    addFan('192.0.2.10', '02:00:00:00:00:01', 'Living Room Fan');
    discover.mockRejectedValue(new Error('bind EADDRINUSE'));
    await launch({ hosts: ['192.0.2.10'] });
    await jest.advanceTimersByTimeAsync(300_000);
    expect(log.warn.mock.calls.filter(([m]) => String(m).startsWith('Fan discovery failed'))).toHaveLength(1);
    expect(registered).toHaveLength(1);
    discover.mockResolvedValue([]);
    await jest.advanceTimersByTimeAsync(300_000);
    expect(log.info).toHaveBeenCalledWith('Fan discovery is working again');
  });

  it('controls the fan through HomeKit end to end', async () => {
    addFan('192.0.2.10', '02:00:00:00:00:01', 'Living Room Fan');
    discovered = [ad('192.0.2.10', '02:00:00:00:00:01')];
    await launch();
    const active = registered[0].getService(api.hap.Service.Fanv2)!.getCharacteristic(api.hap.Characteristic.Active);
    const done = active.handleSetRequest(1);
    await jest.advanceTimersByTimeAsync(20);
    await done;
    expect(fans.get('192.0.2.10')!.state.fanOn).toBe(true);
  });

  it('disables itself on an invalid config', async () => {
    await launch({ discovery: false });
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Invalid configuration, plugin disabled'));
    expect(discover).not.toHaveBeenCalled();
    expect(clientsCreated).toEqual([]);
  });

  it('stops scanning on shutdown', async () => {
    discovered = [];
    await launch();
    platform!.stop();
    await jest.advanceTimersByTimeAsync(600_000);
    expect(discover).toHaveBeenCalledTimes(1);
  });
});
