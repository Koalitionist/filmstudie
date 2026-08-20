import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const SESSIONS_DIR = path.resolve(import.meta.dirname, '../../sessions');

export function newSessionId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

export function sessionDir(id) {
  if (!/^[\w-]+$/.test(id)) throw new Error(`bad session id: ${id}`);
  return path.join(SESSIONS_DIR, id);
}

export function createSession(id) {
  const dir = sessionDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    id,
    createdAt: new Date().toISOString(),
    fps: 30,
    width: 1080,
    height: 1350,
    sources: [],
    cuts: [],
    audioSource: null,
  };
  writeManifest(manifest);
  return manifest;
}

export function readManifest(id) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir(id), 'session.json'), 'utf8'));
}

export function writeManifest(manifest) {
  const file = path.join(sessionDir(manifest.id), 'session.json');
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
}

export function listSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs
    .readdirSync(SESSIONS_DIR)
    .filter((name) => fs.existsSync(path.join(SESSIONS_DIR, name, 'session.json')))
    .sort()
    .reverse()
    .map((name) => readManifest(name));
}

export function rawChunkPath(id, sourceId) {
  return path.join(sessionDir(id), `${sourceId}.raw`);
}

async function probe(file) {
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error',
    '-show_streams', '-show_format',
    '-of', 'json',
    file,
  ]);
  return JSON.parse(stdout);
}

// The concatenated MediaRecorder output is a valid stream but lacks duration
// metadata and seekability; a -c copy remux fixes both. Container is chosen
// by codec: H.264 goes to mp4, VP8/9/AV1 stays webm.
export async function finalizeSource(id, sourceId) {
  const raw = rawChunkPath(id, sourceId);
  if (!fs.existsSync(raw) || fs.statSync(raw).size === 0) {
    throw new Error('no media data received from this source (recorder produced nothing)');
  }
  const info = await probe(raw);
  const video = info.streams.find((s) => s.codec_type === 'video');
  const codec = video?.codec_name ?? 'unknown';
  const ext = codec === 'h264' || codec === 'hevc' ? 'mp4' : 'webm';
  const outName = `${sourceId}.${ext}`;
  const out = path.join(sessionDir(id), outName);
  const args = ['-y', '-i', raw, '-c', 'copy'];
  if (ext === 'mp4') args.push('-movflags', '+faststart');
  args.push(out);
  await execFileP('ffmpeg', args);
  const finalInfo = await probe(out);
  fs.unlinkSync(raw);
  return {
    file: outName,
    codec,
    width: video?.width ?? null,
    height: video?.height ?? null,
    duration: Number(finalInfo.format?.duration ?? 0),
  };
}
