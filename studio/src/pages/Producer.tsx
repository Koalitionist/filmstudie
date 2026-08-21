import { useCallback, useEffect, useRef, useState } from 'react';
import { CaptureSource, openScreen, openWebcam } from '../lib/capture';
import { FRAME_PREVIEW, Json, StudioSocket } from '../lib/ws';

interface RosterSource {
  id: string;
  name: string;
  kind: string;
  rotation?: number;
  caps?: {
    zoom?: { min: number; max: number; step: number; value: number };
    torch?: boolean;
  } | null;
  online: boolean;
  recording: boolean;
}

interface RecordingInfo {
  sessionId: string;
  startedAt: number;
}

interface ManifestSource {
  id: string;
  file: string | null;
  status: string;
  duration?: number;
}

interface Manifest {
  id: string;
  createdAt: string;
  sources: ManifestSource[];
}

interface LocalSource {
  key: string;
  source: CaptureSource;
}

const CELL_COLORS = ['#5b9dff', '#3dd68c', '#f5a623', '#e5484d', '#b98aff', '#4dd0e1'];

function textOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? '#0d0f12' : '#ffffff';
}

export default function Producer() {
  const socketRef = useRef<StudioSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [roster, setRoster] = useState<RosterSource[]>([]);
  const [recording, setRecording] = useState<RecordingInfo | null>(null);
  const [finalizing, setFinalizing] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [locals, setLocals] = useState<LocalSource[]>([]);
  const [webcamChoices, setWebcamChoices] = useState<MediaDeviceInfo[] | null>(null);
  const [sessions, setSessions] = useState<Manifest[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [liveActive, setLiveActive] = useState<string | null>(null);
  const [camState, setCamState] = useState<Record<string, { zoom?: number; torch?: boolean }>>({});
  const [programSel, setProgramSel] = useState<string | null>(null);
  const previewUrls = useRef<Record<string, string>>({});

  // Screen/webcam shares can't survive a page reload (the browser requires a
  // fresh pick), so remember what the last setup used and offer to restore it.
  const [ghosts, setGhosts] = useState<{
    screen: boolean;
    webcam: { deviceId?: string; label?: string } | null;
  }>(() => ({
    screen: localStorage.getItem('filmstudie.lastScreen') === '1',
    webcam: JSON.parse(localStorage.getItem('filmstudie.lastWebcam') ?? 'null'),
  }));

  const loadSessions = useCallback(async () => {
    const res = await fetch('/api/sessions');
    if (res.ok) setSessions(await res.json());
  }, []);

  useEffect(() => {
    const socket = new StudioSocket();
    socketRef.current = socket;
    socket.onOpen(() => {
      setConnected(true);
      socket.send({ type: 'hello', role: 'producer' });
    });
    socket.onClose(() => setConnected(false));
    socket.on('roster', (msg) => {
      setRoster(msg.sources as RosterSource[]);
      setRecording((msg.recording as RecordingInfo | null) ?? null);
    });
    socket.on('record-state', (msg) => {
      if (msg.state === 'finalizing') {
        setFinalizing(msg.sessionId as string);
      } else if (msg.state === 'idle') {
        setFinalizing(null);
        setLiveActive(null);
        setToast(`Session ${msg.sessionId} saved`);
        void loadSessions();
      }
    });
    socket.on('live-active', (msg) => setLiveActive((msg.sourceId as string) ?? null));
    socket.on('finalize-progress', (msg) => {
      setToast(`Finalizing ${msg.sourceId}: ${msg.status}`);
    });
    socket.on('source-status', (msg) => {
      if (msg.interrupted) setToast(`⚠ ${msg.sourceId}: ${msg.interrupted}`);
      if (typeof msg.zoom === 'number' || typeof msg.torch === 'boolean') {
        setCamState((s) => ({
          ...s,
          [msg.sourceId as string]: {
            ...s[msg.sourceId as string],
            ...(typeof msg.zoom === 'number' ? { zoom: msg.zoom } : {}),
            ...(typeof msg.torch === 'boolean' ? { torch: msg.torch } : {}),
          },
        }));
      }
    });
    socket.on('error', (msg) => setToast(String(msg.message)));
    socket.onBinary((kind, sourceId, payload) => {
      if (kind !== FRAME_PREVIEW) return;
      const url = URL.createObjectURL(new Blob([payload.slice()], { type: 'image/jpeg' }));
      const old = previewUrls.current[sourceId];
      if (old) URL.revokeObjectURL(old);
      previewUrls.current[sourceId] = url;
      setPreviews((p) => ({ ...p, [sourceId]: url }));
    });
    socket.connect();
    void loadSessions();
    return () => {
      socket.close();
      Object.values(previewUrls.current).forEach((u) => URL.revokeObjectURL(u));
    };
  }, [loadSessions]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const addScreen = async () => {
    try {
      const stream = await openScreen();
      const source = new CaptureSource({ name: 'screen', kind: 'local-screen', stream });
      setLocals((l) => [...l, { key: `screen-${Date.now()}`, source }]);
      localStorage.setItem('filmstudie.lastScreen', '1');
      setGhosts((g) => ({ ...g, screen: true }));
    } catch (err) {
      setToast(`Could not add screen: ${(err as Error).message}`);
    }
  };

  // Device labels are only revealed after camera permission is granted, so
  // open a throwaway stream first, then enumerate and let the user pick.
  const listWebcams = async () => {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
      const devices = await navigator.mediaDevices.enumerateDevices();
      tmp.getTracks().forEach((t) => t.stop());
      const cams = devices.filter((d) => d.kind === 'videoinput');
      if (cams.length === 0) setToast('No cameras found');
      else if (cams.length === 1) await addWebcam(cams[0]);
      else setWebcamChoices(cams);
    } catch (err) {
      setToast(`Could not list cameras: ${(err as Error).message}`);
    }
  };

  const addWebcam = async (device?: { deviceId?: string; label?: string }) => {
    setWebcamChoices(null);
    try {
      const stream = await openWebcam(device?.deviceId);
      const name = device?.label || 'mac-cam';
      const source = new CaptureSource({ name, kind: 'local-webcam', stream });
      setLocals((l) => [
        ...l,
        { key: `webcam-${device?.deviceId ?? 'default'}-${Date.now()}`, source },
      ]);
      localStorage.setItem(
        'filmstudie.lastWebcam',
        JSON.stringify({ deviceId: device?.deviceId, label: name })
      );
      setGhosts((g) => ({ ...g, webcam: { deviceId: device?.deviceId, label: name } }));
    } catch (err) {
      setToast(`Could not add camera: ${(err as Error).message}`);
    }
  };

  const removeLocal = (key: string) => {
    setLocals((l) => {
      const entry = l.find((e) => e.key === key);
      entry?.source.dispose();
      // An intentional remove also forgets the source for future sessions.
      if (entry?.source.kind === 'local-screen') {
        localStorage.removeItem('filmstudie.lastScreen');
        setGhosts((g) => ({ ...g, screen: false }));
      } else if (entry?.source.kind === 'local-webcam') {
        localStorage.removeItem('filmstudie.lastWebcam');
        setGhosts((g) => ({ ...g, webcam: null }));
      }
      return l.filter((e) => e.key !== key);
    });
  };

  const send = (msg: Json) => socketRef.current?.send(msg);
  const onlineCount = roster.filter((s) => s.online).length;
  // Hotkey order matches manifest source order (= hub roster order), which is
  // also how the editor numbers angles.
  const switchOrder = roster.map((s) => s.id);
  const keyOf = (id: string | null) => {
    const i = id ? switchOrder.indexOf(id) : -1;
    return i >= 0 ? i + 1 : null;
  };
  const liveCut = (sourceId: string) => {
    if (recording && !finalizing) send({ type: 'live-cut', sourceId });
    else setProgramSel(sourceId);
  };

  const programId = (recording ? liveActive : null) ?? programSel ?? switchOrder[0] ?? null;

  // 1..9 drives the program monitor: while recording it cuts the live camera
  // (the show is edited in real time), while idle it switches the preview.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const idx = parseInt(e.key, 10);
      if (idx >= 1 && idx <= switchOrder.length) {
        const id = switchOrder[idx - 1];
        if (recording && !finalizing) send({ type: 'live-cut', sourceId: id });
        else setProgramSel(id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, finalizing, switchOrder.join(',')]);

  // Mosaic dimensions: the program cell takes a 2x2 block top-left; the other
  // cells fill the remaining tracks.
  const ghostCells =
    (ghosts.screen && !locals.some((l) => l.source.kind === 'local-screen') ? 1 : 0) +
    (ghosts.webcam && !locals.some((l) => l.source.kind === 'local-webcam') ? 1 : 0);
  const extraCells = switchOrder.length + ghostCells + 1;
  const cols = extraCells <= 2 ? 3 : 4;
  const rows = extraCells <= (cols - 2) * 2 ? 2 : 3;

  const renderSourceCell = (id: string, big: boolean) => {
    const r = roster.find((s) => s.id === id);
    const local = locals.find((l) => l.source.sourceId === id);
    const n = keyOf(id);
    const color = CELL_COLORS[((n ?? 1) - 1) % CELL_COLORS.length];
    return (
      <SourceCell
        key={big ? '__program' : id}
        big={big}
        name={r?.name ?? id}
        keyNumber={n}
        color={color}
        online={r?.online ?? false}
        rotation={r?.rotation ?? 0}
        caps={r?.caps ?? null}
        state={camState[id]}
        stream={local?.source.stream ?? null}
        preview={previews[id]}
        live={!!recording && liveActive === id}
        selected={!recording && !big && programId === id}
        showRemove={!recording && !big}
        onClick={() => liveCut(id)}
        onRemove={() => {
          if (local) removeLocal(local.key);
          else send({ type: 'remove-source', sourceId: id });
        }}
        onControl={(control) => {
          setCamState((st) => ({ ...st, [id]: { ...st[id], ...control } }));
          send({ type: 'camera-control', sourceId: id, ...control });
        }}
      />
    );
  };

  return (
    <div className="producer-page">
      <header className="producer-header">
        <span className={`dot ${connected ? 'on' : ''}`} />
        <h1>filmstudie</h1>
        <span className="kind">
          {onlineCount} source{onlineCount === 1 ? '' : 's'}
        </span>
        <span className="spacer" />
        {recording && !finalizing && (
          <span className="kind">1–{switchOrder.length} switches the live camera</span>
        )}
        {recording && <RecTimer startedAt={recording.startedAt} />}
        {finalizing ? (
          <span className="kind">finalizing {finalizing}…</span>
        ) : recording ? (
          <button className="rec-button stop" onClick={() => send({ type: 'record-stop' })}>
            ■ Stop
          </button>
        ) : (
          <button
            className="rec-button"
            disabled={onlineCount === 0}
            onClick={() => send({ type: 'record-start' })}
          >
            ● REC
          </button>
        )}
      </header>

      <main
        className="mosaic"
        style={{
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridTemplateRows: `repeat(${rows}, 1fr)`,
          gridAutoFlow: 'row dense',
        }}
      >
        {programId && renderSourceCell(programId, true)}
        {switchOrder.map((id) => renderSourceCell(id, false))}
        {ghosts.screen && !locals.some((l) => l.source.kind === 'local-screen') && (
          <div className="cell add">
            <span className="kind">screen was in your last setup — reloads drop it</span>
            <button onClick={() => void addScreen()}>Re-share screen</button>
          </div>
        )}
        {ghosts.webcam && !locals.some((l) => l.source.kind === 'local-webcam') && (
          <div className="cell add">
            <span className="kind">{ghosts.webcam.label} was in your last setup</span>
            <button onClick={() => void addWebcam(ghosts.webcam!)}>Re-add camera</button>
          </div>
        )}
        <div className="cell add">
          <button onClick={() => void addScreen()}>+ Mac screen</button>
          {webcamChoices ? (
            <>
              <span className="kind">Pick a camera:</span>
              {webcamChoices.map((d, i) => (
                <button key={d.deviceId || i} onClick={() => void addWebcam(d)}>
                  {d.label || `Camera ${i + 1}`}
                </button>
              ))}
              <button onClick={() => setWebcamChoices(null)}>Cancel</button>
            </>
          ) : (
            <button onClick={() => void listWebcams()}>+ Mac webcam</button>
          )}
          <span className="kind">iPhone/iPad: scan the QR in the terminal</span>
        </div>
      </main>

      <section className="sessions">
        <h2>Sessions</h2>
        {sessions.length === 0 && <span className="kind">none yet — hit REC</span>}
        {sessions.map((m) => (
          <div className="session-row" key={m.id}>
            <strong>{m.id}</strong>
            <span className="meta">
              {m.sources
                .map((s) => `${s.id}${s.duration ? ` ${s.duration.toFixed(0)}s` : ''}`)
                .join(' · ')}
            </span>
            <span className="spacer" />
            <a href={`/edit?session=${m.id}`}>
              <button>Edit</button>
            </a>
            <button
              onClick={() =>
                void fetch('/api/reveal', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ sessionId: m.id }),
                })
              }
            >
              Reveal
            </button>
          </div>
        ))}
      </section>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function RecTimer({ startedAt }: { startedAt: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => force((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, []);
  const s = Math.max(0, (Date.now() - startedAt) / 1000);
  const m = Math.floor(s / 60);
  return (
    <span className="rec-timer">
      {m}:{String(Math.floor(s % 60)).padStart(2, '0')}
    </span>
  );
}

// One mosaic cell: live MediaStream for local sources, preview frames for
// remote cameras, with a sticky label and hover controls.
function SourceCell({
  big,
  name,
  keyNumber,
  color,
  online,
  rotation,
  caps,
  state,
  stream,
  preview,
  live,
  selected,
  showRemove,
  onClick,
  onRemove,
  onControl,
}: {
  big: boolean;
  name: string;
  keyNumber: number | null;
  color: string;
  online: boolean;
  rotation: number;
  caps: RosterSource['caps'];
  state?: { zoom?: number; torch?: boolean };
  stream: MediaStream | null;
  preview?: string;
  live: boolean;
  selected: boolean;
  showRemove: boolean;
  onClick: () => void;
  onRemove: () => void;
  onControl: (c: { zoom?: number; torch?: boolean }) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (stream && videoRef.current) {
      videoRef.current.srcObject = stream;
      void videoRef.current.play().catch(() => {});
    }
  }, [stream]);

  return (
    <div
      className={`cell${big ? ' big' : ''}${live ? ' live' : ''}${selected ? ' selected' : ''}`}
      style={big ? { gridColumn: '1 / 3', gridRow: '1 / 3' } : undefined}
      onClick={onClick}
    >
      {stream ? (
        <video ref={videoRef} muted playsInline />
      ) : preview ? (
        <img
          src={preview}
          alt={name}
          style={rotation ? { transform: `rotate(${rotation}deg)` } : undefined}
        />
      ) : (
        <div className="nosignal">no signal</div>
      )}
      <div className="sticky" style={{ background: live ? 'var(--rec)' : color, color: live ? '#fff' : textOn(color) }}>
        {keyNumber !== null && <span className="num">{keyNumber}</span>}
        <span className="nm">{name}</span>
      </div>
      <span className={`cell-status dot ${live ? 'rec' : online ? 'on' : ''}`} />
      {!online && <div className="nosignal">offline</div>}
      {showRemove && (
        <button
          className="cell-x"
          title="Remove this camera from the studio"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          ✕
        </button>
      )}
      {online && caps?.zoom && (
        <div className="cell-controls" onClick={(e) => e.stopPropagation()}>
          <span className="kind">×{(state?.zoom ?? caps.zoom.value).toFixed(1)}</span>
          <input
            type="range"
            min={caps.zoom.min}
            max={caps.zoom.max}
            step={caps.zoom.step}
            value={state?.zoom ?? caps.zoom.value}
            onChange={(e) => onControl({ zoom: Number(e.target.value) })}
          />
          {caps.torch && (
            <button
              style={state?.torch ? { borderColor: 'var(--accent)' } : undefined}
              onClick={() => onControl({ torch: !state?.torch })}
            >
              Torch
            </button>
          )}
        </div>
      )}
    </div>
  );
}
