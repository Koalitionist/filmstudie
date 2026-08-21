import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import {
  createSession,
  finalizeSource,
  newSessionId,
  rawChunkPath,
  writeManifest,
} from './sessions.js';

// Binary frame envelope (both directions):
//   [u8 kind][u8 idLen][idLen bytes utf8 sourceId][payload]
// kind 1 = preview JPEG, kind 2 = media chunk
export const FRAME_PREVIEW = 1;
export const FRAME_MEDIA = 2;

const EOF_TIMEOUT_MS = 20_000;
const PRODUCER_MAX_BUFFERED = 4 * 1024 * 1024;

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const kind = buf[0];
  const idLen = buf[1];
  if (buf.length < 2 + idLen) return null;
  return {
    kind,
    sourceId: buf.subarray(2, 2 + idLen).toString('utf8'),
    payload: buf.subarray(2 + idLen),
  };
}

function encodeFrame(kind, sourceId, payload) {
  const id = Buffer.from(sourceId, 'utf8');
  return Buffer.concat([Buffer.from([kind, id.length]), id, payload]);
}

function slugify(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'camera'
  );
}

export class Hub {
  constructor({ log = console.log } = {}) {
    this.log = log;
    this.sources = new Map(); // sourceId -> {id, name, kind, ws, recording}
    this.producers = new Set();
    this.recording = null; // {sessionId, manifest, startedAt, active: Map<sourceId, {stream, eof}>}
  }

