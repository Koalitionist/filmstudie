# filmstudie

A personal multicam studio for 4:5 (1080×1350) social posts — Instagram, LinkedIn, YouTube.

Your Mac runs the **producer**: a live grid of every camera and one big REC button. iPhone and
iPad join as cameras by scanning a QR code — no apps, just Safari. While recording, every angle
streams to the Mac in real time, so when you hit stop the footage is already in a session
folder, synced and ready to cut.

## Requirements

- macOS with [Homebrew](https://brew.sh), Node ≥ 20, ffmpeg (`brew install ffmpeg`)
- iPhone/iPad on the same WiFi network

## First-time setup

```sh
npm install
npm run setup     # installs mkcert, creates the studio's TLS certificate
```

Then once per iPhone/iPad (iOS requires a trusted certificate before Safari will open the
camera on a local server):

1. Open `http://<your-mac>.local:4434/` on the device (the URL is printed at startup).
2. Download the root certificate → Settings → **Profile Downloaded** → Install.
3. Settings → General → About → **Certificate Trust Settings** → enable full trust for **mkcert**.

## Daily use

```sh
npm start
```

- The terminal prints the producer URL and a QR code for the camera URL.
- Open the producer on the Mac; add **Mac screen** / **Mac webcam** sources there.
- Scan the QR with iPhone/iPad, name the angle once (`topdown`, `face`), hit **Start camera**.
- **REC** records every connected source; **Stop** finalizes everything into
  `sessions/<timestamp>/` (one file per angle + `session.json` with sync offsets).

While recording, keep Safari in the foreground and the screen on — iOS stops the camera
otherwise. The camera page holds a wake lock and shows a red warning if a feed is interrupted;
a WiFi hiccup buffers locally and resumes, so short dropouts don't lose footage (bytes in
flight at the exact moment of a hard disconnect can still be lost — the producer will show it).

## Roadmap

- **Phase 2 — Edit & render**: `/edit` page with synced multicam playback, `1/2/3` hotkey
  camera switching like a vision mixer, and Remotion rendering to 1080×1350 MP4.
- **Phase 3**: audio cross-correlation auto-sync, import of offline cameras (DJI Osmo Nano via
  Vision Dock offload), PiP/split layouts, direct post scheduling.

## Development

```sh
npm test          # end-to-end ingest test (fake camera streams fMP4 chunks, verifies output)
npm run server    # server only (expects studio/dist to exist)
npm run build     # rebuild the studio app
```

Architecture notes live in the plan; the short version: each camera page (and each
producer-local source) opens its own WebSocket to the hub, streams JPEG preview frames
(kind 1) and MediaRecorder fMP4/WebM chunks (kind 2) as binary frames, and the server
appends chunks in order, then remuxes with `ffmpeg -c copy` on stop. Clock offsets are
estimated per source over the socket and stored in `session.json` for the edit step.
