# `neon-cli` reference

The CLI is the agent/automation interface to Neon Video Studio. Every command talks to the running
app over its local control API, and every edit shows up live in the app when a window is open.

## Agent quickstart

Put `neon-cli` on your PATH once with `scripts/link-cli.sh` (macOS/Linux, writes `~/.local/bin/neon-cli`)
or `scripts\link-cli.ps1` (Windows, writes `%USERPROFILE%\bin\neon-cli.cmd`). From the repo,
`node apps/cli/src/main.ts …` and `pnpm cli …` do the same. Node 22.18 or later runs the TypeScript directly.

```bash
neon-cli serve --detach                 # 1. start the app without a window (skip if the desktop app is open)
neon-cli status --json                  #    project, size, fps, length

neon-cli timeline                       # 2. see the edit: one block per track with clips, gaps, speed, zooms, fades, ids
neon-cli timeline show --json           #    the same as structured JSON

neon-cli schema                         # 3. every control route; "batch" marks routes a plan may use
neon-cli schema timeline/insert         #    JSON Schema of one route's body
neon-cli templates TextOverlay          #    props schema and defaults of a component

neon-cli apply plan.json --dry-run      # 4. check a plan without the app: routes, refs and bodies
neon-cli apply plan.json                #    all ops land as one undo step, or none do
neon-cli history undo                   #    reverts the whole batch

neon-cli sheet --count 12               # 5. look at the edit: a grid of frames in one PNG
neon-cli still --at 4s                  #    one frame as a PNG

neon-cli render --output final.mp4 --preset 1080p30   # 6. export
neon-cli stop                           #    stop the headless app
```

A plan is a list of control-API calls (`{ "ops": [...] }` or a bare array; `-` reads it from stdin):

```json
{ "ops": [
  { "route": "/api/timeline/insert", "body": { "kind": "component", "componentName": "TextOverlay", "props": { "text": "Hello" }, "at": "1s", "duration": "2s" } },
  { "route": "/api/timeline/update", "body": { "id": "$0.id", "patch": { "animateIn": { "type": "pop", "durationFrames": 12 } } } }
] }
```

- `"$N"`, `"$N.id"` and `"$N.0.id"` are replaced with op N's result, or a path in it, before the op
  runs. Refs can only name earlier ops. A string that starts with `$$` is sent with one `$` removed,
  so `"$$5.99"` becomes `"$5.99"`.
- Bodies take ids, not names. Get track and clip ids from `neon-cli timeline --json`.
- If any op fails, the project goes back to its state before the plan. The CLI exits 1 and prints
  `{ok: false, failedAt, error: {code, message}, results, rolledBack}` with `--json`.
- Plans cannot contain routes whose effect a rollback cannot undo: renders, AI jobs, rooms, project
  new/open/save, history, pack install/uninstall/reload, recording, stills, shutdown and nested batches.
  `neon-cli schema` marks the routes a plan may use.
- Run one agent at a time. A plan is not isolated from edits that other clients make while it runs.

Any route is also reachable directly. `api` always prints the `{ok, data}` or `{ok: false, error}`
envelope and exits 1 on failure:

```bash
neon-cli api GET status
neon-cli api POST timeline/split '{"id":"clip_…","at":"4s"}'
neon-cli api POST /api/tracks/add @body.json
echo '{"kind":"audio"}' | neon-cli api POST tracks/add -
```

Usage errors quote the exact usage line, and a mistyped command, subcommand, flag, route or
template name gets the closest match: `Unknown subcommand "timeline inser". Did you mean "timeline insert"?`

## Connection & global flags

The CLI finds the app through `~/.neon-video/instance.json` (loopback port + bearer token, written
on every launch, mode 0600). Overrides: `--endpoint http://127.0.0.1:PORT --token TOKEN` or env
`NEON_ENDPOINT` / `NEON_TOKEN`.

| Flag | Meaning |
|---|---|
| `--json` | Machine-readable output: `{ok: true, data}` on success, `{ok: false, error: {code, message}}` + exit 1 on failure |
| `--no-wait` | Don't block on long jobs (renders, AI); poll later with `render status` / `ai job` |
| `-h`, `--help` | Full usage text |

**References (REF):** ids, id prefixes, or names. Tracks: `V1`, `A1`, `FX1`… Assets: file name or
hash prefix. Clips: id prefix or name — if several clips share a name (after cuts), audio/AI
commands fall back to the whole asset, which is usually what you want.

**Time (T):** `HH:MM:SS[:FF]` · `MM:SS` · `12.5s` · `300f` · `300` (frames at project fps).

