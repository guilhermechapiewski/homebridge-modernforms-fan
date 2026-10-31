import net from 'net';

import { ModernFormsApiError, ModernFormsClient, parseHost, parseInfo, parseState } from '../src/modernFormsApi';
import { MockServer, rawDynamic, rawStatic } from './helpers';

describe('parseHost', () => {
  it.each([
    ['192.0.2.10', { hostname: '192.0.2.10', port: 80 }],
    [' 192.0.2.10:8080 ', { hostname: '192.0.2.10', port: 8080 }],
    ['MF_Fan_000001.local', { hostname: 'mf_fan_000001.local', port: 80 }],
    ['[fe80::1]:81', { hostname: 'fe80::1', port: 81 }],
  ])('%p', (input, expected) => {
    expect(parseHost(input)).toEqual(expected);
  });

  it.each(['', 'http://192.0.2.10', '192.0.2.10/mf', 'fan:99999', 'two words'])('rejects %p', (input) => {
    expect(() => parseHost(input)).toThrow('is not a valid host');
  });
});

describe('parseState', () => {
  it('reads a real Gen 3 response', () => {
    expect(parseState(rawDynamic({ fanOn: true, fanSpeed: 4, fanDirection: 'reverse', lightOn: true, lightBrightness: 40 }))).toEqual({
      fanOn: true, fanSpeed: 4, fanDirection: 'reverse', lightOn: true, lightBrightness: 40,
    });
  });

  it('clamps out-of-range values and defaults missing light fields', () => {
    expect(parseState({ fanOn: false, fanSpeed: 9, fanDirection: 'sideways' })).toEqual({
      fanOn: false, fanSpeed: 6, fanDirection: 'forward', lightOn: false, lightBrightness: 100,
    });
    expect(parseState({ fanOn: true, fanSpeed: 0, lightOn: true, lightBrightness: 0 })).toMatchObject({ fanSpeed: 1, lightBrightness: 1 });
  });

  it.each([null, 'ok', {}, { fanOn: 'yes', fanSpeed: 1 }, { fanOn: true }])('rejects %p', (raw) => {
    expect(() => parseState(raw)).toThrow(ModernFormsApiError);
  });
});

describe('parseInfo', () => {
  it('reads a real Gen 3 response', () => {
    expect(parseInfo(rawStatic())).toEqual({
      clientId: 'MF_020000000001', mac: '02:00:00:00:00:01', deviceName: 'Living Room Fan', fanType: '1801-60',
      lightType: 'F4IN-120V-R1-30', firmwareVersion: '02.00.0052',
    });
  });

  it('requires a clientId', () => {
    expect(() => parseInfo({ deviceName: 'x' })).toThrow('Unexpected device data');
  });
});

describe('ModernFormsClient', () => {
  let server: MockServer;
  let host: string;

  beforeEach(async () => {
    server = new MockServer();
    host = await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  const client = (options: Partial<ConstructorParameters<typeof ModernFormsClient>[0]> = {}) =>
    new ModernFormsClient({ host, timeoutMs: 500, retryDelayMs: 10, ...options });

  it('queries the status with a JSON POST to /mf on a fresh connection', async () => {
    server.handler = () => ({ body: rawDynamic({ fanOn: true, fanSpeed: 2 }) });
    await expect(client().getState()).resolves.toMatchObject({ fanOn: true, fanSpeed: 2 });
    expect(server.requests).toHaveLength(1);
    const [req] = server.requests;
    expect(req).toMatchObject({ method: 'POST', path: '/mf', body: { queryDynamicShadowData: 1 } });
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers.connection).toBe('close');
  });

  it('queries the static data', async () => {
    server.handler = () => ({ body: rawStatic() });
    await expect(client().getInfo()).resolves.toMatchObject({ clientId: 'MF_020000000001', deviceName: 'Living Room Fan' });
    expect(server.requests[0].body).toEqual({ queryStaticShadowData: 1 });
  });

  it('sends commands as-is and returns the updated status', async () => {
    server.handler = () => ({ body: rawDynamic({ lightOn: true, lightBrightness: 30 }) });
    await expect(client().setState({ lightOn: true, lightBrightness: 30 })).resolves.toMatchObject({ lightOn: true, lightBrightness: 30 });
    expect(server.requests[0].body).toEqual({ lightOn: true, lightBrightness: 30 });
  });

  it('sends one request at a time', async () => {
    server.handler = () => ({ body: rawDynamic(), delayMs: 30 });
    const c = client();
    await Promise.all([c.getState(), c.setState({ fanOn: true }), c.getState()]);
    expect(server.requests).toHaveLength(3);
    expect(server.maxInFlight).toBe(1);
    expect(server.requests.map((r) => r.body)).toEqual([{ queryDynamicShadowData: 1 }, { fanOn: true }, { queryDynamicShadowData: 1 }]);
  });

  it('retries once when the fan does not answer in time', async () => {
    let calls = 0;
    server.handler = () => (++calls === 1 ? { hang: true } : { body: rawDynamic({ fanOn: true }) });
    const debug = jest.fn();
    await expect(client({ timeoutMs: 100, debug }).getState()).resolves.toMatchObject({ fanOn: true });
    expect(calls).toBe(2);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('No answer within 100ms'));
  });

  it('gives up after the last attempt with a retryable error', async () => {
    server.handler = () => ({ hang: true });
    const error = await client({ timeoutMs: 50, maxAttempts: 3 }).getState().catch((e) => e);
    expect(error).toBeInstanceOf(ModernFormsApiError);
    expect(error).toMatchObject({ message: 'No answer within 50ms', retryable: true });
    expect(server.requests).toHaveLength(3);
  });

  it('retries server errors', async () => {
    let calls = 0;
    server.handler = () => (++calls === 1 ? { status: 500, raw: 'oops' } : { body: rawDynamic() });
    await expect(client().getState()).resolves.toBeDefined();
    expect(calls).toBe(2);
  });

  it('explains a 404 (a fan without the /mf API) without retrying', async () => {
    server.handler = () => ({ status: 404, raw: 'Not Found' });
    await expect(client().getState()).rejects.toThrow('Generation 4 fans are not supported yet');
    expect(server.requests).toHaveLength(1);
  });

  it('rejects responses that are not JSON or not fan data', async () => {
    server.handler = () => ({ raw: '<html>captive portal</html>' });
    await expect(client().getState()).rejects.toThrow('Invalid JSON from the fan');
    server.handler = () => ({ body: { hello: 'world' } });
    await expect(client().getState()).rejects.toThrow('Unexpected status from the fan');
    expect(server.requests).toHaveLength(2);
  });

  it('reports a refused connection as a network error', async () => {
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as net.AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await expect(new ModernFormsClient({ host: `127.0.0.1:${port}`, retryDelayMs: 1 }).getState())
      .rejects.toMatchObject({ message: expect.stringContaining('Network error'), retryable: true });
  });

  it('keeps working after a failed request', async () => {
    server.handler = () => ({ status: 404 });
    const c = client();
    await expect(c.getState()).rejects.toThrow();
    server.handler = () => ({ body: rawDynamic({ fanOn: true }) });
    await expect(c.getState()).resolves.toMatchObject({ fanOn: true });
  });
});
