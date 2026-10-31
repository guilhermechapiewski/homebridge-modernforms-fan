'use strict';
/**
 * End-to-end test: runs a real Homebridge process with this plugin against
 * two mock fans, then drives it through Homebridge's HAP HTTP API (insecure
 * mode) exactly like the Home app would.
 *
 * Usage: npm run test:e2e
 * Set HOMEBRIDGE_BIN to test a different Homebridge install (e.g. v2), and
 * E2E_PLUGIN_PATH to test an unpacked `npm pack` tarball instead of the repo.
 *
 * Discovery is off here: it would find (and start polling) real fans on the
 * developer's network. It is covered by the unit tests with a real UDP socket.
 */
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createMockFan } = require('./mockFan');

const ROOT = path.resolve(__dirname, '..', '..');
const PLUGIN_PATH = path.resolve(process.env.E2E_PLUGIN_PATH || ROOT);
const HOMEBRIDGE_BIN = process.env.HOMEBRIDGE_BIN || path.join(ROOT, 'node_modules', 'homebridge', 'bin', 'homebridge');
const PIN = '031-45-154';
const NO_RESPONSE = -70402;

const T = {
  info: '3E', manufacturer: '20', model: '21', serial: '30', firmware: '52', name: '23',
  fan: 'B7', active: 'B0', speed: '29', direction: '28',
  light: '43', on: '25', brightness: '8',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hap(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: { Authorization: PIN, 'Content-Type': 'application/hap+json', ...(data ? { 'Content-Length': data.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : undefined });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

function normalizeType(type) {
  // HAP short form "25" -> full Apple base UUID.
  return /^[0-9A-F]{1,8}$/i.test(type) ? `${type.toUpperCase().padStart(8, '0')}-0000-1000-8000-0026BB765291` : type.toUpperCase();
}

async function waitFor(description, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await predicate();
    if (result) {
      return result;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${description}`);
    }
    await sleep(250);
  }
}

function startHomebridge(storageDir, pluginDir) {
  const child = spawn(process.execPath, [HOMEBRIDGE_BIN, '-I', '-D', '-U', storageDir, '-P', pluginDir], {
    env: { ...process.env, FORCE_COLOR: '0', DEBUG: '' },
  });
  const proc = { child, output: '' };
  const append = (chunk) => {
    proc.output += chunk.toString();
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  return proc;
}

async function stopHomebridge(proc) {
  if (proc.child.exitCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => proc.child.once('exit', resolve));
  proc.child.kill('SIGTERM');
  await Promise.race([exited, sleep(10000).then(() => proc.child.kill('SIGKILL'))]);
}

/** Maps each accessory (by serial number) to its characteristics' aid/iid by service and characteristic type. */
async function readAccessories(port) {
  const { body } = await hap(port, 'GET', '/accessories');
  const result = {};
  for (const accessory of body.accessories) {
    const services = {};
    for (const service of accessory.services) {
      const chars = {};
      for (const c of service.characteristics) {
        chars[normalizeType(c.type)] = { aid: accessory.aid, iid: c.iid, value: c.value };
      }
      services[normalizeType(service.type)] = chars;
    }
    const info = services[normalizeType(T.info)];
    result[info[normalizeType(T.serial)].value] = { aid: accessory.aid, services };
  }
  return result;
}

function char(accessory, service, type) {
  const found = accessory.services[normalizeType(service)]?.[normalizeType(type)];
  assert.ok(found, `missing characteristic ${type} on service ${service}`);
  return found;
}

async function read(port, c) {
  const { body } = await hap(port, 'GET', `/characteristics?id=${c.aid}.${c.iid}`);
  const characteristic = body.characteristics[0];
  if (typeof characteristic.value === 'boolean') {
    characteristic.value = characteristic.value ? 1 : 0;
  }
  return characteristic;
}

async function write(port, ...pairs) {
  const res = await hap(port, 'PUT', '/characteristics', {
    characteristics: pairs.map(([c, value]) => ({ aid: c.aid, iid: c.iid, value })),
  });
  assert.ok(res.status === 204 || res.status === 207, `unexpected status ${res.status}`);
  if (res.status === 207) {
    for (const c of res.body.characteristics) {
      assert.strictEqual(c.status, 0, `write failed: ${JSON.stringify(c)}`);
    }
  }
}

async function main() {
  assert.ok(fs.existsSync(path.join(PLUGIN_PATH, 'dist', 'index.js')), `No dist/index.js in ${PLUGIN_PATH}; run "npm run build" first`);

  const withLight = createMockFan({ mac: '02:00:00:00:00:01', name: 'Living Room Fan' });
  const noLight = createMockFan({ mac: '02:00:00:00:00:02', name: 'Patio Fan', light: false });
  const hosts = [];
  for (const fan of [withLight, noLight]) {
    await new Promise((resolve) => fan.server.listen(0, '127.0.0.1', resolve));
    hosts.push(`127.0.0.1:${fan.server.address().port}`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modernforms-e2e-'));
  const storageDir = path.join(tmp, 'storage');
  const pluginDir = path.join(tmp, 'plugins');
  fs.mkdirSync(storageDir);
  fs.mkdirSync(pluginDir);
  fs.symlinkSync(PLUGIN_PATH, path.join(pluginDir, 'homebridge-modernforms-fan'));

  const hapPort = 50000 + Math.floor(Math.random() * 10000);
  fs.writeFileSync(path.join(storageDir, 'config.json'), JSON.stringify({
    bridge: { name: 'Modern Forms E2E', username: '0E:22:33:44:55:66', port: hapPort, pin: PIN, advertiser: 'ciao', bind: ['127.0.0.1'] },
    accessories: [],
    platforms: [{ platform: 'ModernFormsFan', name: 'Modern Forms Fan', discovery: false, hosts, pollingIntervalSeconds: 10 }],
  }, null, 2));

  let hb = startHomebridge(storageDir, pluginDir);
  const step = (msg) => console.log(`  ✓ ${msg}`);
  try {
    const accessories = await waitFor('both fans to be published', async () => {
      if (hb.child.exitCode !== null) {
        throw new Error(`Homebridge exited early:\n${hb.output}`);
      }
      const found = await readAccessories(hapPort).catch(() => undefined);
      return found && found['02:00:00:00:00:01'] && found['02:00:00:00:00:02'] ? found : undefined;
    });
    const versionLine = (hb.output.match(/Homebridge v\d+\.\d+\.\d+[\w.-]*/) || ['Homebridge (unknown version)'])[0];
    console.log(`Running against ${versionLine} on Node ${process.version}`);
    assert.ok(hb.output.includes('Adding Living Room Fan') && hb.output.includes('Adding Patio Fan'));
    step('plugin loaded and both fans published');

    const fan = accessories['02:00:00:00:00:01'];
    const info = (type) => char(fan, T.info, type).value;
    assert.strictEqual(info(T.manufacturer), 'Modern Forms');
    assert.strictEqual(info(T.model), '1801-60');
    assert.strictEqual(info(T.firmware), '2.0.52');
    assert.strictEqual(char(fan, T.fan, T.name).value, 'Living Room Fan');
    assert.strictEqual(char(fan, T.light, T.name).value, 'Living Room Fan Light');
    step('accessory information and names are correct');

    const patio = accessories['02:00:00:00:00:02'];
    assert.ok(patio.services[normalizeType(T.fan)], 'fan without light kit has no Fan service');
    assert.strictEqual(patio.services[normalizeType(T.light)], undefined, 'fan without light kit must not have a Lightbulb');
    step('a fan without a light kit has no light');

    const active = char(fan, T.fan, T.active);
    const speed = char(fan, T.fan, T.speed);
    const direction = char(fan, T.fan, T.direction);
    const lightOn = char(fan, T.light, T.on);
    const brightness = char(fan, T.light, T.brightness);

    assert.strictEqual((await read(hapPort, active)).value, 0);
    assert.strictEqual((await read(hapPort, speed)).value, 100);
    step('initial state reads as off at speed 6 (100 %)');

    await write(hapPort, [active, 1]);
    assert.strictEqual(withLight.state.dynamic.fanOn, true);
    assert.strictEqual((await read(hapPort, active)).value, 1);
    step('turning the fan on from HomeKit turns it on');

    await write(hapPort, [speed, 40]);
    assert.strictEqual(withLight.state.dynamic.fanSpeed, 2);
    await waitFor('speed to snap to 33 %', async () => (await read(hapPort, speed)).value === 33);
    step('40 % sets speed 2, and HomeKit snaps to 33 %');

    await write(hapPort, [direction, 0]);
    assert.strictEqual(withLight.state.dynamic.fanDirection, 'reverse');
    step('clockwise rotation sets reverse (winter) mode');

    const before = withLight.state.requests.length;
    await write(hapPort, [lightOn, true], [brightness, 30]);
    const commands = withLight.state.requests.slice(before).filter((r) => !r.queryDynamicShadowData);
    assert.deepStrictEqual(commands, [{ lightBrightness: 30 }, { lightOn: true }]);
    assert.strictEqual((await read(hapPort, brightness)).value, 30);
    step('light on + brightness sets the brightness first, then turns the light on');

    await write(hapPort, [active, 0], [lightOn, false]);
    assert.strictEqual(withLight.state.dynamic.fanOn, false);
    assert.strictEqual(withLight.state.dynamic.lightOn, false);
    step('turning fan and light off together works');

    // Changed with the remote / wall control / Modern Forms app.
    withLight.state.dynamic.fanOn = true;
    withLight.state.dynamic.fanSpeed = 5;
    await waitFor('external change to reach HomeKit', async () => (await read(hapPort, active)).value === 1
      && (await read(hapPort, speed)).value === 83, 30000);
    assert.ok(hb.output.includes('Living Room Fan changed outside Apple Home: fan on at speed 5'));
    step('a change made outside Apple Home shows up and is logged');

    withLight.state.stuck = true;
    await waitFor('stuck fan to show No Response', async () => (await read(hapPort, active)).status === NO_RESPONSE, 60000);
    assert.ok(hb.output.includes('is not responding'));
    step('a fan whose web server is stuck shows "No Response"');
    withLight.state.stuck = false;
    await waitFor('fan to come back', async () => (await read(hapPort, active)).value === 1, 45000);
    assert.ok(hb.output.includes('Living Room Fan is responding again'));
    step('the fan recovers once it answers again');

    // Restart: accessories must be restored from cache, not re-added.
    await stopHomebridge(hb);
    hb = startHomebridge(storageDir, pluginDir);
    const after = await waitFor('accessories restored after restart', async () => {
      const found = hb.output.includes('Restored Living Room Fan') && await readAccessories(hapPort).catch(() => undefined);
      return found && found['02:00:00:00:00:01'] ? found : undefined;
    });
    assert.ok(!hb.output.includes('Adding Living Room Fan'), 'accessory was re-added instead of restored');
    assert.strictEqual(after['02:00:00:00:00:01'].aid, fan.aid, 'accessory id changed across restart (Home app would lose it)');
    step('restart restores the cached accessories with the same identity');

    // A fan that's unreachable at startup keeps its accessory.
    await stopHomebridge(hb);
    withLight.state.stuck = true;
    hb = startHomebridge(storageDir, pluginDir);
    await waitFor('unreachable fan to be reported', async () => hb.output.includes('Living Room Fan at 127.0.0.1'), 60000);
    const stillThere = await readAccessories(hapPort);
    assert.ok(stillThere['02:00:00:00:00:01'], 'unreachable fan was removed');
    withLight.state.stuck = false;
    step('a fan unreachable at startup keeps its accessory');

    const unexpected = hb.output.split('\n').filter((l) => /TypeError|ReferenceError|UnhandledPromiseRejection|characteristic warning|This plugin generated a warning|illegal value/i.test(l));
    assert.deepStrictEqual(unexpected, [], 'Homebridge logged unexpected errors/warnings');
    step('no plugin warnings or unhandled errors in Homebridge logs');

    console.log('\nE2E PASSED');
  } catch (error) {
    console.error('\nE2E FAILED:', error.message);
    console.error('--- Mock fan state ---\n' + JSON.stringify(withLight.state.dynamic, null, 2));
    console.error('--- Homebridge output ---\n' + hb.output);
    process.exitCode = 1;
  } finally {
    await stopHomebridge(hb);
    await withLight.close();
    await noLight.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
