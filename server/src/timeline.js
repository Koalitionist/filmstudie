// JS mirror of video/src/types.ts buildTimeline — keep the two in sync.
// Timeline zero = the moment every camera was rolling; end = the first camera
// to stop. Within that window all sources cover every frame.
export function buildTimeline({ sources, cuts, fps }) {
  if (sources.length === 0) {
    return { durationInFrames: 1, trim: {}, segments: [] };
  }
  const t0 = Math.max(...sources.map((s) => s.recordStart));
  const end = Math.min(...sources.map((s) => s.recordStart + s.duration * 1000));
  const durationInFrames = Math.max(1, Math.floor(((end - t0) / 1000) * fps));

  const trim = {};
  for (const s of sources) {
    trim[s.id] = Math.max(0, Math.round(((t0 - s.recordStart) / 1000) * fps));
  }

  const ids = new Set(sources.map((s) => s.id));
  const valid = (cuts ?? [])
    .filter((c) => ids.has(c.sourceId) && c.atFrame >= 0 && c.atFrame < durationInFrames)
    .sort((a, b) => a.atFrame - b.atFrame);

  const byFrame = new Map();
  byFrame.set(0, sources[0].id);
  for (const c of valid) byFrame.set(c.atFrame, c.sourceId);
  const points = [...byFrame.entries()].sort((a, b) => a[0] - b[0]);

  const segments = [];
  for (let i = 0; i < points.length; i++) {
    const [start, sourceId] = points[i];
    const next = points[i + 1]?.[0] ?? durationInFrames;
    if (next > start) segments.push({ start, len: next - start, sourceId });
  }
  return { durationInFrames, trim, segments };
}
