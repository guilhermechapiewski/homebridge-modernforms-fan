# AGENTS.md

Guidance for AI coding agents (and humans) working on this repo. `CLAUDE.md` imports this file. Keep it current: update "Status" when work lands, and add any new real-fan quirk you discover.

## What this is

A Homebridge plugin (`homebridge-modernforms-fan`) that exposes Modern Forms (and WAC-brand) smart ceiling fans to Apple Home through the fans' **local** HTTP/JSON API. No cloud, no account. It runs on the owner's **HOOBS** box, like its sibling [homebridge-trimlight-edge](https://github.com/guilhermechapiewski/homebridge-trimlight-edge), whose conventions this repo follows. Scope so far is fan on/off, speed and direction, plus light on/off and brightness. Breeze mode, sleep timers and away mode are planned for later.

## Working agreements

- **Quality bar:** senior-level, robust code with tests. Verify everything (lint, unit tests, e2e, plus a real-fan check when the change touches API behavior) **before** asking the owner to look. Report what could not be verified.
- **Commits:** commit verified, green states **directly to `main`** after each chunk of work, with messages explaining what changed and why. No feature branches for now.
- **Ask first** before anything outward-facing: `git push`, `npm publish`, or anything else that leaves this machine. **Sending commands to the owner's real fans also needs a go-ahead** (they're physical devices in a lived-in house); read-only queries are fine.
- **This repo is open source and must stay generic.** Never commit the owner's IP addresses, MACs, client IDs, fan names, SSIDs, or any other detail of their network. Use RFC 5737 addresses (`192.0.2.x`, `198.51.100.x`), made-up MACs (`02:00:00:...`), and generic names (`Living Room Fan`). Record real-fan findings generically, e.g. "a Gen 3 fan on firmware 02.00.0052". Grep for leaks before committing.
- **Licensing:** the project is ISC (`LICENSE`). No code is ported from elsewhere. If you port any, add a `NOTICE` file with its license and ship it in `files`. Don't copy the WAC API PDF into the repo: it's under WAC's own license agreement. Link to it instead.
- Match the surrounding code style (TypeScript, single quotes, semicolons, trailing commas; see `eslint.config.mjs`).

## Commands

```bash
npm run lint        # ESLint, zero warnings allowed (src, test, scripts)
npm run typecheck
npm test            # Jest unit tests: real local HTTP/UDP servers + real HAP objects from homebridge
npm run test:e2e    # builds, then runs real Homebridge against two mock fans (test/e2e/mockFan.js); ~2 min
npm run build       # tsc -> dist/ (CommonJS, ES2020)

# Real-fan checks (needs a build; "set" and "watch" talk to a real fan)
node scripts/modernforms-cli.js discover | status <host> | raw <host> | info <host> | set <host> key=value... | watch <host>
```

Before publishing, also run the e2e against the packed artifact: `npm pack`, extract it, then set `E2E_PLUGIN_PATH=<extracted>/package` for `node test/e2e/run-e2e.js`. This catches files missing from `package.json` `files`. `test:e2e` uses `HOMEBRIDGE_BIN` to target another Homebridge install. Before releasing, run it across the version matrix: Homebridge 1.3.4 and 1.5.0 on Node 16, and Homebridge 2.4.x on Node 22. Install those into a scratch directory with `npm install homebridge@<v>` and run that Node binary on `test/e2e/run-e2e.js`. Node 14 has no Apple Silicon build, so check ES2020 syntax with `npx acorn --ecma2020 dist/*.js` instead.

The e2e runs with discovery **off**: on a developer's machine it would find and start polling real fans. Discovery is covered by unit tests over a real UDP socket.

## Compatibility constraints (HOOBS)

HOOBS boxes run old runtimes, seen in the wild as Node 14–16 with Homebridge 1.3–1.5.

- `engines`: Node `>=14.18.0`, Homebridge `^1.3.0 || ^2.0.0`. Verify any new HAP or Homebridge API against 1.3.
- **No runtime dependencies.** Use Node's `http` and `dgram`, not `fetch` or an mDNS library.
- The compile target is ES2020 / CommonJS. Don't use newer syntax or runtime APIs (`Array.prototype.at`, `structuredClone`, etc.).

## Code map

