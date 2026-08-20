// End-to-end ingest test without hardware: starts the server in HTTP mode,
// connects a fake producer + a fake camera, streams a real fragmented MP4 in
// chunks, stops, and verifies the finalized session file with ffprobe.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';

const execFileP = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 4533;

const FRAME_MEDIA = 2;

function encodeFrame(kind, sourceId, payload) {
  const id = Buffer.from(sourceId, 'utf8');
  return Buffer.concat([Buffer.from([kind, id.length]), id, payload]);
}

function connect(role, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    ws.on('error', reject);
    const messages = [];
    const waiters = [];
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString());
      const i = waiters.findIndex((w) => w.type === msg.type);
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
      else messages.push(msg);
    });
    const client = {
      ws,
      next(type, timeoutMs = 15000) {
        const i = messages.findIndex((m) => m.type === type);
        if (i >= 0) return Promise.resolve(messages.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), timeoutMs);
          waiters.push({ type, resolve: (m) => (clearTimeout(timer), res(m)) });
        });
      },
      send(obj) {
        ws.send(JSON.stringify(obj));
      },
    };
    ws.on('open', () => {
      client.send({ type: 'hello', role, name, kind: 'remote' });
      resolve(client);
    });
  });
}

async function main() {
  // 1. Generate a fragmented MP4 the way MediaRecorder produces one.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'filmstudie-test-'));
  const fmp4 = path.join(tmp, 'test.mp4');
  await execFileP('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    '-movflags', 'frag_keyframe+empty_moov',
    fmp4,
  ]);

  // 2. Start the server in HTTP test mode.
  const server = spawn('node', ['server/src/index.js'], {
    cwd: ROOT,
    env: { ...process.env, FILMSTUDIE_HTTP: '1', FILMSTUDIE_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await new Promise((r) => setTimeout(r, 800));

  try {
    // 3. Fake producer + fake camera.
    const producer = await connect('producer');
    await producer.next('hello-ack');
    const camera = await connect('camera', 'testcam');
    await camera.next('hello-ack');

    // 4. Record: stream the fMP4 in 64KB chunks with acks flowing back.
    producer.send({ type: 'record-start' });
    const start = await camera.next('record-start');
    const sessionId = start.sessionId;
    camera.send({ type: 'recording-started', serverStart: Date.now(), clockOffset: 0 });

    const data = fs.readFileSync(fmp4);
    for (let off = 0; off < data.length; off += 65536) {
      camera.ws.send(encodeFrame(FRAME_MEDIA, 'testcam', data.subarray(off, off + 65536)));
    }
    await new Promise((r) => setTimeout(r, 300));
    producer.send({ type: 'record-stop' });
    await producer.next('record-state'); // finalizing
    camera.send({ type: 'source-eof', sessionId });
    const done = await producer.next('record-state'); // idle
    if (done.state !== 'idle') throw new Error(`expected idle, got ${done.state}`);

    // 5. Verify the finalized file.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'sessions', sessionId, 'session.json'), 'utf8')
    );
    const src = manifest.sources.find((s) => s.id === 'testcam');
    if (src.status !== 'finalized') throw new Error(`source not finalized: ${JSON.stringify(src)}`);
    const outFile = path.join(ROOT, 'sessions', sessionId, src.file);
    const { stdout } = await execFileP('ffprobe', [
      '-v', 'error', '-show_format', '-show_streams', '-of', 'json', outFile,
    ]);
    const info = JSON.parse(stdout);
    const duration = Number(info.format.duration);
    const video = info.streams.find((s) => s.codec_type === 'video');
    if (!(duration > 3.5 && duration < 4.5)) throw new Error(`bad duration: ${duration}`);
    if (video.codec_name !== 'h264') throw new Error(`bad codec: ${video.codec_name}`);

    console.log(`\nPASS: session ${sessionId} finalized, ${src.file} h264 ${duration.toFixed(2)}s`);

    // 6. Clean up the test session.
    fs.rmSync(path.join(ROOT, 'sessions', sessionId), { recursive: true });
    producer.ws.close();
    camera.ws.close();
  } finally {
    server.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`\nFAIL: ${err.message}`);
  process.exit(1);
});
