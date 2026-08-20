// Dev tool: connect a fake camera to the hub and stream preview frames, so
// the producer grid can be exercised without physical devices.
//
//   node scripts/fake-camera.mjs --name topdown [--video path.mp4] [--port 4533] [--rotation 180]
//
// With --video, preview frames come from that file; otherwise an ffmpeg test
// pattern is used. Preview-only: it joins the roster and streams JPEGs, but
// does not record.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const FRAME_PREVIEW = 1;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const name = arg('name', 'fakecam');
const video = arg('video', null);
const port = arg('port', '4533');
const rotation = Number(arg('rotation', '0'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `fakecam-${name}-`));
const input = video
  ? ['-i', video]
  : ['-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30,drawtext=text='${name}':fontsize=64:fontcolor=white:x=(w-tw)/2:y=(h-th)/2`];
execFileSync('ffmpeg', ['-v', 'error', ...input, '-vf', 'fps=5,scale=640:-2', '-q:v', '5', '-frames:v', '50', path.join(tmp, 'f%03d.jpg')]);
const frames = fs
  .readdirSync(tmp)
  .sort()
  .map((f) => fs.readFileSync(path.join(tmp, f)));
console.log(`[${name}] ${frames.length} preview frames ready`);

function encodeFrame(kind, sourceId, payload) {
  const id = Buffer.from(sourceId, 'utf8');
  return Buffer.concat([Buffer.from([kind, id.length]), id, payload]);
}

const ws = new WebSocket(`ws://localhost:${port}/ws`);
let sourceId = name;
ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'camera', name, kind: 'remote', rotation })));
ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  const msg = JSON.parse(data.toString());
  if (msg.type === 'hello-ack') {
    sourceId = msg.sourceId;
    console.log(`[${name}] joined as ${sourceId}`);
  }
});
let i = 0;
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(encodeFrame(FRAME_PREVIEW, sourceId, frames[i++ % frames.length]));
  }
}, 200);
