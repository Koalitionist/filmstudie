import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildTimeline,
  Cut,
  EditSource,
  FilmFormat,
  FilmProps,
  FORMATS,
} from '../../../video/src/types';
import { Json, StudioSocket } from '../lib/ws';

interface ManifestSource {
  id: string;
  name: string;
  kind: string;
  file: string | null;
  status: string;
  recordStart: number | null;
  duration?: number;
  rotation?: number;
}

interface Manifest {
  id: string;
  fps?: number;
  sources: ManifestSource[];
  cuts?: Cut[];
  audioSource?: string | null;
}

const ANGLE_COLORS = ['#5b9dff', '#3dd68c', '#f5a623', '#e5484d', '#b98aff', '#4dd0e1'];

export default function Edit() {
  const sessionId = new URLSearchParams(location.search).get('session');
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [sessions, setSessions] = useState<Manifest[] | null>(null);

  useEffect(() => {
    if (sessionId) {
      void fetch(`/api/sessions/${sessionId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then(setManifest);
    } else {
      void fetch('/api/sessions')
        .then((r) => r.json())
        .then(setSessions);
    }
  }, [sessionId]);

  if (!sessionId) return <SessionPicker sessions={sessions} />;
  if (!manifest) {
    return (
      <div className="center-card" style={{ margin: 'auto' }}>
        <p className="hint">Loading session…</p>
      </div>
    );
  }
  return <Editor manifest={manifest} />;
}

function SessionPicker({ sessions }: { sessions: Manifest[] | null }) {
  return (
    <div className="center-card" style={{ margin: 'auto' }}>
      <h1>Edit a session</h1>
      {!sessions && <p className="hint">Loading…</p>}
      {sessions?.length === 0 && <p className="hint">No sessions yet — record one in the producer.</p>}
      {sessions?.map((m) => (
        <a key={m.id} href={`/edit?session=${m.id}`}>
          <button style={{ width: '100%' }}>
            {m.id} — {m.sources.map((s) => s.id).join(', ')}
          </button>
        </a>
      ))}
      <a href="/producer">
        <button style={{ width: '100%' }}>← Producer</button>
      </a>
    </div>
  );
}

function Editor({ manifest }: { manifest: Manifest }) {
  const fps = manifest.fps ?? 30;
  const [rotations, setRotations] = useState<Record<string, number>>(() =>
    Object.fromEntries(manifest.sources.map((s) => [s.id, s.rotation ?? 0]))
  );
  const sources: EditSource[] = useMemo(
    () =>
      manifest.sources
        .filter((s) => s.status === 'finalized' && s.file && s.recordStart && s.duration)
        .map((s) => ({
          id: s.id,
          src: `/sessions/${manifest.id}/${s.file}`,
          recordStart: s.recordStart!,
          duration: s.duration!,
          rotation: rotations[s.id] ?? 0,
        })),
    [manifest, rotations]
  );

  const [cuts, setCuts] = useState<Cut[]>(manifest.cuts ?? []);
  const [audioSourceId, setAudioSourceId] = useState<string | null>(
    manifest.audioSource ?? sources[0]?.id ?? null
  );
  const [format, setFormat] = useState<FilmFormat>('4:5');
  const [render, setRender] = useState<{
    state: 'idle' | 'running' | 'done' | 'error';
    progress: number;
    format?: string;
    files?: string[];
    message?: string;
  }>({ state: 'idle', progress: 0 });

  const props: FilmProps = useMemo(
    () => ({ sources, cuts, audioSourceId, fps, format }),
    [sources, cuts, audioSourceId, fps, format]
  );
  const timeline = useMemo(() => buildTimeline(props), [props]);
  const total = timeline.durationInFrames;

  // ---- transport: our own playback clock (no media element drives time) ----
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState(0);
  const frameRef = useRef(0);
  const playClock = useRef<{ t: number; f: number } | null>(null);

  const setFrameBoth = useCallback((f: number) => {
    frameRef.current = f;
    setFrame(f);
  }, []);

  const seekTo = useCallback(
    (f: number) => {
      const clamped = Math.max(0, Math.min(total - 1, f));
      if (playClock.current) playClock.current = { t: performance.now(), f: clamped };
      setFrameBoth(clamped);
    },
    [total, setFrameBoth]
  );

  const toggle = useCallback(() => {
    setPlaying((p) => {
      if (!p && frameRef.current >= total - 1) setFrameBoth(0);
      return !p;
    });
  }, [total, setFrameBoth]);

  useEffect(() => {
    if (!playing) {
      playClock.current = null;
      return;
    }
    playClock.current = { t: performance.now(), f: frameRef.current };
    let raf = 0;
    const tick = () => {
      const c = playClock.current;
      if (!c) return;
      const f = c.f + ((performance.now() - c.t) / 1000) * fps;
      if (f >= total - 1) {
        setFrameBoth(total - 1);
        setPlaying(false);
        return;
      }
      setFrameBoth(f);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, fps, total, setFrameBoth]);

  // Registry of the angle-tile <video> elements. The program canvas draws
  // from these directly — no extra media streams (Chrome allows only 6
  // concurrent connections per origin, and long sessions have big files).
  const videoEls = useRef(new Map<string, HTMLVideoElement>());

  // ---- undo history for cut operations (Cmd/Ctrl+Z) ----
  const history = useRef<Cut[][]>([]);
  const pushHistory = useCallback((current: Cut[]) => {
    history.current.push(current);
    if (history.current.length > 100) history.current.shift();
  }, []);
  const updateCuts = useCallback(
    (next: Cut[]) => {
      pushHistory(cuts);
      setCuts(next);
    },
    [cuts, pushHistory]
  );
  const undo = useCallback(() => {
    const prev = history.current.pop();
    if (prev) setCuts(prev);
  }, []);

  // auto-save cuts + audio + rotations (debounced)
  const firstSave = useRef(true);
  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false;
      return;
    }
    const t = window.setTimeout(() => {
      void fetch(`/api/sessions/${manifest.id}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cuts, audioSource: audioSourceId, rotations }),
      });
    }, 600);
    return () => window.clearTimeout(t);
  }, [cuts, audioSourceId, rotations, manifest.id]);

  // render progress over the hub socket
  useEffect(() => {
    const socket = new StudioSocket();
    socket.onOpen(() => socket.send({ type: 'hello', role: 'producer' } as Json));
    socket.on('render-progress', (msg) => {
      if (msg.sessionId === manifest.id)
        setRender({
          state: 'running',
          progress: msg.progress as number,
          format: msg.format as string,
        });
    });
    socket.on('render-done', (msg) => {
      if (msg.sessionId === manifest.id)
        setRender({ state: 'done', progress: 1, files: msg.files as string[] });
    });
    socket.on('render-error', (msg) => {
      if (msg.sessionId === manifest.id)
        setRender({ state: 'error', progress: 0, message: msg.message as string });
    });
    socket.connect();
    return () => socket.close();
  }, [manifest.id]);

  const activeSourceAt = useCallback(
    (f: number) => {
      let active = timeline.segments[0]?.sourceId ?? null;
      for (const seg of timeline.segments) {
        if (seg.start <= f) active = seg.sourceId;
        else break;
      }
      return active;
    },
    [timeline]
  );

  const addCut = useCallback(
    (sourceId: string) => {
      const f = Math.round(frameRef.current);
      if (activeSourceAt(f) === sourceId) return;
      updateCuts([...cuts.filter((c) => c.atFrame !== f), { atFrame: f, sourceId }]);
    },
    [activeSourceAt, cuts, updateCuts]
  );

  const deleteCutAtPlayhead = useCallback(() => {
    const f = frameRef.current;
    const containing = [...cuts]
      .sort((a, b) => a.atFrame - b.atFrame)
      .filter((c) => c.atFrame <= f)
      .pop();
    if (containing) updateCuts(cuts.filter((c) => c !== containing));
  }, [cuts, updateCuts]);

  // Live boundary drag: history is pushed once at drag start, not per move.
  const moveCut = useCallback(
    (fromFrame: number, toFrame: number): number | null => {
      const sorted = [...cuts].sort((a, b) => a.atFrame - b.atFrame);
      const idx = sorted.findIndex((c) => c.atFrame === fromFrame);
      if (idx < 0) return null;
      const min = idx > 0 ? sorted[idx - 1].atFrame + 1 : 1;
      const max = idx < sorted.length - 1 ? sorted[idx + 1].atFrame - 1 : total - 1;
      const clamped = Math.max(min, Math.min(max, toFrame));
      if (clamped === fromFrame) return fromFrame;
      setCuts(cuts.map((c) => (c.atFrame === fromFrame ? { ...c, atFrame: clamped } : c)));
      return clamped;
    },
    [cuts, total]
  );

  // keyboard: 1..9 switch, space play/pause, arrows step, backspace delete cut
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT') return;
      const idx = parseInt(e.key, 10);
      if (idx >= 1 && idx <= sources.length) {
        addCut(sources[idx - 1].id);
      } else if (e.key === ' ') {
        e.preventDefault();
        toggle();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowLeft' ? -1 : 1);
        seekTo(Math.round(frameRef.current) + step);
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        deleteCutAtPlayhead();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sources, addCut, deleteCutAtPlayhead, undo, toggle, seekTo]);

  if (sources.length === 0) {
    return (
      <div className="center-card" style={{ margin: 'auto' }}>
        <h1>{manifest.id}</h1>
        <p className="hint">This session has no usable footage.</p>
        <a href="/edit">
          <button>← Sessions</button>
        </a>
      </div>
    );
  }

  const colorOf = (id: string) =>
    ANGLE_COLORS[sources.findIndex((s) => s.id === id) % ANGLE_COLORS.length];
  const activeId = activeSourceAt(frame);
  const activeSource = sources.find((s) => s.id === activeId) ?? null;
  const audioSource = sources.find((s) => s.id === audioSourceId) ?? sources[0];

  return (
    <div className="edit-page">
      <header className="producer-header">
        <a href="/edit">
          <button>←</button>
        </a>
        <h1>{manifest.id}</h1>
        <button onClick={toggle}>{playing ? '❚❚' : '▶'}</button>
        <span className="kind">
          {formatFrame(frame, fps)} / {formatFrame(total, fps)}
        </span>
        <span className="spacer" />
        <label className="kind">
          audio&nbsp;
          <select
            value={audioSourceId ?? ''}
            onChange={(e) => setAudioSourceId(e.target.value || null)}
          >
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </select>
        </label>
        <button disabled={cuts.length === 0} onClick={() => updateCuts([])}>
          Clear cuts
        </button>
        <label className="kind">
          preview&nbsp;
          <select value={format} onChange={(e) => setFormat(e.target.value as FilmFormat)}>
            {(Object.keys(FORMATS) as FilmFormat[]).map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        {render.state === 'running' ? (
          <span className="kind">
            rendering {render.format ?? ''} {Math.round(render.progress * 100)}%
          </span>
        ) : (
          <button
            className="rec-button"
            onClick={() => {
              setRender({ state: 'running', progress: 0 });
              void fetch(`/api/sessions/${manifest.id}/render`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
              });
            }}
          >
            Render 4:5 + 9:16
          </button>
        )}
      </header>

      {render.state === 'done' && (
        <div className="banner" style={{ background: 'var(--ok)', color: '#08110c' }}>
          Rendered!{' '}
          {(render.files ?? []).map((f) => (
            <a
              key={f}
              href={`/sessions/${manifest.id}/${f}`}
              target="_blank"
              rel="noreferrer"
              style={{ marginRight: '0.8em' }}
            >
              {f}
            </a>
          ))}{' '}
          <button
            onClick={() =>
              void fetch('/api/reveal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: manifest.id }),
              })
            }
          >
            Reveal
          </button>
        </div>
      )}
      {render.state === 'error' && <div className="banner">Render failed: {render.message}</div>}

      <div className="edit-main">
        <div className="edit-program" onClick={toggle}>
          <ProgramCanvas
            width={FORMATS[format].width}
            height={FORMATS[format].height}
            activeSource={activeSource}
            videoEls={videoEls}
          />
        </div>
        <div className="edit-angles">
          {sources.map((s, i) => (
            <AngleTile
              key={s.id}
              source={s}
              index={i}
              fps={fps}
              trim={timeline.trim[s.id] ?? 0}
              frame={frame}
              playing={playing}
              active={activeId === s.id}
              color={colorOf(s.id)}
              onCut={() => addCut(s.id)}
              onRotate={() =>
                setRotations((r) => ({ ...r, [s.id]: ((r[s.id] ?? 0) + 90) % 360 }))
              }
              onVideoEl={(el) => {
                if (el) videoEls.current.set(s.id, el);
                else videoEls.current.delete(s.id);
              }}
            />
          ))}
          <p className="hint">
            Press 1–{sources.length} (or click an angle) to cut. Space plays, ←/→ steps,
            backspace removes the cut at the playhead.
          </p>
        </div>
      </div>

      {audioSource && (
        <AudioTrack
          src={audioSource.src}
          trim={timeline.trim[audioSource.id] ?? 0}
          fps={fps}
          frame={frame}
          playing={playing}
        />
      )}

      <Timeline
        timeline={timeline}
        cuts={cuts}
        fps={fps}
        frame={frame}
        colorOf={colorOf}
        onSeek={seekTo}
        onDeleteCutAt={(atFrame) => updateCuts(cuts.filter((c) => c.atFrame !== atFrame))}
        onMoveCut={moveCut}
        onDragStart={() => pushHistory(cuts)}
      />
    </div>
  );
}

