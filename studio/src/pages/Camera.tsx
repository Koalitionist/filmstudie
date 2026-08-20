import { useEffect, useRef, useState } from 'react';
import { CaptureSource, CaptureState, openCamera } from '../lib/capture';

const NAME_KEY = 'filmstudie.cameraName';
const FACING_KEY = 'filmstudie.cameraFacing';
const ROTATION_KEY = 'filmstudie.cameraRotation';
const SUGGESTIONS = ['topdown', 'face', 'side'];

type Facing = 'user' | 'environment';

export default function Camera() {
  const [name, setName] = useState<string>(() => localStorage.getItem(NAME_KEY) ?? '');
  const [started, setStarted] = useState(false);

  if (!started) {
    return (
      <NameGate
        name={name}
        onStart={(n) => {
          localStorage.setItem(NAME_KEY, n);
          setName(n);
          setStarted(true);
        }}
      />
    );
  }
  return <LiveCamera name={name} onRename={() => setStarted(false)} />;
}

function NameGate({ name, onStart }: { name: string; onStart: (name: string) => void }) {
  const [value, setValue] = useState(name);
  return (
    <div className="camera-page">
      <div className="center-card">
        <h1>filmstudie camera</h1>
        <p className="hint">Name this angle. The name sticks to this device.</p>
        <div className="chip-row">
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => setValue(s)}>
              {s}
            </button>
          ))}
        </div>
        <input
          value={value}
          placeholder="camera name"
          onChange={(e) => setValue(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
        />
        <button className="big" disabled={!value.trim()} onClick={() => onStart(value.trim())}>
          Start camera
        </button>
        <p className="hint">
          Keep this tab open and the screen on while recording — iOS stops the camera if Safari
          goes to the background or the screen locks.
        </p>
      </div>
    </div>
  );
}

function LiveCamera({ name, onRename }: { name: string; onRename: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const sourceRef = useRef<CaptureSource | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const [facing, setFacing] = useState<Facing>(
    () => (localStorage.getItem(FACING_KEY) as Facing) ?? 'environment'
  );
  const [rotation, setRotation] = useState<number>(
    () => Number(localStorage.getItem(ROTATION_KEY)) || 0
  );
  const [state, setState] = useState<CaptureState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let source: CaptureSource | null = null;

    (async () => {
      try {
        const stream = await openCamera(facing);
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        source = new CaptureSource({
          name,
          kind: 'remote',
          stream,
          rotation: Number(localStorage.getItem(ROTATION_KEY)) || 0,
        });
        sourceRef.current = source;
        source.onChange((ev) => {
          setState(ev.state);
          setError(ev.error);
        });
        source.socket.onOpen(() => setConnected(true));
        source.socket.onClose(() => setConnected(false));
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => {});
        }
      } catch (err) {
        setError(`Camera failed: ${(err as Error).message}`);
      }
    })();

    return () => {
      cancelled = true;
      source?.dispose();
      sourceRef.current = null;
    };
  }, [name, facing]);

  // Wake lock: keep the screen on; re-acquire when the tab becomes visible again.
  useEffect(() => {
    const acquire = async () => {
      try {
        wakeLockRef.current = await navigator.wakeLock?.request('screen');
      } catch {
        // unsupported or denied — the on-screen hint covers it
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    void acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      void wakeLockRef.current?.release();
    };
  }, []);

  useEffect(() => {
    if (state !== 'recording') {
      setRecSeconds(0);
      return;
    }
    const t0 = Date.now();
    const timer = window.setInterval(() => setRecSeconds((Date.now() - t0) / 1000), 500);
    return () => window.clearInterval(timer);
  }, [state]);

  const recording = state === 'recording';
  return (
    <div className={`camera-page${recording ? ' recording' : ''}`}>
      <div className="camera-bar">
        <span className={`dot ${recording ? 'rec' : connected ? 'on' : ''}`} />
        <span className="name">{name}</span>
        <span className="spacer" />
        <button disabled={recording} onClick={onRename}>
          Rename
        </button>
        <button
          onClick={() => {
            const next = (rotation + 90) % 360;
            localStorage.setItem(ROTATION_KEY, String(next));
            setRotation(next);
            sourceRef.current?.setRotation(next);
          }}
        >
          ⟳ {rotation}°
        </button>
        <button
          disabled={recording}
          onClick={() => {
            const next: Facing = facing === 'user' ? 'environment' : 'user';
            localStorage.setItem(FACING_KEY, next);
            setFacing(next);
          }}
        >
          Flip
        </button>
      </div>
      {error && <div className="banner">{error}</div>}
      {!connected && <div className="banner">Reconnecting to studio…</div>}
      <video
        ref={videoRef}
        className="camera-video"
        muted
        playsInline
        style={rotation ? { transform: `rotate(${rotation}deg)` } : undefined}
      />
      <div className={`camera-status${recording ? ' rec' : ''}`}>
        {recording
          ? `REC ${formatTime(recSeconds)}`
          : state === 'flushing'
            ? 'Sending…'
            : state === 'interrupted'
              ? 'Interrupted'
              : connected
                ? 'Ready'
                : 'Offline'}
      </div>
    </div>
  );
}

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}
