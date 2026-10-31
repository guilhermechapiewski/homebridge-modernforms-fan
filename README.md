# homebridge-modernforms-fan

Control your [Modern Forms](https://modernforms.com/) smart ceiling fans (and their lights) from the Apple Home app and Siri, via Homebridge or HOOBS.

Every fan on your network appears in Apple Home as a **fan** with speed and direction, plus a **light** with brightness if it has a light kit. Everything happens over your local network: no cloud, no account, no API keys.

## Features

- Finds your fans automatically. Fans keep their Home setup when their IP address changes
- Fan on/off, the six speeds (as a percentage slider), and direction (summer/winter)
- Light on/off and brightness
- Works with Siri, scenes and automations
- Fast: the Home app gets an instant answer and the status refreshes in the background. Changes made with the remote, the wall control or the Modern Forms app show up within a minute, or as soon as you open the Home app
- Fans that stop answering show **No Response** instead of a wrong state, and recover on their own
- No runtime dependencies; works on the older Node.js/Homebridge versions found on HOOBS boxes

## Requirements

- Homebridge **1.3.0 or newer** (including 2.x), or HOOBS 4
- Node.js **14.18 or newer**
- Modern Forms or WAC smart fans of **Generation 1, 2 or 3**, already set up with the Modern Forms (or WAC) app and connected to your Wi-Fi. Generation 4 fans use a different API and aren't supported yet. If you have one, please open an issue.
- Homebridge on the **same network** as the fans for automatic discovery. If they're on different network segments, list the fans' addresses (see [How fans are found](#how-fans-are-found)).

## How fans are found

You don't need to know your fans' IP addresses. Once set up with the Modern Forms app, each fan announces itself on your home network using **mDNS** (Apple calls it Bonjour, the same thing that lets your iPhone find AirPlay speakers and printers). When the plugin starts, it:

1. sends one message to your network asking "is any Modern Forms fan out there?";
2. gets an answer from each fan with its MAC address (a hardware ID that never changes) and its current IP address;
3. asks each fan for the name you gave it in the Modern Forms app, its model, and whether it has a light, and adds it to Apple Home under that name.

The plugin recognizes each fan by its **MAC address**, not its IP address. If your router gives a fan a new IP, the plugin finds it at the new address and keeps the same accessory, so your rooms, scenes and automations are unaffected. It looks for fans again every 5 minutes, and right away when a fan stops answering, so new fans also show up on their own.

**When you need to list IP addresses:** mDNS messages only travel within one network segment. If Homebridge and your fans are on different networks (a separate VLAN, a guest network, or an access point that blocks device-to-device traffic), no fans are found. List the fans' IP addresses under **Fan addresses** (`hosts`) in that case. Your router's client list shows them, usually named `MF_Fan_XXXXXX`. Give them DHCP reservations in your router so the addresses stay fixed, since the plugin can't follow a listed fan to a new address it can't discover. You can also turn discovery off and rely only on the list.

To check that it worked, look at the Homebridge/HOOBS log right after a restart. Each fan gets a line like `Adding Living Room Fan (192.168.1.50)`.

## Installation

The plugin is published on npm as [`homebridge-modernforms-fan`](https://www.npmjs.com/package/homebridge-modernforms-fan).

- **HOOBS:** search for `homebridge-modernforms-fan` in the plugin search and install it. Putting it in its own bridge keeps it isolated from your other accessories. Over SSH, `sudo hbs plugin add homebridge-modernforms-fan` does the same. HOOBS only installs plugins from npm, not from local files.
- **Homebridge UI:** search for `homebridge-modernforms-fan` on the Plugins tab and install it.
- **Command line:** `sudo npm install -g homebridge-modernforms-fan`, then restart Homebridge.

To try unreleased changes from this repository on a regular Homebridge install, run `npm install && npm run build && npm pack`, then `sudo npm install -g ./homebridge-modernforms-fan-<version>.tgz`.

## Configuration

Nothing is required: add the platform and your fans are found automatically (see [How fans are found](#how-fans-are-found)). In the HOOBS/Homebridge UI, just save the settings form. In `config.json`, add this to the `platforms` section:

```json
{
  "platform": "ModernFormsFan",
  "name": "Modern Forms Fan"
}
```

| Field | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `platform` | Yes | | Must be `ModernFormsFan` |
| `discovery` | No | `true` | Find fans automatically (mDNS) |
| `hosts` | No | | List of fan IP addresses or host names to add even if they aren't found automatically, e.g. `["192.168.1.50"]`. Required when `discovery` is `false` |
| `pollingIntervalSeconds` | No | `60` | How often to check each fan for changes made outside Apple Home (minimum 10; `0` turns it off). Status is also refreshed whenever the Home app shows the fan |

After restarting you should see something like:

```
[Modern Forms Fan] Adding Living Room Fan (192.168.1.50)
```

Fans are named as in the Modern Forms app. You can rename them in the Home app.

## How it maps to Apple Home

| Apple Home | Fan |
| :--- | :--- |
| Fan on/off | Fan on/off (resumes its last speed) |
| Speed slider | The fan's 6 speeds: about 17 %, 33 %, 50 %, 67 %, 83 % and 100 %. Other values snap to the nearest speed |
| Rotation direction: counterclockwise | Forward / summer mode (air blows down) |
| Rotation direction: clockwise | Reverse / winter mode (air pulled up) |
| Light on/off, brightness | Light on/off, brightness 1–100 % |

The fan and its light show up as one tile. To get separate fan and light tiles, open the accessory's settings in the Home app and choose **Show as Separate Tiles**.

## Troubleshooting

- **No fans found:** make sure the fans work in the Modern Forms app, and that Homebridge is on the same network (not a guest or isolated IoT network) as the fans. Otherwise, list the fans' IP addresses under **Fan addresses** (see [How fans are found](#how-fans-are-found)).
- **A fan shows "No Response":** the fan stopped answering on the network. These fans' built-in web servers sometimes get stuck while the fan still works with its remote (the log says `... is not responding`). Turning the fan's power off and on at the wall switch or breaker fixes it, and the plugin picks it up again on its own.
- **A fan you replaced or removed still shows up:** the plugin never removes fans by itself, because a fan switched off at the wall looks the same as a removed one. Remove it under the cached accessories in the Homebridge/HOOBS settings.
- **HOOBS shows "0 plugins installed" / no settings form right after a release:** the HOOBS app takes plugin details from its own plugin directory, which picks up new npm releases with a delay, and caches the answer. The plugin still runs, and no settings are needed. **Reboot the HOOBS box** to make it check again.
- **HOOBS plugin settings page goes blank on desktop:** a HOOBS bug in its "Average Weekly Downloads" graph, which crashes for plugins without a year of download history. Make the window narrow, or use your phone, to get the mobile layout, which works.

For a closer look, `scripts/modernforms-cli.js` (in this repository, after `npm install && npm run build`) talks to fans directly: `discover`, `status <ip>`, `watch <ip>`.

## Development

```bash
npm install
npm run lint       # ESLint
npm test           # unit tests (real local HTTP/UDP servers + real HAP objects)
npm run test:e2e   # runs a real Homebridge instance against mock fans
```

`npm run test:e2e` starts Homebridge in insecure mode with the plugin, points it at two mock fans (`test/e2e/mockFan.js`, which mirrors a real fan's responses), and drives the accessories through the HAP HTTP API the same way the Home app does. Set `HOMEBRIDGE_BIN` to test another Homebridge install.

The fans' local API is documented by WAC in its "Smart Fans IP API Definition for 3rd Party Integrations". [aiomodernforms](https://github.com/wonderslug/aiomodernforms), the library behind Home Assistant's Modern Forms integration, keeps a copy and was a valuable reference.

Modern Forms and WAC are trademarks of WAC Lighting. This project isn't affiliated with or endorsed by them.
