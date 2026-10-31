#!/usr/bin/env node
'use strict';
/**
 * Talk to fans with the plugin's own code, without involving Homebridge.
 *
 *   npm run build
 *   node scripts/modernforms-cli.js discover            # list fans on the network
 *   node scripts/modernforms-cli.js status <host>       # what the plugin sees
 *   node scripts/modernforms-cli.js raw <host>          # raw dynamic shadow data
 *   node scripts/modernforms-cli.js info <host>         # raw static shadow data (account fields hidden)
 *   node scripts/modernforms-cli.js set <host> fanOn=true fanSpeed=3 lightBrightness=40 ...
 *   node scripts/modernforms-cli.js watch <host> [seconds, default 3]
 *
 * <host> is an IP address or host name, optionally with :port.
 */
const http = require('http');

const { discoverFans } = require('../dist/discovery');
const { describeState } = require('../dist/fanAccessory');
const { ModernFormsClient, parseHost, parseState } = require('../dist/modernFormsApi');

const COMMANDS = ['discover', 'status', 'raw', 'info', 'set', 'watch'];
const SETTABLE = { fanOn: 'boolean', fanSpeed: 'number', fanDirection: 'string', lightOn: 'boolean', lightBrightness: 'number' };
/** Account details the static data includes; not needed for diagnostics. */
const PRIVATE_FIELDS = ['owner', 'federatedIdentity'];

const pad = (n) => String(n).padStart(2, '0');
const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/** Raw POST to /mf, returning the parsed JSON as-is. */
function post(host, body) {
  const { hostname, port } = parseHost(host);
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname, port, path: '/mf', method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, Connection: 'close' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('No answer within 5000ms')));
    req.on('error', reject);
    req.end(payload);
  });
}

function parseAssignments(args) {
  const command = {};
  for (const arg of args) {
    const [key, value] = arg.split('=');
    if (!SETTABLE[key] || value === undefined) {
      throw new Error(`Can't set "${arg}"; use ${Object.keys(SETTABLE).map((k) => `${k}=...`).join(' ')}`);
    }
    command[key] = SETTABLE[key] === 'boolean' ? value === 'true' : SETTABLE[key] === 'number' ? Number(value) : value;
  }
  if (!Object.keys(command).length) {
    throw new Error('Nothing to set');
  }
  return command;
}

async function main() {
  const [command, host, ...rest] = process.argv.slice(2);
  if (!COMMANDS.includes(command) || (command !== 'discover' && !host)) {
    console.error('Usage: node scripts/modernforms-cli.js discover | status <host> | raw <host> | info <host> | set <host> key=value... | watch <host> [seconds]');
    process.exit(2);
  }

  if (command === 'discover') {
    const fans = await discoverFans({ listenMs: 3000 });
    if (!fans.length) {
      console.log('No fans answered.');
    }
    for (const fan of fans) {
      console.log(`${fan.name}  ${fan.address}${fan.port === 80 ? '' : `:${fan.port}`}  MAC ${fan.mac ?? '?'}  fw ${fan.firmware ?? '?'}`);
    }
    return;
  }

  const client = new ModernFormsClient({ host, debug: (m) => console.error(`[debug] ${m}`) });
  if (command === 'raw') {
    console.log(JSON.stringify(await post(host, { queryDynamicShadowData: 1 }), null, 2));
    return;
  }
  if (command === 'info') {
    const info = await post(host, { queryStaticShadowData: 1 });
    for (const field of PRIVATE_FIELDS) {
      if (field in info) {
        info[field] = '(hidden)';
      }
    }
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  if (command === 'status') {
    const info = await client.getInfo();
    const state = await client.getState();
    console.log(`${info.deviceName || info.clientId} (${info.fanType || 'unknown model'}, fw ${info.firmwareVersion || '?'}): ${describeState(state, !!info.lightType)}`);
    return;
  }
  if (command === 'set') {
    const state = await client.setState(parseAssignments(rest));
    console.log(`Fan answered: ${describeState(state, true)}`);
    return;
  }
  const seconds = Math.max(1, Number(rest[0]) || 3);
  console.log(`Watching ${host} every ${seconds}s (Ctrl-C to stop)`);
  let previous;
  for (;;) {
    const started = Date.now();
    try {
      const raw = await post(host, { queryDynamicShadowData: 1 });
      const line = describeState(parseState(raw), true);
      const changed = previous !== undefined && previous !== line ? '  <-- changed' : '';
      previous = line;
      console.log(`${clock(new Date())}  ${line}  (last control: ${raw.userData ?? '?'}, ${Date.now() - started}ms)${changed}`);
    } catch (error) {
      console.log(`${clock(new Date())}  FAILED: ${error.message}`);
    }
    const wait = seconds * 1000 - (Date.now() - started);
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

main().catch((error) => {
  console.error(`Failed: ${error.message}`);
  process.exit(1);
});