// The program monitor: a canvas that draws the active angle's tile video with
// the same cover-crop + rotation math as the ffmpeg render. Reusing the tile
// <video> elements keeps us inside the browser's per-origin connection limit.
function ProgramCanvas({
  width,
  height,
  activeSource,
  videoEls,
}: {
  width: number;
  height: number;
  activeSource: EditSource | null;
  videoEls: React.MutableRefObject<Map<string, HTMLVideoElement>>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(activeSource);
  activeRef.current = activeSource;

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const active = activeRef.current;
      const v = active ? videoEls.current.get(active.id) : null;
      if (!v || !v.videoWidth) return;
      // The <video> element already applies the file's own display matrix;
      // only the user-set rotation is applied here (mirrors the render).
      const rot = (((active!.rotation ?? 0) % 360) + 360) % 360;
      const quarter = rot === 90 || rot === 270;
      const contentW = quarter ? v.videoHeight : v.videoWidth;
      const contentH = quarter ? v.videoWidth : v.videoHeight;
      const scale = Math.max(canvas.width / contentW, canvas.height / contentH);
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((rot * Math.PI) / 180);
      ctx.scale(scale, scale);
      ctx.drawImage(v, -v.videoWidth / 2, -v.videoHeight / 2, v.videoWidth, v.videoHeight);
      ctx.restore();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [videoEls]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className="program-canvas"
      style={{ aspectRatio: `${width} / ${height}` }}
    />
  );
}

