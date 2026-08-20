// Shared WebSocket client: auto-reconnect, JSON messages, binary envelope.
// Binary frame envelope (both directions):
//   [u8 kind][u8 idLen][idLen bytes utf8 sourceId][payload]
export const FRAME_PREVIEW = 1;
export const FRAME_MEDIA = 2;

export type Json = Record<string, unknown> & { type: string };
type Handler = (msg: Json) => void;
type BinaryHandler = (kind: number, sourceId: string, payload: Uint8Array) => void;

export function encodeFrame(kind: number, sourceId: string, payload: Uint8Array): Uint8Array {
  const id = new TextEncoder().encode(sourceId);
  const buf = new Uint8Array(2 + id.length + payload.length);
  buf[0] = kind;
  buf[1] = id.length;
  buf.set(id, 2);
  buf.set(payload, 2 + id.length);
  return buf;
}

export function decodeFrame(buf: Uint8Array) {
  if (buf.length < 2) return null;
  const idLen = buf[1];
  if (buf.length < 2 + idLen) return null;
  return {
    kind: buf[0],
    sourceId: new TextDecoder().decode(buf.subarray(2, 2 + idLen)),
    payload: buf.subarray(2 + idLen),
  };
}

export function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

export class StudioSocket {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private binaryHandlers = new Set<BinaryHandler>();
  private openHandlers = new Set<() => void>();
  private closeHandlers = new Set<() => void>();
  private closed = false;
  private retryTimer: number | undefined;

  connect() {
    this.closed = false;
    this.open();
    return this;
  }

  private open() {
    if (this.closed) return;
    const ws = new WebSocket(wsUrl());
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => this.openHandlers.forEach((h) => h());
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        const frame = decodeFrame(new Uint8Array(ev.data));
        if (frame) this.binaryHandlers.forEach((h) => h(frame.kind, frame.sourceId, frame.payload));
        return;
      }
      const msg = JSON.parse(ev.data as string) as Json;
      this.handlers.get(msg.type)?.forEach((h) => h(msg));
    };
    ws.onclose = () => {
      this.closeHandlers.forEach((h) => h());
      if (!this.closed) this.retryTimer = window.setTimeout(() => this.open(), 1000);
    };
    ws.onerror = () => ws.close();
  }

  close() {
    this.closed = true;
    window.clearTimeout(this.retryTimer);
    this.ws?.close();
  }

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get bufferedAmount() {
    return this.ws?.bufferedAmount ?? 0;
  }

  send(msg: Json) {
    if (this.isOpen) this.ws!.send(JSON.stringify(msg));
  }

  sendBinary(buf: Uint8Array) {
    if (this.isOpen) this.ws!.send(buf);
  }

  on(type: string, handler: Handler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)!.delete(handler);
  }

  onBinary(handler: BinaryHandler): () => void {
    this.binaryHandlers.add(handler);
    return () => this.binaryHandlers.delete(handler);
  }

  onOpen(handler: () => void): () => void {
    this.openHandlers.add(handler);
    if (this.isOpen) handler();
    return () => this.openHandlers.delete(handler);
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }
}
