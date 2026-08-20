import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import express from 'express';
import qrcode from 'qrcode-terminal';
import { Hub } from './hub.js';
import { bonjourHost, lanIp } from './net.js';
import { isRendering, renderSession } from './render.js';
import {
  listSessions,
  readManifest,
  SESSIONS_DIR,
  sessionDir,
  writeManifest,
} from './sessions.js';

const PORT = Number(process.env.FILMSTUDIE_PORT ?? 4433);
const CA_PORT = Number(process.env.FILMSTUDIE_CA_PORT ?? 4434);
const HTTP_MODE = process.env.FILMSTUDIE_HTTP === '1'; // tests / trusted-LAN debugging only

const ROOT = path.resolve(import.meta.dirname, '../..');
const CERTS = path.join(ROOT, 'server/certs');
const STUDIO_DIST = path.join(ROOT, 'studio/dist');

const app = express();
app.use(express.json());

app.get('/api/sessions', (req, res) => res.json(listSessions()));
app.get('/api/sessions/:id', (req, res) => {
  try {
    res.json(readManifest(req.params.id));
  } catch {
    res.status(404).json({ error: 'not found' });
  }
});
app.post('/api/sessions/:id/edit', (req, res) => {
  try {
    const manifest = readManifest(req.params.id);
    const { cuts, audioSource, rotations } = req.body ?? {};
    if (Array.isArray(cuts)) manifest.cuts = cuts;
    if (audioSource !== undefined) manifest.audioSource = audioSource;
    if (rotations && typeof rotations === 'object') {
      for (const src of manifest.sources) {
        if (typeof rotations[src.id] === 'number') src.rotation = rotations[src.id];
      }
    }
    writeManifest(manifest);
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'not found' });
  }
});
app.post('/api/sessions/:id/render', (req, res) => {
  const id = req.params.id;
  if (isRendering(id)) {
    res.status(409).json({ error: 'render already running' });
    return;
  }
  // The headless render browser fetches footage over plain HTTP (it won't
  // trust the mkcert cert): the CA helper server in HTTPS mode, the main
  // server in HTTP mode.
  const baseUrl = HTTP_MODE ? `http://127.0.0.1:${PORT}` : `http://127.0.0.1:${CA_PORT}`;
  const formats = Array.isArray(req.body?.formats) ? req.body.formats : undefined;
  renderSession(id, { baseUrl, hub, formats }).catch((err) =>
    console.error(`render ${id} failed: ${err.message}`)
  );
  res.json({ ok: true });
});
app.post('/api/reveal', (req, res) => {
  const { sessionId } = req.body ?? {};
  try {
    execFile('open', [sessionDir(sessionId)]);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.use('/sessions', express.static(SESSIONS_DIR));
app.use(express.static(STUDIO_DIST));
// SPA fallback for /producer, /camera, /edit
app.get(/^\/(producer|camera|edit)?$/, (req, res) => {
  res.sendFile(path.join(STUDIO_DIST, 'index.html'));
});

const hub = new Hub();

function startMain() {
  if (HTTP_MODE) {
    const server = http.createServer(app);
    hub.attach(server);
    server.listen(PORT, () => console.log(`[filmstudie] HTTP mode on http://localhost:${PORT}`));
    return;
  }
  const certFile = path.join(CERTS, 'cert.pem');
  const keyFile = path.join(CERTS, 'key.pem');
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    console.error('\nNo TLS certs found in server/certs/.');
    console.error('Run once:  npm run setup\n');
    process.exit(1);
  }
  const server = https.createServer(
    { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) },
    app
  );
  hub.attach(server);
  server.listen(PORT, () => banner());
}

// Plain-HTTP helper server: lets iPhone/iPad download the mkcert root CA
// before they can trust the HTTPS app.
function startCaServer() {
  const caFile = path.join(CERTS, 'rootCA.pem');
  if (!fs.existsSync(caFile)) return;
  const caApp = express();
  // Also serves session footage over plain HTTP for the render's headless browser.
  caApp.use('/sessions', express.static(SESSIONS_DIR));
  caApp.get('/rootCA.pem', (req, res) => {
    res.set('Content-Type', 'application/x-x509-ca-cert');
    res.set('Content-Disposition', 'attachment; filename="filmstudie-rootCA.pem"');
    res.send(fs.readFileSync(caFile));
  });
  caApp.get('/', (req, res) => {
    res.send(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
<body style="font-family:-apple-system,sans-serif;max-width:34em;margin:2em auto;padding:0 1em;line-height:1.5">
<h2>filmstudie — one-time device setup</h2>
<ol>
<li><a href="/rootCA.pem">Download the root certificate</a> (choose "Allow")</li>
<li>Settings &rarr; <b>Profile Downloaded</b> &rarr; Install</li>
<li>Settings &rarr; General &rarr; About &rarr; <b>Certificate Trust Settings</b> &rarr; enable full trust for <b>mkcert</b></li>
<li>Open <b>https://${bonjourHost()}:${PORT}/camera</b></li>
</ol></body>`);
  });
  http.createServer(caApp).listen(CA_PORT);
}

function banner() {
  const host = bonjourHost();
  const producerUrl = `https://${host}:${PORT}/producer`;
  const cameraUrl = `https://${host}:${PORT}/camera`;
  console.log('\n  filmstudie studio is up\n');
  console.log(`  Producer (this Mac):  ${producerUrl}`);
  console.log(`  Cameras (iPhone/iPad Safari): ${cameraUrl}\n`);
  qrcode.generate(cameraUrl, { small: true }, (qr) => console.log(qr));
  const setupUrl = `http://${lanIp()}:${CA_PORT}/`;
  console.log(`  First time on a device? Scan this to install the certificate (${setupUrl}):\n`);
  qrcode.generate(setupUrl, { small: true }, (qr) => console.log(qr));
  console.log('  See README for the 30-second walkthrough.\n');
}

startMain();
if (!HTTP_MODE) startCaServer();
