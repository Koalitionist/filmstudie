import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { readManifest, sessionDir } from './sessions.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

let bundlePromise = null;
const rendering = new Set();

function ensureBundle() {
  bundlePromise ??= bundle({
    entryPoint: path.join(ROOT, 'video/src/index.ts'),
  });
  return bundlePromise;
}

// Build FilmProps from a session manifest. baseUrl points at a plain-HTTP
// origin serving /sessions (the render's headless browser fetches from it).
export function propsFromManifest(manifest, baseUrl) {
  const sources = manifest.sources
    .filter((s) => s.status === 'finalized' && s.file && s.recordStart && s.duration)
    .map((s) => ({
      id: s.id,
      src: `${baseUrl}/sessions/${manifest.id}/${s.file}`,
      recordStart: s.recordStart,
      duration: s.duration,
      rotation: s.rotation ?? 0,
    }));
  return {
    sources,
    cuts: manifest.cuts ?? [],
    audioSourceId: manifest.audioSource ?? sources[0]?.id ?? null,
    fps: manifest.fps ?? 30,
  };
}

export function isRendering(sessionId) {
  return rendering.has(sessionId);
}

const VALID_FORMATS = ['4:5', '9:16'];

export function outFileFor(format) {
  return `out-${format.replace(':', 'x')}.mp4`;
}

// Renders the same edit into one file per format (4:5 for feeds, 9:16 for
// Shorts/Reels) — only the canvas differs, the cuts are identical.
export async function renderSession(sessionId, { baseUrl, hub, formats, log = console.log }) {
  if (rendering.has(sessionId)) throw new Error('render already running for this session');
  const wanted = (formats?.length ? formats : VALID_FORMATS).filter((f) =>
    VALID_FORMATS.includes(f)
  );
  if (wanted.length === 0) throw new Error('no valid formats requested');
  rendering.add(sessionId);
  try {
    const manifest = readManifest(sessionId);
    const baseProps = propsFromManifest(manifest, baseUrl);
    if (baseProps.sources.length === 0) throw new Error('session has no usable sources');

    log(`render ${sessionId}: bundling composition...`);
    const serveUrl = await ensureBundle();

    const files = [];
    for (let i = 0; i < wanted.length; i++) {
      const format = wanted[i];
      const inputProps = { ...baseProps, format };
      const composition = await selectComposition({ serveUrl, id: 'Film', inputProps });
      log(
        `render ${sessionId} [${format}]: ${composition.durationInFrames} frames at ` +
          `${composition.width}x${composition.height}`
      );
      const file = outFileFor(format);
      let lastPct = -1;
      await renderMedia({
        composition,
        serveUrl,
        codec: 'h264',
        inputProps,
        outputLocation: path.join(sessionDir(sessionId), file),
        onProgress: ({ progress }) => {
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
        },
      });
      files.push(file);
      log(`render ${sessionId} [${format}]: done -> sessions/${sessionId}/${file}`);
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