## Project & status

```bash
neon-cli status                     # app, project, room, renders, engines
neon-cli list [templates|packs|tracks|clips|assets|presets]   # `--json` includes JSON Schemas for template props; templates carry pack + category
neon-cli state dump [--json] [--out project.json]       # full project document
neon-cli project new [--name N] [--fps 30] [--width W] [--height H]
neon-cli project open <dir.neon>
neon-cli project save [<dir>]       # Save As when a directory is given
```

## Timeline editing

```bash
neon-cli timeline insert --component TextOverlay --props '{"text":"Hello"}' --at 00:00:02:15 [--duration 4s] [--track FX1]
neon-cli timeline insert --asset intro.mp4 --at 0 [--trim 2s] [--volume 0.8]
    # placement: media with --at ripples later clips; overlays place exactly; add --ripple/--overlap/--free to override
neon-cli timeline update <clip> [--start T] [--duration T] [--trim T] [--volume 0.5] [--props '{"text":"New"}'] [--track REF] [--name N]
neon-cli timeline move  <clip> --at T [--track REF]
neon-cli timeline move  <clip...> --by 2s        # several clips together, same delta (negative: --by=-15f); the UI equivalent is dragging a multi-selection
neon-cli timeline split <clip> --at T
neon-cli timeline remove <clip...>
neon-cli timeline cut --from 4s --to 6s [--track REF] [--no-ripple]   # remove a range across tracks
neon-cli timeline detach <clip>     # split a video's audio onto an audio track (video muted)
neon-cli timeline update <clip> --pos 0.8,0.2 --scale 0.4 --rotation 15   # canvas placement (fractions of the frame; rotation in degrees)
neon-cli timeline update <clip> --in pop:12 --out fade:10     # enter/exit animation (type:frames; 'none' clears)
neon-cli timeline speed <clip> 4 [--from T --to T]   # re-time a clip or a range of it (0.1–16); later clips ripple on every track
    # audio is silent above 2×; overlays that span the clip (captions, watermark) stretch with it
neon-cli zoom add <clip> --from T --to T [--center 0.7,0.3] [--zoom 2] [--ramp 0.5s]   # ease in, hold, ease out
neon-cli zoom list <clip> · zoom clear <clip> [n]
    # zooms are stored in source time, so they stay on their moment through later cuts and speed changes;
    # back-to-back zooms pan straight across instead of zooming out in between
neon-cli record start · record stop [--at T]   # mic voice-over → VO track
    # macOS: grant mic access in System Settings → Privacy & Security → Microphone.
    # Windows: enable “Microphone access” AND “Let desktop apps access your microphone” in
    #   Settings → Privacy & security → Microphone — desktop apps don't appear in the per-app list.
    # Linux: uses PulseAudio/PipeWire (falls back to ALSA); distro ffmpeg recommended.
neon-cli tracks add --kind video|audio|overlay [--name N]
neon-cli tracks update <track> [--mute|--unmute] [--lock|--unlock] [--hide|--show] [--name N]
neon-cli tracks remove <track>
```

## Media

```bash
neon-cli assets import <file...> [--at T] [--track REF]   # copies into the project, probes duration/size
neon-cli assets remove <ref>
neon-cli assets waveform <ref> [--buckets 60]             # audio envelope (peaks per 10 ms) — ASCII bars, or raw buckets with --json
# Binary upload (voice-over takes, agent-generated audio/images):
curl -X POST "http://127.0.0.1:$PORT/api/assets/upload?name=take.m4a&at=120&track=$TRACK_ID" \
     -H "Authorization: Bearer $TOKEN" --data-binary @take.m4a
```

## Screen recording

```bash
neon-cli capture devices                      # displays (--display N, 0 = main) and microphones
neon-cli capture start [--display N] [--region x,y,w,h] [--window "Title"] [--fps 30]
                       [--mic NAME | --no-mic] [--no-cursor] [--countdown 3] [--duration T]
neon-cli capture stop [--at T] [--track REF]  # finish, import, place on the timeline
neon-cli capture cancel                       # throw the take away
neon-cli capture status
# Agents and tests: record 30 s with narration, then stop by itself (Ctrl-C stops early, keeps the take)
neon-cli capture start --duration 30s --countdown 3
```

The app records the screen, the pointer and the microphone into one file with ffmpeg. On macOS,
clicks are highlighted too. With no `--mic`, it uses the default microphone. `--mic` matches a device
name or part of one, as listed by `capture devices`. Each take goes to a `.mkv` in a temp folder
while recording, so a crash still leaves a playable file. On stop the app converts it to `.mp4`
without re-encoding, imports it and deletes the temp folder. The take goes to the end of V1, so
successive takes line up. `--at` and `--track` override that. One capture runs at a time, and never
alongside `record start`.

