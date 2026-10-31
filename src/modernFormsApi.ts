import http from 'http';
import { URL } from 'url';

export type FanDirection = 'forward' | 'reverse';

export const FAN_SPEED_MIN = 1;
export const FAN_SPEED_MAX = 6;
export const LIGHT_BRIGHTNESS_MIN = 1;
export const LIGHT_BRIGHTNESS_MAX = 100;

/** The parts of the dynamic shadow data this plugin controls. */
export interface FanState {
  fanOn: boolean;
  /** 1 (slowest) to 6. */
  fanSpeed: number;
  /** "forward" is summer mode (air blows down), "reverse" is winter mode. */
  fanDirection: FanDirection;
  lightOn: boolean;
  /** 1 to 100. */
  lightBrightness: number;
}

export type FanCommand = Partial<FanState>;

/** Identity and model data from the static shadow data. */
export interface FanInfo {
  /** e.g. "MF_020000000001". */
  clientId: string;
  /** e.g. "02:00:00:00:00:01". */
  mac?: string;
  /** Name given in the Modern Forms app. */
  deviceName?: string;
  /** Model number and blade length, e.g. "1801-60". */
  fanType?: string;
  /** Empty when the fan has no light kit. */
  lightType?: string;
  firmwareVersion?: string;
}

interface Endpoint {
  hostname: string;
  port: number;
}

export interface ModernFormsClientOptions {
  /** IP address or host name, optionally with ":port". */
  host: string;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Total attempts for network failures (1 = no retries). */
  maxAttempts?: number;
  retryDelayMs?: number;
  /** Optional debug logger. */
  debug?: (message: string) => void;
}

export class ModernFormsApiError extends Error {
  constructor(
    message: string,
    /** HTTP status, when the fan answered at all. */
    public readonly status?: number,
    /** Whether a repeat of the same request could plausibly succeed. */
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'ModernFormsApiError';
  }
}

/**
 * Parses "192.0.2.10", "fan.local:8080" or "[fe80::1]:80" into a host name
 * and port. Throws on anything else (paths, schemes, bad ports).
 */
