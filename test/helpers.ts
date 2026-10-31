import http from 'http';
import { AddressInfo, Socket } from 'net';
import type { Logger } from 'homebridge';

import type { FanInfo, FanState } from '../src/modernFormsApi';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export interface Reply {
  status?: number;
  body?: unknown;
  raw?: string;
  delayMs?: number;
  /** Never answer (the fan's stuck web server). */
  hang?: boolean;
}

export type Handler = (req: RecordedRequest) => Reply | Promise<Reply>;

/** A real HTTP server on localhost that records requests and replies via `handler`. */
export class MockServer {
  readonly requests: RecordedRequest[] = [];
  handler: Handler = () => ({ body: makeState() });
  inFlight = 0;
  maxInFlight = 0;
  private server = http.createServer((req, res) => this.handle(req, res));
  private sockets = new Set<Socket>();

  /** Returns the "host:port" to give the client. */
  async start(): Promise<string> {
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      this.inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      const text = Buffer.concat(chunks).toString('utf8');
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: text ? JSON.parse(text) : undefined,
      };
      this.requests.push(recorded);
      const reply = await this.handler(recorded);
      if (reply.hang) {
        this.inFlight--;
        return;
      }
      if (reply.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
      }
      this.inFlight--;
      res.statusCode = reply.status ?? 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
    });
  }
}

export function makeLogger(): jest.Mocked<Logger> {
  const log = jest.fn() as unknown as jest.Mocked<Logger>;
  Object.assign(log, {
    prefix: 'test',
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    success: jest.fn(),
    log: jest.fn(),
  });
  return log;
}

export function makeState(overrides: Partial<FanState> = {}): FanState {
  return { fanOn: false, fanSpeed: 3, fanDirection: 'forward', lightOn: false, lightBrightness: 50, ...overrides };
}

export function makeInfo(overrides: Partial<FanInfo> = {}): FanInfo {
  return {
    clientId: 'MF_020000000001',
    mac: '02:00:00:00:00:01',
    deviceName: 'Sunroom Fan',
    fanType: '1801-60',
    lightType: 'F4IN-120V-R1-30',
    firmwareVersion: '02.00.0052',
    ...overrides,
  };
}

/** Dynamic shadow data as a Gen 3 fan (firmware 02.00.0052) returns it. */
export function rawDynamic(state: Partial<FanState> = {}): Record<string, unknown> {
  return {
    clientId: 'MF_020000000001', cloudPort: 8883, lightOn: false, fanOn: false, lightBrightness: 100, fanSpeed: 6,
    fanDirection: 'forward', wind: false, windSpeed: 2, rfPairModeActive: false, resetRfPairList: false, factoryReset: false,
    awayModeEnabled: false, fanTimer: 0, lightTimer: 0, decommission: false, schedule: '', adaptiveLearning: false,
    userData: 'local_wifi', timezone: 'UTC', FrCodes: 'HSSWWxxxxxxxxxx', cdebug: false, feedbackToneMute: false,
    ...state,
  };
}

/** Static shadow data as a Gen 3 fan returns it (account fields scrubbed). */
export function rawStatic(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientId: 'MF_020000000001', mac: '02:00:00:00:00:01', lightType: 'F4IN-120V-R1-30', fanType: '1801-60',
    fanMotorType: 'DC125X30', brand: 1, dateCode: '2024-01-01', owner: 'owner@example.com', federatedIdentity: 'us-east-1:x',
    deviceName: 'Living Room Fan', firmwareVersion: '02.00.0052', 'esp-idf-version': '4.0.4', mainMcuFirmwareVersion: '03.00.0000',
    firmwareUrl: '', wifiSignal: '-52', SSID: 'IoT', BSSID: '0x000000000000', isUvcFan: false, built: 'realHardware',
    dimTableId: 416020, elecFreq: 60,
    ...overrides,
  };
}
