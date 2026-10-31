'use strict';
/**
 * A mock Generation 3 fan for the e2e test: speaks the same /mf protocol and
 * answers with the same fields as a real fan (firmware 02.00.0052), with
 * placeholder identity data.
 */
const http = require('http');

function createMockFan({ mac, name, light = true }) {
  const hex = mac.replace(/:/g, '').toUpperCase();
  const state = {
    info: {
      clientId: `MF_${hex}`, mac, lightType: light ? 'F4IN-120V-R1-30' : '', fanType: '1801-60', fanMotorType: 'DC125X30',
      brand: 1, dateCode: '2024-01-01', owner: 'owner@example.com', federatedIdentity: 'us-east-1:example', deviceName: name,
      firmwareVersion: '02.00.0052', 'esp-idf-version': '4.0.4', mainMcuFirmwareVersion: '03.00.0000', firmwareUrl: '',
      wifiSignal: '-55', SSID: 'example', BSSID: '0x000000000000', isUvcFan: false, built: 'realHardware', dimTableId: 1, elecFreq: 60,
    },
    dynamic: {
      clientId: `MF_${hex}`, cloudPort: 8883, lightOn: false, fanOn: false, lightBrightness: 100, fanSpeed: 6,
      fanDirection: 'forward', wind: false, windSpeed: 2, rfPairModeActive: false, resetRfPairList: false, factoryReset: false,
      awayModeEnabled: false, fanTimer: 0, lightTimer: 0, decommission: false, schedule: '', adaptiveLearning: false,
      userData: 'none', timezone: 'UTC', FrCodes: 'Hxxxxxxxxxxxxxx', cdebug: false, feedbackToneMute: false,
    },
    /** Every request body, in order. */
    requests: [],
    /** When true the fan accepts connections but never answers (its web server is stuck). */
    stuck: false,
  };
  const settable = ['fanOn', 'fanSpeed', 'fanDirection', 'lightOn', 'lightBrightness', 'wind', 'windSpeed'];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (state.stuck) {
        return;
      }
      if (req.method !== 'POST' || req.url !== '/mf') {
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.statusCode = 400;
        res.end('Bad Request');
        return;
      }
      state.requests.push(body);
      res.setHeader('Content-Type', 'application/json');
      if (body.queryStaticShadowData === 1) {
        res.end(JSON.stringify(state.info));
        return;
      }
      if (body.queryDynamicShadowData !== 1) {
        for (const key of settable) {
          if (key in body) {
            state.dynamic[key] = body[key];
          }
        }
        state.dynamic.userData = 'local_wifi';
      }
      res.end(JSON.stringify(state.dynamic));
    });
  });
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const close = () => new Promise((resolve) => {
    for (const socket of sockets) {
      socket.destroy();
    }
    server.close(() => resolve());
  });
  return { server, state, close };
}

module.exports = { createMockFan };
