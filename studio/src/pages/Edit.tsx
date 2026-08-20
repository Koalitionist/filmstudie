import { Player, PlayerRef } from '@remotion/player';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FilmComposition } from '../../../video/src/FilmComposition';
import {
  buildTimeline,
  Cut,
  EditSource,
  FilmFormat,
  FilmProps,
  FORMATS,
} from '../../../video/src/types';
import { StudioSocket } from '../lib/ws';

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
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [format, setFormat] = useState<FilmFormat>('4:5');
  const [render, setRender] = useState<{
    state: 'idle' | 'running' | 'done' | 'error';
    progress: number;
    format?: string;
    files?: string[];
    message?: string;
  }>({ state: 'idle', progress: 0 });
  const playerRef = useRef<PlayerRef>(null);

  const props: FilmProps = useMemo(
    () => ({ sources, cuts, audioSourceId, fps, format }),
    [sources, cuts, audioSourceId, fps, format]
  );
  const timeline = useMemo(() => buildTimeline(props), [props]);

  // frame + play-state tracking from the Player
  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    const onFrame = (e: { detail: { frame: number } }) => setFrame(e.detail.frame);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    p.addEventListener('frameupdate', onFrame);
    p.addEventListener('play', onPlay);
    p.addEventListener('pause', onPause);
    return () => {
      p.removeEventListener('frameupdate', onFrame);
      p.removeEventListener('play', onPlay);
      p.removeEventListener('pause', onPause);
    };
  }, []);

  // auto-save cuts + audio choice (debounced)
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
    socket.onOpen(() => socket.send({ type: 'hello', role: 'producer' }));
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
      const f = playerRef.current?.getCurrentFrame() ?? frame;
      if (activeSourceAt(f) === sourceId) return;
      setCuts((prev) => [...prev.filter((c) => c.atFrame !== f), { atFrame: f, sourceId }]);
    },
    [frame, activeSourceAt]
  );

  const deleteCutAtPlayhead = useCallback(() => {
    const f = playerRef.current?.getCurrentFrame() ?? frame;
    setCuts((prev) => {
      const containing = [...prev]
        .sort((a, b) => a.atFrame - b.atFrame)
        .filter((c) => c.atFrame <= f)
        .pop();
      return containing ? prev.filter((c) => c !== containing) : prev;
    });
  }, [frame]);

  // keyboard: 1..9 switch, space play/pause, arrows step, backspace delete cut
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      const p = playerRef.current;
      if (!p) return;
      const idx = parseInt(e.key, 10);
      if (idx >= 1 && idx <= sources.length) {
        addCut(sources[idx - 1].id);
      } else if (e.key === ' ') {
        e.preventDefault();
        p.toggle();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowLeft' ? -1 : 1);
        p.seekTo(Math.max(0, Math.min(timeline.durationInFrames - 1, p.getCurrentFrame() + step)));
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        deleteCutAtPlayhead();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sources, addCut, deleteCutAtPlayhead, timeline.durationInFrames]);

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

  const colorOf = (id: string) => ANGLE_COLORS[sources.findIndex((s) => s.id === id) % ANGLE_COLORS.length];
  const activeId = activeSourceAt(frame);

  return (
    <div className="edit-page">
      <header className="producer-header">
        <a href="/edit">
          <button>←</button>
        </a>
        <h1>{manifest.id}</h1>
        <span className="kind">
          {formatFrame(frame, fps)} / {formatFrame(timeline.durationInFrames, fps)}
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
        <div className="edit-program">
          <Player
            ref={playerRef}
            component={FilmComposition}
            inputProps={props}
            durationInFrames={timeline.durationInFrames}
            fps={fps}
            compositionWidth={FORMATS[format].width}
            compositionHeight={FORMATS[format].height}
            controls
            acknowledgeRemotionLicense
            style={{
              height: '100%',
              maxHeight: '70vh',
              aspectRatio: `${FORMATS[format].width} / ${FORMATS[format].height}`,
            }}
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
            />
          ))}
          <p className="hint">
            Press 1–{sources.length} (or click an angle) to cut. Space plays, ←/→ steps,
            backspace removes the cut at the playhead.
          </p>
        </div>
      </div>

      <div
        className="timeline"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const f = Math.round(((e.clientX - rect.left) / rect.width) * timeline.durationInFrames);
          playerRef.current?.seekTo(Math.max(0, Math.min(timeline.durationInFrames - 1, f)));
        }}
      >
        {timeline.segments.map((seg) => (
          <div
            key={`${seg.start}-${seg.sourceId}`}
            className="seg"
            style={{
              width: `${(seg.len / timeline.durationInFrames) * 100}%`,
              background: colorOf(seg.sourceId),
            }}
            title={`${seg.sourceId} @ ${formatFrame(seg.start, fps)}`}
          />
        ))}
        <div
          className="playhead"
          style={{ left: `${(frame / timeline.durationInFrames) * 100}%` }}
        />
      </div>
    </div>
  );
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
        ref={videoRef}
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

function formatFrame(f: number, fps: number) {
  const s = f / fps;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}.${String(f % fps).padStart(2, '0')}`;
}