- `src/modernFormsApi.ts`: local API client (`POST /mf`). Handles serialized requests per fan, a fresh connection per request, a 4 s timeout, one retry, and typed errors (`ModernFormsApiError`). Also has response validation (`parseState`, `parseInfo`) and `parseHost`.
- `src/discovery.ts`: dependency-free mDNS. It builds the PTR query for `_easylink._tcp.local`, parses responses (with name compression), and sends one legacy-unicast query per IPv4 interface.
- `src/fanAccessory.ts`: the HomeKit Fanv2 (+ Lightbulb) for one fan. Covers the percent↔speed mapping, write coalescing, on-read refresh, and online/offline tracking.
- `src/platform.ts`: config parsing, discovery plus configured hosts, MAC-based identity, following IP changes, and accessory add/restore.
- `test/e2e/`: mock fan (mirrors a real Gen 3 fan's responses) and the end-to-end runner (drives Homebridge's insecure HAP HTTP API).

## The local API (Generation 1–3 fans)

Source: WAC's "Smart Fans IP API Definition for 3rd Party Integrations" (2021). A copy is in [aiomodernforms/docs](https://github.com/wonderslug/aiomodernforms/tree/master/docs). [aiomodernforms](https://github.com/wonderslug/aiomodernforms) (MIT, used by Home Assistant) is the best reference implementation.

- Everything is `POST http://<fan>/mf` with a JSON body. `{"queryDynamicShadowData":1}` returns status. `{"queryStaticShadowData":1}` returns identity: `clientId`, `mac`, `deviceName`, `fanType`, `lightType` (empty without a light kit), `firmwareVersion`, plus `owner` (an email) and `federatedIdentity`, which the plugin never logs.
- Commands are partial bodies like `{"fanOn":true,"fanSpeed":3}`, and the answer is the full updated status. Fields: `fanOn`, `fanSpeed` 1–6, `fanDirection` `"forward"`/`"reverse"`, `lightOn`, `lightBrightness` 1–100. Gen 3 also has `wind`, `windSpeed` 1–3, and `fanTimer`/`lightTimer` (seconds; Gen 1–2 use epoch `fanSleepTimer`/`lightSleepTimer`).
- **Never send** `factoryReset`, `decommission`, `resetRfPairList` or `rfPairModeActive`. They wipe Wi-Fi/cloud setup or remote pairings.
- `POST /config-read` returns firmware/RF versions and Wi-Fi signal (field names differ by generation). The plugin doesn't use it.
- mDNS: service `_easylink._tcp`, instance `MF_Fan_XXXXXX` (Gen 3), `WAC Windermier Fan#XXXXXX` (Gen 1–2) or `WAC_Fan_XXXXXX`. TXT has `Protocol=com.modernforms.fan`, `MAC=...` and `Firmware Rev=...`. Other EasyLink gadgets share the service type, so filter on the protocol.
- **Generation 4** fans use a different API (`/device` + `/fixture`, fixture `type` 13 = fan, brightness 1–10000, direction as a boolean). That's **not supported yet**; a 404 from `/mf` logs that. Add it only with a real Gen 4 fan to verify against.

## Real fan behavior (verified; Gen 3, firmware 02.00.0043 and 02.00.0052)