export function parseHost(host: string): Endpoint {
  const trimmed = host.trim();
  if (!trimmed || /[/?#@\s]/.test(trimmed)) {
    throw new Error(`"${host}" is not a valid host (use an IP address or host name, optionally with :port)`);
  }
  let url: URL;
  try {
    url = new URL(`http://${trimmed}`);
  } catch {
    throw new Error(`"${host}" is not a valid host (use an IP address or host name, optionally with :port)`);
  }
  return {
    // Node wants IPv6 literals without the brackets.
    hostname: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: url.port ? Number(url.port) : 80,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const optionalString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Validates the dynamic shadow data the fan returns for queries and commands. */
export function parseState(raw: unknown): FanState {
  if (!isObject(raw) || typeof raw.fanOn !== 'boolean' || typeof raw.fanSpeed !== 'number') {
    throw new ModernFormsApiError(`Unexpected status from the fan: ${JSON.stringify(raw).slice(0, 200)}`);
  }
  return {
    fanOn: raw.fanOn,
    fanSpeed: clamp(raw.fanSpeed, FAN_SPEED_MIN, FAN_SPEED_MAX),
    fanDirection: raw.fanDirection === 'reverse' ? 'reverse' : 'forward',
    lightOn: raw.lightOn === true,
    lightBrightness: typeof raw.lightBrightness === 'number'
      ? clamp(raw.lightBrightness, LIGHT_BRIGHTNESS_MIN, LIGHT_BRIGHTNESS_MAX)
      : LIGHT_BRIGHTNESS_MAX,
  };
}

/** Validates the static shadow data. */
export function parseInfo(raw: unknown): FanInfo {
  if (!isObject(raw) || typeof raw.clientId !== 'string' || !raw.clientId) {
    throw new ModernFormsApiError(`Unexpected device data from the fan: ${JSON.stringify(raw).slice(0, 200)}`);
  }
  return {
    clientId: raw.clientId,
    mac: optionalString(raw.mac),
    deviceName: optionalString(raw.deviceName),
    fanType: optionalString(raw.fanType),
    lightType: optionalString(raw.lightType),
    firmwareVersion: optionalString(raw.firmwareVersion),
  };
}

/**
 * Client for the local API of Generation 1-3 Modern Forms / WAC fans: every
 * call is a JSON POST to `http://<fan>/mf`.
 *
 * The fan's embedded web server is fragile (it can stop accepting
 * connections while the fan still answers ping), so requests to one fan are
 * serialized, use a fresh connection each (no keep-alive), time out quickly
 * and are retried once. Commands set absolute values, so a retry is safe.
 * Uses Node's built-in http module so it runs on the old Node versions HOOBS
 * ships with.
 */
export class ModernFormsClient {
  readonly host: string;
  private readonly endpoint: Endpoint;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly debug: (message: string) => void;
  private queueTail: Promise<void> = Promise.resolve();

  constructor(options: ModernFormsClientOptions) {
    this.host = options.host.trim();
    this.endpoint = parseHost(this.host);
    this.timeoutMs = options.timeoutMs ?? 4_000;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    this.retryDelayMs = options.retryDelayMs ?? 300;
    this.debug = options.debug ?? (() => undefined);
  }

  /** Model, name and identity (rarely changes). */
  async getInfo(): Promise<FanInfo> {
    return parseInfo(await this.request({ queryStaticShadowData: 1 }));
  }

  async getState(): Promise<FanState> {
    return parseState(await this.request({ queryDynamicShadowData: 1 }));
  }

  /** Sends a command; the fan answers with its updated status. */
  async setState(command: FanCommand): Promise<FanState> {
    return parseState(await this.request(command));
  }

  private async request(body: Record<string, unknown>): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.exclusive(() => this.send(body));
      } catch (error) {
        const retryable = error instanceof ModernFormsApiError && error.retryable;
        if (!retryable || attempt >= this.maxAttempts) {
          throw error;
        }
        this.debug(`${this.host}: request failed (attempt ${attempt}/${this.maxAttempts}), retrying: ${(error as Error).message}`);
        await sleep(this.retryDelayMs);
      }
    }
  }

  /** Runs `fn` once every earlier request to this fan has finished. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.queueTail;
    let release!: () => void;
    this.queueTail = new Promise<void>((resolve) => (release = resolve));
    return previous.then(async () => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }

  private send(body: Record<string, unknown>): Promise<unknown> {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise<unknown>((resolve, reject) => {
      const req = http.request({
        hostname: this.endpoint.hostname,
        port: this.endpoint.port,
        path: '/mf',
        method: 'POST',
        // A fresh connection per request: the fan's server copes badly with
        // kept-alive sockets, and Node 19+ keeps them alive by default.
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          'Accept': 'application/json',
          'Connection': 'close',
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', (error) => reject(new ModernFormsApiError(`Response error: ${error.message}`, res.statusCode, true)));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString('utf8');
          if (status === 404) {
            reject(new ModernFormsApiError(
              'HTTP 404 from the fan: it does not offer the /mf API (Generation 4 fans are not supported yet)', status));
            return;
          }
          if (status < 200 || status >= 300) {
            reject(new ModernFormsApiError(`HTTP ${status} from the fan`, status, status >= 500));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new ModernFormsApiError(`Invalid JSON from the fan: ${text.slice(0, 200)}`, status));
          }
        });
      });
      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new ModernFormsApiError(`No answer within ${this.timeoutMs}ms`, undefined, true));
      });
      req.on('error', (error) => {
        reject(error instanceof ModernFormsApiError
          ? error
          : new ModernFormsApiError(`Network error: ${error.message}`, undefined, true));
      });
      req.end(payload);
    });
  }
}
