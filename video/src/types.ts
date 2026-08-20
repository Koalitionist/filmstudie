export interface EditSource {
  id: string;
  src: string; // URL of the finalized file (relative in the browser, absolute for renders)
  recordStart: number; // server-clock ms when this source's recorder started
  duration: number; // seconds
  rotation?: number; // 0 | 90 | 180 | 270, clockwise
}

export interface Cut {
  atFrame: number;
  sourceId: string;
}

export const FORMATS = {
  '4:5': { width: 1080, height: 1350 }, // Instagram/LinkedIn feed
  '9:16': { width: 1080, height: 1920 }, // YouTube Shorts / Reels
} as const;

export type FilmFormat = keyof typeof FORMATS;

// A type alias (not an interface) so it satisfies Remotion's
// `Props extends Record<string, unknown>` constraint on Player/Composition.
export type FilmProps = {
  sources: EditSource[];
  cuts: Cut[];
  audioSourceId: string | null;
  fps: number;
  format?: FilmFormat;
};

export interface Segment {
  start: number;
  len: number;
  sourceId: string;
}

export interface Timeline {
  durationInFrames: number;
  /** frames to trim from each source's start so frame 0 is the same instant everywhere */
  trim: Record<string, number>;
  segments: Segment[];
}

// Timeline zero = the moment every camera was rolling; end = the first camera
// to stop. Within that window all sources cover every frame.
export function buildTimeline(props: FilmProps): Timeline {
  const { sources, cuts, fps } = props;
  if (sources.length === 0) {
    return { durationInFrames: 1, trim: {}, segments: [] };
  }
  const t0 = Math.max(...sources.map((s) => s.recordStart));
  const end = Math.min(...sources.map((s) => s.recordStart + s.duration * 1000));
  const durationInFrames = Math.max(1, Math.floor(((end - t0) / 1000) * fps));

  const trim: Record<string, number> = {};
  for (const s of sources) {
    trim[s.id] = Math.max(0, Math.round(((t0 - s.recordStart) / 1000) * fps));
  }

  const ids = new Set(sources.map((s) => s.id));
  const valid = cuts
    .filter((c) => ids.has(c.sourceId) && c.atFrame >= 0 && c.atFrame < durationInFrames)
    .sort((a, b) => a.atFrame - b.atFrame);

  // Cut points, deduped by frame (last one wins), with an implicit opening cut.
  const byFrame = new Map<number, string>();
  byFrame.set(0, sources[0].id);
  for (const c of valid) byFrame.set(c.atFrame, c.sourceId);
  const points = [...byFrame.entries()].sort((a, b) => a[0] - b[0]);

  const segments: Segment[] = [];
  for (let i = 0; i < points.length; i++) {
    const [start, sourceId] = points[i];
    const next = points[i + 1]?.[0] ?? durationInFrames;
    if (next > start) segments.push({ start, len: next - start, sourceId });
  }
  return { durationInFrames, trim, segments };
}