- Responses take **0.3–1.4 s**. Responses include undocumented extra fields (`cloudPort`, `timezone`, `FrCodes`, `cdebug`, `feedbackToneMute`, `esp-idf-version`, `wifiSignal`, `SSID`, `BSSID`, `dimTableId`, ...). Parse leniently.
- Gen 3 `/config-read` reports Wi-Fi as `wifiSignal` (not the documented `Wi-Fi strength`).
- **The embedded web server can get stuck:** one fan (02.00.0043) answered ping (slowly, 100–240 ms) and mDNS but refused TCP port 80 for the whole session, and later stopped answering mDNS too. Home Assistant users report the same ([thread](https://community.home-assistant.io/t/modern-forms-fan-intermittently-unavailable-http-api-on-port-80-stops-responding/1024570)). A power cycle at the breaker or wall switch is the usual fix. The plugin shows "No Response" and recovers on its own when the fan answers again.
- mDNS answers to a legacy-unicast query (sent from an ephemeral port) arrive as one packet per fan with PTR, SRV, TXT and A records. `dns-sd -B` on macOS can miss fans for a few seconds; the plugin's own query found all of them.
- **Commands (verified 2026-10-30 on a Gen 3 fan, 02.00.0052):** the answer to a command already shows the new values, and a read 1.5 s later always matched. Commands usually take 0.5–1.3 s, but **turning the fan on took 2.5 s** (the motor spinning up), so keep the per-attempt timeout ≥ 4 s. Changing direction while spinning works.
- **`fanSpeed` alone doesn't start a stopped fan, and `lightBrightness` alone doesn't turn on a dark light.** Both just store the value. That's why a HomeKit speed/brightness write implies "on" (see below); without it, "set the fan to 50%" would do nothing on a stopped fan.
- `{"lightOn":true,"lightBrightness":10}` in one request works. Whether it visibly flashes at the old brightness first (aiomodernforms issue #99) needs someone watching the light. Brightness-first costs about 0.5 s, so the plugin keeps that order.

## HomeKit mapping (design)

- One accessory per fan: **Fanv2** (primary) with Active, RotationSpeed and RotationDirection, plus a **Lightbulb** named "<fan> Light" when `lightType` is non-empty. Category FAN.
- **Speed:** HomeKit percent ↔ 6 speeds: `percent = round(speed × 100 / 6)` (17/33/50/67/83/100) and `speed = clamp(round(percent × 6 / 100), 1, 6)`. After a write, the real value is pushed on the next tick: HAP stores the written value when `onSet` resolves, so pushing earlier gets overwritten.
- **Direction:** forward/summer = COUNTER_CLOCKWISE (blades push air down, seen from below); reverse/winter = CLOCKWISE.
- Speed > 0 implies fan on and brightness > 0 implies light on, unless the same batch has an explicit on/off (scenes send both). 0 % turns it off.
- **Writes are coalesced for 50 ms** into one command, because HomeKit sends On + Brightness (or Active + speed) as separate writes. Turning a dark light on with a brightness sends `{lightBrightness}` first, then `{lightOn:true}` (the aiomodernforms workaround for the flash; the fan accepts both orders).
- Status shown = last known status + unconfirmed writes on top, so a stale poll can't flip the tile back mid-command.

## Refresh model

- **On HomeKit read:** `onGet` answers instantly from cache and starts a background refresh on the next tick, throttled to one per fan per 5 s. Starting it after HAP's answer stops a fast result from being overwritten by the older value HAP returns.
- **Background check:** each fan is polled every `pollingIntervalSeconds` (default 60, min 10, 0 = off). It's a cheap local call, and fans are often changed with the remote, wall control or app.
- **Offline:** 2 consecutive failed requests → "No Response", a warning, and a rediscovery (the IP may have changed). Rediscovery runs at most once a minute and is deferred, not dropped, when throttled. The first success → "responding again".
- **Discovery:** at startup and every 5 min. Configured `hosts` are probed in the same pass, and unreachable new hosts are retried then (logged once per outage).

## Identity and lifecycle

- UUID = `uuid.generate("modernforms:" + MAC)` (MAC without separators, upper case), falling back to `clientId`. A new IP never creates a duplicate. Discovered fans with a known MAC are matched without any HTTP request.
- A fan that moves gets its new address. A **configured** address is only abandoned while it isn't answering.
- **Accessories are never removed automatically.** Fans are often powered off at the wall, and there's no authoritative list to compare against. Users remove stale ones in the Homebridge/HOOBS UI. Cached accessories without usable context are dropped at startup.
- Context: `info` (static data subset), `host`, `state` (last status, saved by Homebridge at shutdown).

## Deployment notes

See the trimlight-edge AGENTS.md for the HOOBS details. They apply here too: install from npm (HOOBS can't install local files), the HOOBS plugin directory indexes new packages with a delay, reboot the box if the settings form doesn't show, and the desktop settings page crashes for brand-new plugins (narrow the window). With this plugin there are no credentials to set, so the default config works even before the form shows.

- mDNS needs the HOOBS box on the same network segment as the fans. Otherwise list them under `hosts`, ideally with DHCP reservations.

## Status (update as work lands)

- 0.1.0 implemented: discovery, fan on/off, speed and direction, light on/off and brightness. Unit tests (98) and e2e are green on Homebridge 1.3.4 and 1.5.0 (Node 16), 1.11.4 and 2.4.0 (Node 22). Checks against the owner's real Gen 3 fans passed: discovery, static and dynamic data, and (with the owner's go-ahead) every command type, with the fan restored to its starting state afterwards.
- 0.1.0 published by the owner (2026-10-30). 0.1.1 adds the "How fans are found" explanation to the README and the settings screen (the owner asked how it could work without IP addresses; future users will too). Keep the form's header short and link to the README for details.
- 0.1.1 published by the owner. 0.1.2 adds the `hoobs-plugin` keyword (the owner's call, "just in case"). HOOBS had already indexed 0.1.0 with only `homebridge-plugin`, which is the keyword that matters; keep both.
- **Next:** publish 0.1.2 (owner runs `npm publish`), install on HOOBS, and run an on-phone checklist (tile, speed slider, direction, light, Siri, remote/wall-control change, power cut at the wall, restart).
- Later: breeze mode (maybe as Fanv2 SwingMode), sleep timers, away mode, Gen 4 support.
- Releasing a new version: bump `version` in package.json, verify (lint, test, e2e including against the packed tarball and the version matrix), commit, then the owner runs `npm publish` and pushes.