`--region` is in screen pixels, measured from the top-left corner of the chosen display. On a
Retina Mac, ffmpeg records physical pixels, which is twice the point size, so measure the region
in those. `--window`
works on Windows only and needs the exact title from the window's title bar.

The encoder is picked once per ffmpeg binary by encoding a single test frame: VideoToolbox on
macOS; NVENC, then Quick Sync, then AMF on Windows; otherwise libx264 (`veryfast`, CRF 20).
`capture status` shows which one is in use.

Per-OS permissions:

- **macOS**: System Settings → Privacy & Security → **Screen Recording**: turn on Neon Video
  Studio. For a headless app started with `neon-cli serve`, turn on the terminal app that runs it.
  Then quit and reopen that app. The microphone also needs Privacy & Security → **Microphone**.
  Without Screen Recording access, `capture devices` lists no displays and `capture start` says so.
  The app must run in the logged-in desktop session, not over SSH.
- **Windows**: screen capture (gdigrab) needs no permission. For the microphone, turn on Settings →
  Privacy & security → Microphone → "Let desktop apps access your microphone". Protected (DRM)
  video records as black.
- **Linux**: X11 only (x11grab + PulseAudio/PipeWire). Wayland sessions are refused with a clear
  error; log in with an X11 session ("Ubuntu on Xorg") to record.

HTTP: `GET /api/capture/devices`, `GET /api/capture/state`,
`POST /api/capture/start {display?, region?, window?, fps?, mic?: string|false, cursor?}`,
`POST /api/capture/stop {at?, track?}`, `POST /api/capture/cancel`.

## Ripping media from the web

```bash
neon-cli rip "https://www.youtube.com/watch?v=…" [--quality 1080|720|best|audio] [--at T]
```

Downloads via yt-dlp — if it isn't installed yet, the rip job installs it first (brew/winget when
present, otherwise the official static binary into `~/.neon-video/tools`) and then continues.
Remuxes to mp4/m4a, imports into the media library
(content-addressed like any import) and optionally places it on the timeline at `--at`. Rips prefer
H.264 + AAC (the preview's WKWebView can't decode AV1/VP9); when a site only offers those codecs,
the file is automatically converted to H.264 after download. Then slice away:
`timeline split/cut/trim`, `ai transcribe`, etc. Respect the source platform's terms and
copyright — intended for your own/licensed/CC content.

## External engines

Everything the app shells out to, in one checkable list (`neon-cli ai status` / the pills in the
AI panel). **Core engines install themselves**: on every launch the app checks ffmpeg + yt-dlp and
installs whatever is missing into `~/.neon-video/tools` (visible as a setup job + toast), so a
fresh machine works without any manual steps. The rest is opt-in.

| Engine | Used for | macOS | Windows | Linux |
|---|---|---|---|---|
| render runtime | exporting video (Remotion worker + compositions) | auto (first render) | auto (first render) | auto (first render) |
| ffmpeg + ffprobe | import probing, rips, denoise/enhance, VO and screen recording | auto (static build) | auto (static build) | auto (static build) |
| yt-dlp | ripping web video | auto (brew → static) | auto (winget → static) | auto (static) |
| whisper.cpp + model | transcripts, fillers, text editing | `ai setup` (brew) | manual (hint shown) | manual (hint shown) |
| RNNoise model | denoise | `ai setup` (download) | `ai setup` (download) | `ai setup` (download) |
| DeepFilterNet | optional better denoise | manual | manual | manual |
| Apple Vision helper | person matting, reframe | compiles itself | — | — |
| Claude API key | B-roll concepts | optional env var | optional env var | optional env var |

## AI (local engines)

