import dgram from 'dgram';
import os from 'os';

/** Modern Forms and WAC fans advertise this mDNS service type. */
export const SERVICE_TYPE = '_easylink._tcp.local';
export const FAN_PROTOCOL = 'com.modernforms.fan';

const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;

/** Instance names fans use, per the WAC API doc (Gen 1-2, Gen 3, WAC brand). */
const FAN_INSTANCE_NAME = /^(MF_Fan_|WAC_Fan_|WAC Windermier Fan)/i;

export interface DiscoveredFan {
  /** mDNS instance name, e.g. "MF_Fan_000001". */
  name: string;
  /** IPv4 address. */
  address: string;
  port: number;
  /** Upper-case, colon-separated, from the TXT record when present. */
  mac?: string;
  firmware?: string;
}

interface DnsRecord {
  name: string;
  type: number;
  data: Buffer;
  /** Offset of `data` in the whole message, for name compression pointers. */
  offset: number;
}

function encodeName(name: string): Buffer {
  const parts: Buffer[] = [];
  for (const label of name.split('.').filter(Boolean)) {
    const bytes = Buffer.from(label, 'utf8');
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** A one-question PTR query for the fans' service type. */
export function buildQuery(): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // QDCOUNT
  // QTYPE PTR, QCLASS IN with the unicast-response bit clear.
  return Buffer.concat([header, encodeName(SERVICE_TYPE), Buffer.from([0, TYPE_PTR, 0, 1])]);
}

/** Reads a (possibly compressed) domain name; returns it and the offset after it. */
function readName(message: Buffer, start: number): { name: string; next: number } {
  const labels: string[] = [];
  let offset = start;
  let next = -1;
  for (let jumps = 0; ; ) {
    if (offset >= message.length) {
      throw new Error('name runs past the end of the message');
    }
    const length = message[offset];
    if (length === 0) {
      offset += 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= message.length || ++jumps > 20) {
        throw new Error('bad name compression pointer');
      }
      if (next < 0) {
        next = offset + 2;
      }
      offset = ((length & 0x3f) << 8) | message[offset + 1];
      continue;
    }
    if (offset + 1 + length > message.length) {
      throw new Error('label runs past the end of the message');
    }
    labels.push(message.toString('utf8', offset + 1, offset + 1 + length));
    offset += 1 + length;
  }
  return { name: labels.join('.'), next: next < 0 ? offset : next };
}

function readRecords(message: Buffer): DnsRecord[] {
  if (message.length < 12) {
    throw new Error('message too short');
  }
  const questions = message.readUInt16BE(4);
  const count = message.readUInt16BE(6) + message.readUInt16BE(8) + message.readUInt16BE(10);
  let offset = 12;
  for (let i = 0; i < questions; i++) {
    offset = readName(message, offset).next + 4;
  }
  const records: DnsRecord[] = [];
  for (let i = 0; i < count; i++) {
    const { name, next } = readName(message, offset);
    if (next + 10 > message.length) {
      throw new Error('record header runs past the end of the message');
    }
    const type = message.readUInt16BE(next);
    const length = message.readUInt16BE(next + 8);
    const dataStart = next + 10;
    if (dataStart + length > message.length) {
      throw new Error('record data runs past the end of the message');
    }
    records.push({ name: name.toLowerCase(), type, data: message.subarray(dataStart, dataStart + length), offset: dataStart });
    offset = dataStart + length;
  }
  return records;
}

function parseTxt(data: Buffer): Record<string, string> {
  const result: Record<string, string> = {};
  for (let offset = 0; offset < data.length; ) {
    const length = data[offset];
    const entry = data.toString('utf8', offset + 1, offset + 1 + length);
    offset += 1 + length;
    const eq = entry.indexOf('=');
    if (eq > 0) {
      result[entry.slice(0, eq).toLowerCase()] = entry.slice(eq + 1);
    }
  }
  return result;
}

/**
 * Extracts the fans announced in one mDNS response. `sender` is the address
 * the packet came from, used when the response carries no A record.
 * Malformed packets yield no fans rather than throwing.
 */
export function parseResponse(message: Buffer, sender?: string): DiscoveredFan[] {
  let records: DnsRecord[];
  try {
    records = readRecords(message);
  } catch {
    return [];
  }
  const fans: DiscoveredFan[] = [];
  for (const ptr of records.filter((r) => r.type === TYPE_PTR && r.name === SERVICE_TYPE)) {
    const instance = readName(message, ptr.offset).name;
    const key = instance.toLowerCase();
    const label = instance.slice(0, instance.length - SERVICE_TYPE.length - 1);

    const txtRecord = records.find((r) => r.type === TYPE_TXT && r.name === key);
    const txt = txtRecord ? parseTxt(txtRecord.data) : {};
    // Other EasyLink-based gadgets use the same service type.
    if (txt.protocol ? txt.protocol !== FAN_PROTOCOL : !FAN_INSTANCE_NAME.test(label)) {
      continue;
    }

    const srv = records.find((r) => r.type === TYPE_SRV && r.name === key && r.data.length >= 7);
    const target = srv ? readName(message, srv.offset + 6).name.toLowerCase() : undefined;
    const a = records.find((r) => r.type === TYPE_A && r.data.length === 4 && (!target || r.name === target));
    const address = a ? [...a.data].join('.') : sender;
    if (!address) {
      continue;
    }
    fans.push({
      name: label,
      address,
      port: srv ? srv.data.readUInt16BE(4) : 80,
      mac: txt.mac ? txt.mac.toUpperCase() : undefined,
      firmware: txt['firmware rev'],
    });
  }
  return fans;
}

export interface DiscoveryOptions {
  /** How long to collect answers. */
  listenMs: number;
  /** Where to send the query; tests point this at a local responder. */
  address?: string;
  port?: number;
  /** Interface addresses to send from; defaults to every external IPv4 interface. */
  interfaces?: string[];
}

function externalIPv4Addresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      // Node 18.0-18.3 briefly reported `family` as a number.
      if (!entry.internal && (entry.family === 'IPv4' || (entry.family as unknown) === 4)) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}

/**
 * Finds fans on the local network with one mDNS query per network interface.
 *
 * The query goes out from an ephemeral port, which makes it a "legacy
 * unicast" query (RFC 6762 §6.7): fans answer straight to that port with all
 * their records, so this works next to an mDNS daemon that already owns port
 * 5353 (avahi on HOOBS, mDNSResponder on macOS).
 */
export function discoverFans(options: DiscoveryOptions): Promise<DiscoveredFan[]> {
  const address = options.address ?? MDNS_ADDRESS;
  const port = options.port ?? MDNS_PORT;
  const interfaces = options.interfaces ?? (address === MDNS_ADDRESS ? externalIPv4Addresses() : []);

  return new Promise((resolve, reject) => {
    const found = new Map<string, DiscoveredFan>();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      if (error) {
        reject(error);
      } else {
        resolve([...found.values()]);
      }
    };
    const timer = setTimeout(() => finish(), options.listenMs);

    socket.on('error', (error) => finish(error));
    socket.on('message', (message, remote) => {
      for (const fan of parseResponse(message, remote.address)) {
        found.set(fan.mac ?? fan.name.toLowerCase(), fan);
      }
    });
    socket.bind(0, () => {
      const query = buildQuery();
      const send = () => new Promise<void>((done) => socket.send(query, port, address, () => done()));
      void (async () => {
        if (!interfaces.length) {
          await send();
          return;
        }
        for (const iface of interfaces) {
          try {
            socket.setMulticastInterface(iface);
          } catch {
            continue;
          }
          await send();
        }
      })();
    });
  });
}