// One continuous audio track, synced to the transport like the angle tiles.
function AudioTrack({
  src,
  trim,
  fps,
  frame,
  playing,
}: {
  src: string;
  trim: number;
  fps: number;
  frame: number;
  playing: boolean;
}) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    const target = (frame + trim) / fps;
    if (playing) {
      if (a.paused) void a.play().catch(() => {});
      if (Math.abs(a.currentTime - target) > 0.25) a.currentTime = target;
    } else {
      if (!a.paused) a.pause();
      if (Math.abs(a.currentTime - target) > 0.05) a.currentTime = target;
    }
  }, [frame, playing, trim, fps]);

  return <audio ref={ref} src={src} preload="auto" />;
}

function AngleTile({
  source,
  index,
  fps,
  trim,
  frame,
  playing,
  active,
  color,
  onCut,
  onRotate,
  onVideoEl,
}: {
  source: EditSource;
  index: number;
  fps: number;
  trim: number;
  frame: number;
  playing: boolean;
  active: boolean;
  color: string;
  onCut: () => void;
  onRotate: () => void;
  onVideoEl: (el: HTMLVideoElement | null) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Keep the angle preview synced to the program playhead: exact while
  // paused/seeking, drift-corrected while playing.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const target = (frame + trim) / fps;
    if (playing) {
      if (v.paused) void v.play().catch(() => {});
      if (Math.abs(v.currentTime - target) > 0.2) v.currentTime = target;
    } else {
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - target) > 1 / fps) v.currentTime = target;
    }
  }, [frame, playing, trim, fps]);

  return (
    <div
      className={`angle${active ? ' active' : ''}`}
      style={active ? { borderColor: color } : undefined}
      onClick={onCut}
    >
      <video
        ref={(el) => {
          (videoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
          onVideoEl(el);
        }}
        src={source.src}
        muted
        playsInline
        preload="auto"
        style={source.rotation ? { transform: `rotate(${source.rotation}deg)` } : undefined}
      />
      <span className="key" style={{ background: color }}>
        {index + 1}
      </span>
      <span className="angle-name">{source.id}</span>
      <button
        className="angle-rotate"
        title={`Rotate (now ${source.rotation ?? 0}°)`}
        onClick={(e) => {
          e.stopPropagation();
          onRotate();
        }}
      >
        ⟳
      </button>
    </div>
  );
}