```bash
neon-cli ai status                  # engine availability + copy-able install commands
neon-cli ai setup [--model tiny.en|base.en|small.en]      # installs engines + models automatically
    # also re-installs the core engines (ffmpeg, yt-dlp) if anything is missing.
    # whisper.cpp auto-installs via Homebrew (macOS); Windows/Linux get a copy-able manual command.

neon-cli ai transcribe <clip|asset> [--force]             # word-level transcript, cached per asset
neon-cli ai transcript <clip|asset> [--json]              # print it; fillers marked ⟨so⟩; indexes for `ai cut`
neon-cli ai fillers  <clip|asset> [--apply] [--words um,uh,like] [--pad 40]
neon-cli ai silence  <clip|asset> [--apply] [--threshold=-38] [--min 400] [--keep 150]
neon-cli ai breaths  <clip|asset> [--db 15]
neon-cli ai denoise  <clip|asset> [--engine auto|rnnoise|afftdn|deepfilter] [--strength 0.7]
neon-cli ai enhance  <clip|asset> [--lufs=-16] [--no-denoise]   # clarity + broadcast loudness
neon-cli ai clean    <clip|asset> [--no-fillers] [--no-silences] [--no-breaths] [--denoise] [--screen]
neon-cli ai pace     <clip|asset> [--apply] [--min 1200] [--keep 300] [--rate 6]
    # screen recordings: pauses over a still screen are cut, pauses while it changes play at --rate;
    # `ai clean --screen` uses this instead of the plain silence trim
neon-cli ai matte    <clip> [--mode person|chroma] [--quality fast|balanced|accurate] [--color 0x00FF00]
neon-cli ai reframe  <clip> [--aspect 9:16] [--resize]
neon-cli ai broll    [<asset>] [--apply] [--no-claude] [--duration 3]
neon-cli ai cut      <asset> <fromWord> <toWord>          # text-driven edit by word index (ripple cut)
neon-cli ai cut      <asset> --words 3,7,12-15 [--audio-only]  # non-contiguous words; --audio-only
    # mutes the words in place via volume keyframes — video and timing stay untouched (VO fixes)
neon-cli ai jobs · ai job <id> · ai cancel <id>
```

Word timings come from whisper.cpp's DTW anchors, aligned to the real pauses in the audio, so filler
and word cuts land between words. Transcripts made before this alignment are redone automatically.

AI jobs run in the app; the CLI shows a live progress bar (skip with `--no-wait`). Denoise,
enhance and matte create **new assets** (`derivedFrom` links the original, which stays in Media).

## Captions

Captions come from the word-level transcripts (`ai transcribe`). Transcripts stay in source time,
so captions are worked out from the current timeline every time they are shown or exported. They
follow cuts, filler and silence removal, splits and speed changes without being re-made.

```bash
neon-cli captions add [--track REF] [--style karaoke|block] [--source A1,V1]
    # burn-in: one Captions clip from 0 to the end of the timeline, on the "CC" overlay track
    # (created if missing) unless --track names another overlay track.
    # Running it again replaces the Captions clips on that track and keeps their style.
neon-cli captions srt [--out talk.srt] [--source A1,V1]   # SubRip file of what is said on the timeline now
neon-cli captions vtt [--out talk.vtt] [--source A1,V1]   # WebVTT; both print to stdout without --out
```

- `--source` picks the tracks to caption by name (default: every audio and video track).
  Exports without `--source` use the burned-in clip's choice, so the file matches the video.
- Only words you can hear are captioned. Fillers (`um`, `uh`) are dropped. So are words on hidden
  or muted tracks, in clips at volume 0 (a video whose audio was detached), in clips above 2×
  (their audio is silent), and words muted with `ai cut --audio-only`.
- A clip of a denoised or enhanced asset uses the original's transcript (`derivedFrom`).
- Cues hold up to `maxWords` words (default 6). A cue ends at a sentence end, at a pause over
  0.6 s, or at a comma once it is half full.
- Style the burned-in captions with `timeline update <clip> --props '{…}'` or in the Inspector:
  `style` (`karaoke` lights the word being spoken, `block` shows plain text), `position`
  (`bottom`, `top`, `middle`), `fontSize` (pixels at 1080p), `maxWords`, `color`,
  `highlightColor`, `background` (box on or off), `backgroundColor`, `tracks`.
- Cuts shorten the Captions clip along with everything else, and `timeline speed` stretches or
  shrinks it with the re-timed clip, so it keeps spanning the edit.

## Rendering

```bash
neon-cli render --output out.mp4 [--preset project|1080p30|1080p60|720p30|4k30|vertical1080p30|square1080p30|draft] [--from T] [--to T]
neon-cli render status <jobId> · render cancel <jobId>
neon-cli render --headless --project ./MyProject.neon --output out.mp4 [--preset draft]   # no app required (needs the repo)
```

Installed apps don't need the source repo: the first render downloads a self-contained **render
runtime** (~150 MB: Remotion worker + compositions + toolchain, published with every release) to
`~/.neon-video/render-runtime/v<version>` and keeps using it. Override the location with
`renderRuntimeDir` in `~/.neon-video/settings.json` or the `NEON_RENDER_RUNTIME_DIR` env var;
running from a source checkout keeps using the repo directly.

## Stills and contact sheets (see your edit)