  attach(server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  onConnection(ws) {
    ws.meta = { role: null, sourceId: null };
    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) this.onBinary(ws, data);
        else this.onJson(ws, JSON.parse(data.toString()));
      } catch (err) {
        this.log(`ws message error: ${err.message}`);
      }
    });
    ws.on('close', () => this.onClose(ws));
    ws.on('error', () => {});
  }

  send(ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  broadcastProducers(msg) {
    for (const ws of this.producers) this.send(ws, msg);
  }

  broadcastCameras(msg) {
    for (const src of this.sources.values()) {
      if (src.ws) this.send(src.ws, msg);
    }
  }

  roster() {
    return {
      type: 'roster',
      sources: [...this.sources.values()].map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        rotation: s.rotation ?? 0,
        caps: s.caps ?? null,
        online: !!s.ws,
        recording: !!this.recording?.active.has(s.id),
      })),
      recording: this.recording
        ? { sessionId: this.recording.sessionId, startedAt: this.recording.startedAt }
        : null,
    };
  }

  pushRoster() {
    this.broadcastProducers(this.roster());
  }

  onJson(ws, msg) {
    switch (msg.type) {
      case 'hello':
        return this.onHello(ws, msg);
      case 'ping':
        return this.send(ws, { type: 'pong', t0: msg.t0, t1: Date.now() });
      case 'record-start':
        return this.startRecording();
      case 'record-stop':
        return this.stopRecording();
      case 'live-cut':
        return this.onLiveCut(msg);
      case 'camera-control':
        return this.onCameraControl(msg);
      case 'recording-started':
        return this.onRecordingStarted(ws, msg);
      case 'recording-resume':
        return this.onRecordingResume(ws, msg);
      case 'source-eof':
        return this.onSourceEof(ws);
      case 'status':
        return this.onStatus(ws, msg);
      default:
        this.log(`unknown message type: ${msg.type}`);
    }
  }

  onHello(ws, msg) {
    if (msg.role === 'producer') {
      ws.meta.role = 'producer';
      this.producers.add(ws);
      this.send(ws, { type: 'hello-ack', serverTime: Date.now() });
      this.send(ws, this.roster());
      return;
    }
    // camera (remote device or producer-local source)
    let id = slugify(msg.name || 'camera');
    const existing = this.sources.get(id);
    if (existing && existing.ws && existing.ws !== ws) {
      let n = 2;
      while (this.sources.has(`${id}-${n}`) && this.sources.get(`${id}-${n}`).ws) n++;
      id = `${id}-${n}`;
    }
    ws.meta.role = 'camera';
    ws.meta.sourceId = id;
    this.sources.set(id, {
      id,
      name: msg.name || id,
      kind: msg.kind || 'remote',
      rotation: Number(msg.rotation) || 0,
      caps: msg.caps ?? null,
      ws,
    });
    this.send(ws, { type: 'hello-ack', sourceId: id, serverTime: Date.now() });
    // Rejoining while a recording is running: let the source resume streaming.
    if (this.recording?.active.has(id)) {
      this.send(ws, {
        type: 'record-start',
        sessionId: this.recording.sessionId,
        serverTime: Date.now(),
        resumed: true,
      });
    }
    this.log(`camera joined: ${id} (${this.sources.get(id).kind})`);
    this.pushRoster();
  }

  onStatus(ws, msg) {
    const id = ws.meta.sourceId;
    if (!id) return;
    if (typeof msg.rotation === 'number' && this.sources.has(id)) {
      this.sources.get(id).rotation = msg.rotation;
      this.pushRoster();
    }
    this.broadcastProducers({ ...msg, type: 'source-status', sourceId: id });
  }

  onBinary(ws, data) {
    const frame = decodeFrame(Buffer.isBuffer(data) ? data : Buffer.from(data));
    if (!frame || ws.meta.role !== 'camera') return;
    const id = ws.meta.sourceId;
    if (frame.kind === FRAME_PREVIEW) {
      const out = encodeFrame(FRAME_PREVIEW, id, frame.payload);
      for (const p of this.producers) {
        if (p.readyState === p.OPEN && p.bufferedAmount < PRODUCER_MAX_BUFFERED) p.send(out);
      }
    } else if (frame.kind === FRAME_MEDIA) {
      const active = this.recording?.active.get(id);
      if (!active || active.eof) return;
      active.stream.write(frame.payload);
      active.bytes += frame.payload.length;
      // Ack received byte count so the camera can drop its local resend buffer.
      const now = Date.now();
      if (!active.lastAck || now - active.lastAck > 1000) {
        active.lastAck = now;
        this.send(ws, { type: 'ingest-ack', bytes: active.bytes });
      }
    }
  }

  onRecordingResume(ws, msg) {
    const rec = this.recording;
    const id = ws.meta.sourceId;
    if (!rec || !id || rec.sessionId !== msg.sessionId) return;
    const active = rec.active.get(id);
    if (!active) return;
    this.send(ws, { type: 'resume-ok', bytesReceived: active.bytes });
  }

  startRecording() {
    if (this.recording) return;
    const online = [...this.sources.values()].filter((s) => s.ws);
    if (online.length === 0) {
      this.broadcastProducers({ type: 'error', message: 'No cameras connected' });
      return;
    }
    const sessionId = newSessionId();
    const manifest = createSession(sessionId);
    const active = new Map();
    for (const src of online) {
      manifest.sources.push({
        id: src.id,
        name: src.name,
        kind: src.kind,
        rotation: src.rotation ?? 0,
        file: null,
        status: 'recording',
        recordStart: null,
      });
      active.set(src.id, {
        stream: fs.createWriteStream(rawChunkPath(sessionId, src.id), { flags: 'a' }),
        eof: false,
        bytes: 0,
      });
    }
    writeManifest(manifest);
    this.recording = { sessionId, manifest, startedAt: Date.now(), active, liveCuts: [] };
    this.broadcastCameras({ type: 'record-start', sessionId, serverTime: Date.now() });
    this.broadcastProducers({ type: 'live-active', sourceId: manifest.sources[0]?.id ?? null });
    this.pushRoster();
    this.log(`recording started: ${sessionId} (${online.length} sources)`);
  }

  // Producer adjusts a camera remotely (zoom/torch): route to that camera.
  onCameraControl(msg) {
    const src = this.sources.get(msg.sourceId);
    if (src?.ws) {
      this.send(src.ws, { type: 'camera-control', zoom: msg.zoom, torch: msg.torch });
    }
  }

  // Producer pressed a camera hotkey during recording: log the cut against
  // the server clock now, convert to timeline frames at finalize.
  onLiveCut(msg) {
    const rec = this.recording;
    if (!rec || rec.stopping || !rec.active.has(msg.sourceId)) return;
    rec.liveCuts.push({ atMs: Date.now(), sourceId: msg.sourceId });
    this.broadcastProducers({ type: 'live-active', sourceId: msg.sourceId });
  }

  onRecordingStarted(ws, msg) {
    const rec = this.recording;
    const id = ws.meta.sourceId;
    if (!rec || !id) return;
    const entry = rec.manifest.sources.find((s) => s.id === id);
    if (entry) {
      // serverStart = camera's local MediaRecorder start mapped onto the server clock
      entry.recordStart = msg.serverStart ?? null;
      entry.clockOffset = msg.clockOffset ?? null;
      writeManifest(rec.manifest);
    }
  }

  stopRecording() {
    const rec = this.recording;
    if (!rec) return;
    this.broadcastCameras({ type: 'record-stop', sessionId: rec.sessionId });
    this.broadcastProducers({ type: 'record-state', state: 'finalizing', sessionId: rec.sessionId });
    rec.stopTimer = setTimeout(() => this.finalizeAll('timeout'), EOF_TIMEOUT_MS);
    rec.stopping = true;
    this.log(`recording stopping: ${rec.sessionId}`);
  }

  onSourceEof(ws) {
    const rec = this.recording;
    const id = ws.meta.sourceId;
    if (!rec || !id) return;
    const active = rec.active.get(id);
    if (!active || active.eof) return;
    active.eof = true;
    if (rec.stopping && [...rec.active.values()].every((a) => a.eof)) {
      clearTimeout(rec.stopTimer);
      this.finalizeAll('complete');
    }
  }

  async finalizeAll(reason) {
    const rec = this.recording;
    if (!rec || rec.finalizing) return;
    rec.finalizing = true;
    this.recording = null;
    this.pushRoster();
    for (const [id, active] of rec.active) {
      await new Promise((resolve) => active.stream.end(resolve));
      const entry = rec.manifest.sources.find((s) => s.id === id);
      try {
        const result = await finalizeSource(rec.sessionId, id);
        Object.assign(entry, result, { status: 'finalized' });
        this.log(`finalized ${rec.sessionId}/${id}: ${result.file} (${result.duration.toFixed(1)}s)`);
      } catch (err) {
        entry.status = 'failed';
        entry.error = err.message;
        this.log(`finalize FAILED ${rec.sessionId}/${id}: ${err.message}`);
      }
      writeManifest(rec.manifest);
      this.broadcastProducers({
        type: 'finalize-progress',
        sessionId: rec.sessionId,
        sourceId: id,
        status: entry.status,
      });
    }
    // Convert live switch presses (server-clock ms) into timeline frames:
    // timeline zero is the moment every finalized camera was rolling.
    if (rec.liveCuts?.length) {
      const finalized = rec.manifest.sources.filter(
        (s) => s.status === 'finalized' && s.recordStart
      );
      if (finalized.length) {
        const t0 = Math.max(...finalized.map((s) => s.recordStart));
        const fps = rec.manifest.fps ?? 30;
        rec.manifest.cuts = rec.liveCuts
          .filter((c) => finalized.some((s) => s.id === c.sourceId))
          .map((c) => ({
            atFrame: Math.max(0, Math.round(((c.atMs - t0) / 1000) * fps)),
            sourceId: c.sourceId,
          }));
        writeManifest(rec.manifest);
        this.log(`recording ${rec.sessionId}: ${rec.manifest.cuts.length} live cuts saved`);
      }
    }
    this.broadcastProducers({
      type: 'record-state',
      state: 'idle',
      sessionId: rec.sessionId,
      reason,
      manifest: rec.manifest,
    });
    this.log(`recording finalized: ${rec.sessionId} (${reason})`);
  }

  onClose(ws) {
    if (ws.meta.role === 'producer') {
      this.producers.delete(ws);
      return;
    }
    const id = ws.meta.sourceId;
    if (id && this.sources.get(id)?.ws === ws) {
      this.sources.get(id).ws = null;
      // Keep the source entry (and any active recording stream) so a
      // reconnecting device can resume; prune fully when idle.
      if (!this.recording) this.sources.delete(id);
      this.log(`camera left: ${id}`);
      this.pushRoster();
    }
  }
}
