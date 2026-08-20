import { useCallback, useEffect, useRef, useState } from 'react';
import { CaptureSource, openScreen, openWebcam } from '../lib/capture';
import { FRAME_PREVIEW, Json, StudioSocket } from '../lib/ws';

interface RosterSource {
  id: string;
  name: string;
  kind: string;
  rotation?: number;
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

export default function Producer() {
  const socketRef = useRef<StudioSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [roster, setRoster] = useState<RosterSource[]>([]);
  const [recording, setRecording] = useState<RecordingInfo | null>(null);
  const [finalizing, setFinalizing] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [locals, setLocals] = useState<LocalSource[]>([]);
  const [webcamChoices, setWebcamChoices] = useState<MediaDeviceInfo[] | null>(null);
  // Screen/webcam shares can't survive a page reload (the browser requires a
  // fresh pick), so remember what the last setup used and offer to restore it.
  const [ghosts, setGhosts] = useState<{
    screen: boolean;
    webcam: { deviceId?: string; label?: string } | null;
  }>(() => ({
    screen: localStorage.getItem('filmstudie.lastScreen') === '1',
    webcam: JSON.parse(localStorage.getItem('filmstudie.lastWebcam') ?? 'null'),
  }));
  const [sessions, setSessions] = useState<Manifest[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const previewUrls = useRef<Record<string, string>>({});

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
        setToast(`Session ${msg.sessionId} saved`);
        void loadSessions();
      }
    });
    socket.on('finalize-progress', (msg) => {
      setToast(`Finalizing ${msg.sourceId}: ${msg.status}`);
    });
    socket.on('source-status', (msg) => {
      if (msg.interrupted) setToast(`⚠ ${msg.sourceId}: ${msg.interrupted}`);
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
  const localIds = new Set(locals.map((l) => l.source.sourceId).filter(Boolean));
  const remoteSources = roster.filter((s) => !localIds.has(s.id));
  const onlineCount = roster.filter((s) => s.online).length;

  return (
    <div className="producer-page">
      <header className="producer-header">
        <span className={`dot ${connected ? 'on' : ''}`} />
        <h1>filmstudie</h1>
        <span className="kind">
          {onlineCount} source{onlineCount === 1 ? '' : 's'}
        </span>
        <span className="spacer" />
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

      <main className="grid">
        {remoteSources.map((s) => (
          <div className="tile" key={s.id}>
            <div className="frame">
              {previews[s.id] ? (
                <img
                  src={previews[s.id]}
                  alt={s.name}
                  style={s.rotation ? { transform: `rotate(${s.rotation}deg)` } : undefined}
                />
              ) : (
                <span>no signal</span>
              )}
            </div>
            <div className="tile-bar">
              <span className={`dot ${s.recording ? 'rec' : s.online ? 'on' : ''}`} />
              <strong>{s.name}</strong>
              <span className="kind">{s.kind}</span>
              <span className="spacer" />
              {!s.online && <span className="kind">offline</span>}
            </div>
          </div>
        ))}
        {locals.map((l) => (
          <LocalTile
            key={l.key}
            entry={l}
            recording={!!recording}
            onRemove={() => removeLocal(l.key)}
          />
        ))}
        {ghosts.screen && !locals.some((l) => l.source.kind === 'local-screen') && (
          <div className="tile add">
            <span className="kind">screen was in your last setup — reloads drop it</span>
            <button onClick={() => void addScreen()}>Re-share screen</button>
          </div>
        )}
        {ghosts.webcam && !locals.some((l) => l.source.kind === 'local-webcam') && (
          <div className="tile add">
            <span className="kind">{ghosts.webcam.label} was in your last setup</span>
            <button onClick={() => void addWebcam(ghosts.webcam!)}>Re-add camera</button>
          </div>
        )}
        <div className="tile add">
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

function LocalTile({
  entry,
  recording,
  onRemove,
}: {
  entry: LocalSource;
  recording: boolean;
  onRemove: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState(entry.source.state);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = entry.source.stream;
      void videoRef.current.play().catch(() => {});
    }
    return entry.source.onChange((ev) => setState(ev.state));
  }, [entry]);

  return (
    <div className="tile">
      <div className="frame">
        <video ref={videoRef} muted playsInline />
      </div>
      <div className="tile-bar">
        <span className={`dot ${state === 'recording' ? 'rec' : 'on'}`} />
        <strong>{entry.source.name}</strong>
        <span className="kind">{entry.source.kind}</span>
        <span className="spacer" />
        <button disabled={recording} onClick={onRemove}>
          Remove
        </button>
      </div>
    </div>
  );
}
