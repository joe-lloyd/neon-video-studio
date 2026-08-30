# `neon-cli` reference

The CLI is the agent/automation interface to Neon Video Studio. Every command talks to the running
desktop app over its local control API and **everything shows up live in the app** (Live panel,
clip flashes, status pulse). The app streams the same events back over SSE (`neon-cli events`).

```bash
pnpm cli <command>            # from the repo
node apps/cli/src/main.ts …   # equivalent (Node ≥ 22.18 runs the TS directly)
```

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
neon-cli list [templates|tracks|clips|assets|presets]   # `--json` includes JSON Schemas for template props
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
neon-cli timeline split <clip> --at T
neon-cli timeline remove <clip...>
neon-cli timeline cut --from 4s --to 6s [--track REF] [--no-ripple]   # remove a range across tracks
neon-cli timeline detach <clip>     # split a video's audio onto an audio track (video muted)
neon-cli tracks add --kind video|audio|overlay [--name N]
neon-cli tracks update <track> [--mute|--unmute] [--lock|--unlock] [--hide|--show] [--name N]
neon-cli tracks remove <track>
```

## Media

```bash
neon-cli assets import <file...> [--at T] [--track REF]   # copies into the project, probes duration/size
neon-cli assets remove <ref>
# Binary upload (voice-over takes, agent-generated audio/images):
curl -X POST "http://127.0.0.1:$PORT/api/assets/upload?name=take.m4a&at=120&track=$TRACK_ID" \
     -H "Authorization: Bearer $TOKEN" --data-binary @take.m4a
```

## AI (local engines)

```bash
neon-cli ai status                  # engine availability + copy-able install commands
neon-cli ai setup [--model tiny.en|base.en|small.en]      # installs whisper.cpp + models automatically

neon-cli ai transcribe <clip|asset> [--force]             # word-level transcript, cached per asset
neon-cli ai transcript <clip|asset> [--json]              # print it; fillers marked ⟨so⟩; indexes for `ai cut`
neon-cli ai fillers  <clip|asset> [--apply] [--words um,uh,like] [--pad 40]
neon-cli ai silence  <clip|asset> [--apply] [--threshold=-38] [--min 400] [--keep 150]
neon-cli ai breaths  <clip|asset> [--db 15]
neon-cli ai denoise  <clip|asset> [--engine auto|rnnoise|afftdn|deepfilter] [--strength 0.7]
neon-cli ai enhance  <clip|asset> [--lufs=-16] [--no-denoise]   # clarity + broadcast loudness
neon-cli ai clean    <clip|asset> [--no-fillers] [--no-silences] [--no-breaths] [--denoise]
neon-cli ai matte    <clip> [--mode person|chroma] [--quality fast|balanced|accurate] [--color 0x00FF00]
neon-cli ai reframe  <clip> [--aspect 9:16] [--resize]
neon-cli ai broll    [<asset>] [--apply] [--no-claude] [--duration 3]
neon-cli ai cut      <asset> <fromWord> <toWord>          # text-driven edit by word index
neon-cli ai jobs · ai job <id> · ai cancel <id>
```

AI jobs run in the app; the CLI shows a live progress bar (skip with `--no-wait`). Denoise,
enhance and matte create **new assets** (`derivedFrom` links the original, which stays in Media).

## Rendering

```bash
neon-cli render --output out.mp4 [--preset project|1080p30|1080p60|720p30|4k30|vertical1080p30|square1080p30|draft] [--from T] [--to T]
neon-cli render status <jobId> · render cancel <jobId>
neon-cli render --headless --project ./MyProject.neon --output out.mp4 [--preset draft]   # no app required
```

## Watching & driving the UI (for agents)

```bash
neon-cli events [--history 20]      # live SSE tail of everything: CLI actions, UI edits, peers, renders, AI
neon-cli preview play|pause|toggle|seek 8.5s
neon-cli ui panel media|fx|inspect|room|ai|script|render|live
neon-cli ui select <clip...> | ui select none            # selects + flashes + jumps to the clip
neon-cli ui dialog render|room|shortcuts|none
```

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

# Exit codes: 0 success · 1 any error (with --json the error object is on stdout).
```
