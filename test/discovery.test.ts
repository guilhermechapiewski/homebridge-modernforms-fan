import dgram from 'dgram';
import { AddressInfo } from 'net';

import { buildQuery, discoverFans, parseResponse } from '../src/discovery';

function name(value: string): Buffer {
  const parts: Buffer[] = [];
  for (const label of value.split('.')) {
    parts.push(Buffer.from([Buffer.byteLength(label)]), Buffer.from(label));
  }
  return Buffer.concat([...parts, Buffer.from([0])]);
}

function record(owner: Buffer, type: number, data: Buffer): Buffer {
  const header = Buffer.alloc(10);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(1, 2);
  header.writeUInt32BE(120, 4);
  header.writeUInt16BE(data.length, 8);
  return Buffer.concat([owner, header, data]);
}

function txt(entries: string[]): Buffer {
  return Buffer.concat(entries.map((e) => Buffer.concat([Buffer.from([Buffer.byteLength(e)]), Buffer.from(e)])));
}

function srv(port: number, target: string): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt16BE(port, 4);
  return Buffer.concat([head, name(target)]);
}

interface FanAd {
  instance: string;
  ip?: string;
  port?: number;
  txt?: string[];
}

/** A response shaped like the fans' own: PTR, SRV and TXT answers plus an A record. */
function response(fans: FanAd[], question = false): Buffer {
  const answers: Buffer[] = [];
  const additional: Buffer[] = [];
  for (const fan of fans) {
    const full = `${fan.instance}._easylink._tcp.local`;
    const host = `${fan.instance}.local`;
    answers.push(record(name('_easylink._tcp.local'), 12, name(full)));
    answers.push(record(name(full), 33, srv(fan.port ?? 80, host)));
    answers.push(record(name(full), 16, txt(fan.txt ?? [
      'Protocol=com.modernforms.fan', 'MAC=02:00:00:00:00:01', 'Firmware Rev=02.00.0052',
    ])));
    if (fan.ip) {
      additional.push(record(name(host), 1, Buffer.from(fan.ip.split('.').map(Number))));
    }
  }
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(question ? 1 : 0, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(additional.length, 10);
  const q = question ? [name('_easylink._tcp.local'), Buffer.from([0, 12, 0, 1])] : [];
  return Buffer.concat([header, ...q, ...answers, ...additional]);
}

describe('buildQuery', () => {
  it('asks for PTR records of _easylink._tcp.local', () => {
    expect(buildQuery().toString('hex')).toBe(
      '000000000001000000000000' + name('_easylink._tcp.local').toString('hex') + '000c0001');
  });
});

describe('parseResponse', () => {
  it('reads a fan announcement', () => {
    expect(parseResponse(response([{ instance: 'MF_Fan_000001', ip: '192.0.2.10' }]), '198.51.100.9')).toEqual([{
      name: 'MF_Fan_000001', address: '192.0.2.10', port: 80, mac: '02:00:00:00:00:01', firmware: '02.00.0052',
    }]);
  });

  it('skips the echoed question and reads several fans', () => {
    const fans = parseResponse(response([
      { instance: 'MF_Fan_000001', ip: '192.0.2.10' },
      { instance: 'MF_Fan_000002', ip: '192.0.2.11', port: 8080, txt: ['Protocol=com.modernforms.fan', 'MAC=02:00:00:00:00:02'] },
    ], true));
    expect(fans.map((f) => [f.name, f.address, f.port, f.mac])).toEqual([
      ['MF_Fan_000001', '192.0.2.10', 80, '02:00:00:00:00:01'],
      ['MF_Fan_000002', '192.0.2.11', 8080, '02:00:00:00:00:02'],
    ]);
  });

  it('uses the sender address when there is no A record', () => {
    expect(parseResponse(response([{ instance: 'MF_Fan_000001' }]), '192.0.2.10')[0].address).toBe('192.0.2.10');
    expect(parseResponse(response([{ instance: 'MF_Fan_000001' }]))).toEqual([]);
  });

  it('ignores other EasyLink devices', () => {
    expect(parseResponse(response([{ instance: 'Plug_123', ip: '192.0.2.50', txt: ['Protocol=com.example.plug'] }]))).toEqual([]);
    expect(parseResponse(response([{ instance: 'Plug_123', ip: '192.0.2.50', txt: [] }]))).toEqual([]);
    // No TXT protocol, but a fan's instance name.
    expect(parseResponse(response([{ instance: 'WAC_Fan_000003', ip: '192.0.2.50', txt: [] }]))).toHaveLength(1);
  });

  it('follows name compression pointers', () => {
    // PTR whose data is "MF_Fan_000001" + pointer to the question's "_easylink._tcp.local".
    const header = Buffer.from('000084000001000100000000', 'hex');
    const question = Buffer.concat([name('_easylink._tcp.local'), Buffer.from([0, 12, 0, 1])]);
    const ptrData = Buffer.concat([Buffer.from([13]), Buffer.from('MF_Fan_000001'), Buffer.from([0xc0, 12])]);
    const message = Buffer.concat([header, question, record(Buffer.from([0xc0, 12]), 12, ptrData)]);
    expect(parseResponse(message, '192.0.2.10')).toEqual([{ name: 'MF_Fan_000001', address: '192.0.2.10', port: 80 }]);
  });

  it.each([
    ['empty', Buffer.alloc(0)],
    ['truncated', response([{ instance: 'MF_Fan_000001', ip: '192.0.2.10' }]).subarray(0, 60)],
    ['pointer loop', Buffer.concat([Buffer.from('000084000000000100000000', 'hex'), Buffer.from([0xc0, 12])])],
  ])('returns nothing for a malformed packet (%s)', (_label, message) => {
    expect(parseResponse(message, '192.0.2.10')).toEqual([]);
  });
});

describe('discoverFans', () => {
  let responder: dgram.Socket;
  let port: number;
  let queries: Buffer[];

  beforeEach(async () => {
    queries = [];
    responder = dgram.createSocket('udp4');
    responder.on('message', (message, remote) => {
      queries.push(message);
      // Two fans, one of them answering twice.
      for (const reply of [
        response([{ instance: 'MF_Fan_000001', ip: '192.0.2.10' }]),
        response([{ instance: 'MF_Fan_000001', ip: '192.0.2.10' }]),
        response([{ instance: 'MF_Fan_000002', ip: '192.0.2.11', txt: ['Protocol=com.modernforms.fan', 'MAC=02:00:00:00:00:02'] }]),
        Buffer.from('garbage'),
      ]) {
        responder.send(reply, remote.port, remote.address);
      }
    });
    await new Promise<void>((resolve) => responder.bind(0, '127.0.0.1', resolve));
    port = (responder.address() as AddressInfo).port;
  });

  afterEach(() => {
    responder.close();
  });

  it('sends the query and collects each fan once', async () => {
    const fans = await discoverFans({ listenMs: 300, address: '127.0.0.1', port });
    expect(queries.map((q) => q.toString('hex'))).toEqual([buildQuery().toString('hex')]);
    expect(fans.map((f) => `${f.name}@${f.address}`).sort()).toEqual(['MF_Fan_000001@192.0.2.10', 'MF_Fan_000002@192.0.2.11']);
  });

  it('resolves with nothing when no fan answers', async () => {
    responder.removeAllListeners('message');
    await expect(discoverFans({ listenMs: 100, address: '127.0.0.1', port })).resolves.toEqual([]);
  });
});