An agent edits blind unless it looks. These commands render PNGs of the timeline, so after an
edit you can open the image and check that the cut, the zoom or the overlay landed where you meant.

```bash
neon-cli still --at 12s [--out f.png] [--width 1280]       # one frame
neon-cli sheet [--count 12 | --every 5s] [--cols 4] [--from T --to T] [--out f.png] [--width 1920]
neon-cli still --at 12s --headless --project ./MyProject.neon   # no app required (needs the repo)
```

- `still` renders the frame at project layout and scales it to `--width`, so text keeps its size
  relative to the picture.
- `sheet` puts several frames in one grid with a timecode under each cell. The default is 12
  frames spread evenly over the whole timeline. `--every` steps from `--from`, and a sheet holds at
  most 100 frames.
- Both wait for the file and print `{ path, frames, width, height }` with `--json`. `frames` are
  project frames. Files go to `~/.neon-video/stills/<project>-<timecode>.png` unless you pass
  `--out`.
- API: `POST /api/render/still {at, output?, width?}` and
  `POST /api/render/sheet {from?, to?, count?, every?, cols?, width?, output?}`.

## Watching & driving the UI (for agents)

```bash
neon-cli events [--history 20]      # live SSE tail of everything: CLI actions, UI edits, peers, renders, AI
neon-cli preview play|pause|toggle|seek 8.5s
neon-cli ui panel media|fx|inspect|room|ai|script|render|live
neon-cli ui select <clip...> | ui select none            # selects + flashes + jumps to the clip
neon-cli ui dialog render|room|shortcuts|none
```

## FX packs

Packs are folders (`pack.json` + `index.tsx`) — see [fx-packs.md](fx-packs.md). Installed packs live in
`~/.neon-video/packs`; a pack is *enabled per project* (stored in `meta.packs`) so exports know what
to bundle. Inserting a component from an installed pack enables the pack automatically.

```bash
neon-cli packs                       # built-in, installed and example packs + whether they're in this project
neon-cli packs install ./my-pack     # validate, copy to ~/.neon-video/packs, compile, add to the project
neon-cli packs install examples/packs/boba-expressive   # the shipped example (from a source checkout)
neon-cli packs add boba-expressive   # enable an installed pack for this project · packs remove … disables it
neon-cli packs uninstall boba-expressive
neon-cli packs reload                # re-scan + recompile after editing a pack in place
neon-cli timeline insert --component BobaTitle --props '{"title":"Hello"}' --at 2s
```

## Edit history

The app keeps the last 30 whole-project checkpoints in `<project>.neon/history/`; they survive
closing the project and rebooting. The UI's undo button uses them once its in-memory stack is
empty, and agents can drive them directly:

```bash
neon-cli history                     # "Checkpoint 12 of 14 · 11 undo steps · 2 redo steps"
neon-cli history checkpoint          # record the current state before risky edits (`apply` records its own)
neon-cli history undo | history redo # step the whole project to the previous / next checkpoint
```

Checkpoints are recorded automatically after edits made in the UI. Stepping is refused while the
app is in a room (it would overwrite peers' work).

## Rooms (P2P collaboration)

```bash
neon-cli room host [--password P]
neon-cli room join K7PM-2XQD-9HRT [--password P] [--host-url ws://192.168.1.20:PORT]
neon-cli room leave · room info
```

## Agent recipes

```bash
# Discover what you can insert (names + JSON Schemas + defaults):
neon-cli list templates --json | jq '.[] | {name, jsonSchema}'

# Clean a talking-head video end to end:
neon-cli assets import ./talk.mp4 --at 0
neon-cli ai clean talk.mp4 && neon-cli ai enhance talk.mp4
neon-cli ai broll --apply
neon-cli render --output final.mp4 --preset 1080p30

# Text-driven edit:
neon-cli ai transcript talk.mp4         # note the word indexes
neon-cli ai cut talk.mp4 33 35          # delete words 33–35 from the video

# Screen demo with live narration (full walkthrough: docs/screen-demos.md):
neon-cli capture start --display 0 --duration 2m      # or import a recording made elsewhere
neon-cli ai clean take.mp4 --screen && neon-cli ai enhance take.mp4
neon-cli zoom add take.mp4 --from 0:12 --to 0:18 --center 0.7,0.3
neon-cli sheet --count 12 --out sheet.png            # look before you render

# Captions after the edit (burned in + a sidecar file):
neon-cli captions add --style karaoke
neon-cli captions srt --out final.srt

# Exit codes: 0 success · 1 any error (with --json the error object is on stdout).
```