function Timeline({
  timeline,
  cuts,
  fps,
  frame,
  colorOf,
  onSeek,
  onDeleteCutAt,
  onMoveCut,
  onDragStart,
}: {
  timeline: ReturnType<typeof buildTimeline>;
  cuts: Cut[];
  fps: number;
  frame: number;
  colorOf: (id: string) => string;
  onSeek: (frame: number) => void;
  onDeleteCutAt: (atFrame: number) => void;
  onMoveCut: (fromFrame: number, toFrame: number) => number | null;
  onDragStart: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ type: 'scrub' } | { type: 'cut'; atFrame: number } | null>(null);
  const duration = timeline.durationInFrames;

  const frameAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration - 1, Math.round(((clientX - r.left) / r.width) * duration)));
  };

  const explicitCuts = [...cuts].sort((a, b) => a.atFrame - b.atFrame);

  return (
    <div
      ref={ref}
      className="timeline"
      onPointerDown={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest('.seg-x')) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const handle = target.closest('.cut-handle') as HTMLElement | null;
        if (handle) {
          drag.current = { type: 'cut', atFrame: Number(handle.dataset.frame) };
          onDragStart();
        } else {
          drag.current = { type: 'scrub' };
          onSeek(frameAt(e.clientX));
        }
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const f = frameAt(e.clientX);
        if (drag.current.type === 'scrub') {
          onSeek(f);
        } else {
          const moved = onMoveCut(drag.current.atFrame, f);
          if (moved !== null) drag.current.atFrame = moved;
        }
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
    >
      {timeline.segments.map((seg) => {
        const deletable = cuts.some((c) => c.atFrame === seg.start);
        return (
          <div
            key={`${seg.start}-${seg.sourceId}`}
            className="seg"
            style={{
              width: `${(seg.len / duration) * 100}%`,
              background: colorOf(seg.sourceId),
            }}
            title={`${seg.sourceId} @ ${formatFrame(seg.start, fps)}`}
          >
            <span className="seg-label">{seg.sourceId}</span>
            {deletable && (
              <button
                className="seg-x"
                title="Remove this cut (merges into the previous segment)"
                onClick={() => onDeleteCutAt(seg.start)}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      {explicitCuts
        .filter((c) => c.atFrame > 0 && c.atFrame < duration)
        .map((c) => (
          <div
            key={c.atFrame}
            className="cut-handle"
            data-frame={c.atFrame}
            style={{ left: `${(c.atFrame / duration) * 100}%` }}
            title="Drag to move this cut"
          />
        ))}
      <div className="playhead" style={{ left: `${(frame / duration) * 100}%` }} />
    </div>
  );
}

function formatFrame(f: number, fps: number) {
  const s = f / fps;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}.${String(Math.floor(f) % fps).padStart(2, '0')}`;
}
