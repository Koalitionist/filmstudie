import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { readManifest, sessionDir } from './sessions.js';
import { buildTimeline } from './timeline.js';

const execFileP = promisify(execFile);

// Pure-ffmpeg render of a session: same semantics as the Remotion composition
// (hard cuts, rotation, cover-crop, one continuous audio track) but rendered
// natively — hardware-encoded via VideoToolbox where available, so a clip
// renders in seconds rather than realtime.

const FORMATS = {
  '4:5': { width: 1080, height: 1350 },
  '9:16': { width: 1080, height: 1920 },
};

const rendering = new Set();

export function isFfmpegRendering(sessionId) {
  return rendering.has(sessionId);
}

export function outFileFor(format) {
  return `out-${format.replace(':', 'x')}.mp4`;
}

function rotationFilter(rotation) {
  const rot = ((rotation % 360) + 360) % 360;
  if (rot === 90) return 'transpose=1,';
  if (rot === 180) return 'hflip,vflip,';
  if (rot === 270) return 'transpose=2,';
  return '';
}

// Phones store display rotation as stream side data, and ffmpeg does not
// apply it when streams feed a filter_complex graph — so read it and apply
// it ourselves (on top of the user-set rotation), with autorotate disabled.
async function probeDisplayRotation(file) {
  const { stdout } = await execFileP('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', file,
  ]);
  const stream = JSON.parse(stdout).streams?.[0];
  let sideRotation = 0;
  for (const sd of stream?.side_data_list ?? []) {
    if (typeof sd.rotation === 'number') sideRotation = sd.rotation;
  }
  // side data is counter-clockwise; convert to the clockwise display rotation
  return ((-sideRotation % 360) + 360) % 360;
}

function editFromManifest(manifest) {
  const sources = manifest.sources
    .filter((s) => s.status === 'finalized' && s.file && s.recordStart && s.duration)
    .map((s) => ({
      id: s.id,
      file: s.file,
      recordStart: s.recordStart,
      duration: s.duration,
      rotation: s.rotation ?? 0,
    }));
  const fps = manifest.fps ?? 30;
  const timeline = buildTimeline({ sources, cuts: manifest.cuts ?? [], fps });
  const audioId = manifest.audioSource ?? sources[0]?.id ?? null;
  return { sources, fps, timeline, audio: sources.find((s) => s.id === audioId) ?? sources[0] };
}

function buildArgs(manifest, format, encoder, displayRotations) {
  const { width: W, height: H } = FORMATS[format];
  const { sources, fps, timeline, audio } = editFromManifest(manifest);
  const dir = sessionDir(manifest.id);
  const totalSec = timeline.durationInFrames / fps;
  const srcOf = (id) => sources.find((s) => s.id === id);

  const args = ['-y', '-hide_banner', '-nostats', '-progress', 'pipe:1'];
  const filters = [];
  const concatIns = [];

  // One trimmed input per segment: input-level -ss/-t is frame-accurate when
  // re-encoding and keeps the filter graph trivial.
  timeline.segments.forEach((seg, i) => {
    const src = srcOf(seg.sourceId);
    const startSec = (timeline.trim[src.id] + seg.start) / fps;
    const durSec = seg.len / fps;
    // -display_rotation 0 declares the input rotation-free: it disables
    // autorotation AND prevents the display-matrix side data from propagating
    // into the output (which would make players re-rotate our correct pixels).
    // We apply the probed display rotation + user rotation explicitly below.
    args.push(
      '-display_rotation', '0',
      '-ss', startSec.toFixed(3), '-t', durSec.toFixed(3), '-i', path.join(dir, src.file)
    );
    const rotation = (displayRotations.get(src.id) ?? 0) + src.rotation;
    filters.push(
      `[${i}:v]${rotationFilter(rotation)}fps=${fps},` +
        `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
        `setsar=1,format=yuv420p,setpts=PTS-STARTPTS[s${i}]`
    );
    concatIns.push(`[s${i}]`);
  });

  // The audio source runs continuously across cuts.
  const audioIdx = timeline.segments.length;
  const audioStart = (timeline.trim[audio.id] ?? 0) / fps;
  args.push('-ss', audioStart.toFixed(3), '-t', totalSec.toFixed(3), '-i', path.join(dir, audio.file));

  filters.push(`${concatIns.join('')}concat=n=${timeline.segments.length}:v=1:a=0[v]`);
  filters.push(`[${audioIdx}:a]aresample=48000,apad[a]`);

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[v]', '-map', '[a]',
    ...encoder,
    '-c:a', 'aac', '-b:a', '160k',
    '-t', totalSec.toFixed(3),
    '-movflags', '+faststart',
    path.join(dir, outFileFor(format))
  );
  return { args, totalSec };
}

const ENCODERS = [
  ['-c:v', 'h264_videotoolbox', '-b:v', '10M', '-r', '30'],
  ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-r', '30'],
];

function runFfmpeg(args, totalSec, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    proc.stdout.on('data', (d) => {
      const m = String(d).match(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m) {
        const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        onProgress(Math.min(1, sec / totalSec));
      }
    });
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-600)}`))
    );
    proc.on('error', reject);
  });
}

const VALID_FORMATS = Object.keys(FORMATS);

export async function renderSessionFfmpeg(sessionId, { hub, formats, log = console.log }) {
  if (rendering.has(sessionId)) throw new Error('render already running for this session');
  const wanted = (formats?.length ? formats : VALID_FORMATS).filter((f) =>
    VALID_FORMATS.includes(f)
  );
  if (wanted.length === 0) throw new Error('no valid formats requested');
  rendering.add(sessionId);
  try {
    const manifest = readManifest(sessionId);
    const edit = editFromManifest(manifest);
    if (edit.sources.length === 0) {
      throw new Error('session has no usable sources');
    }
    const displayRotations = new Map();
    for (const src of edit.sources) {
      displayRotations.set(
        src.id,
        await probeDisplayRotation(path.join(sessionDir(sessionId), src.file))
      );
    }
    const files = [];
    for (let i = 0; i < wanted.length; i++) {
      const format = wanted[i];
      const t0 = Date.now();
      let lastPct = -1;
      const emit = (progress) => {
        const pct = Math.round(progress * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          hub.broadcastProducers({
            type: 'render-progress',
            sessionId,
            format,
            index: i,
            total: wanted.length,
            progress,
          });
        }
      };
      let done = false;
      for (const encoder of ENCODERS) {
        const { args, totalSec } = buildArgs(manifest, format, encoder, displayRotations);
        if (process.env.FILMSTUDIE_DEBUG) log(`ffmpeg ${args.join(' ')}`);
        try {
          await runFfmpeg(args, totalSec, emit);
          done = true;
          log(
            `render ${sessionId} [${format}]: ${totalSec.toFixed(1)}s of video in ` +
              `${((Date.now() - t0) / 1000).toFixed(1)}s (${encoder[1]})`
          );
          break;
        } catch (err) {
          if (encoder === ENCODERS[ENCODERS.length - 1]) throw err;
          log(`render ${sessionId} [${format}]: ${encoder[1]} failed, falling back`);
        }
      }
      if (done) files.push(outFileFor(format));
    }
    hub.broadcastProducers({ type: 'render-done', sessionId, files });
    return files;
  } catch (err) {
    hub.broadcastProducers({ type: 'render-error', sessionId, message: err.message });
    throw err;
  } finally {
    rendering.delete(sessionId);
  }
}
