# Feedback log

Running list of user feedback. Newest first. Status: ☐ open · ◐ in progress · ☑ done (with commit).

## 2026-09-02 · round 19

- ☑ **"In FX, scaling or rotating pivots on a weird origin — it should be the element's centre so it stays in place"** — the composition applies `translate·scale·rotate` to a full-frame wrapper, so the CSS pivot was the *frame* centre; any off-centre element drifted when scaled/rotated. The canvas handles and the inspector's scale/rotation fields now re-solve the position on every change so the element's painted centre stays fixed (`renderer/lib/transform-math.ts`, covered by tests; the canvas editor shares its measured content bounds with the inspector via `editor.canvasBounds`). Render semantics and saved projects are unchanged. Note: `neon-cli timeline update --scale/--rotation` still pivots on the frame centre (the main process has no measurement of the element's painted bounds) — pass `--pos` alongside when precise placement matters.

## 2026-09-02 · round 18

- ☑ **"Add shift-select for a lane so you can grab multiple items in the same lane"** — timeline selection now has the usual modifiers: **⇧-click** extends the selection along the lane (every clip between the last selected clip on that lane and the clicked one), **⌘/Ctrl-click** toggles a single clip, **⇧-drag on empty lane space** draws a marquee that selects the clips it sweeps over. Dragging any clip of a multi-selection moves the whole group rigidly (same delta, never past frame 0, each clip stays on its lane, collisions with outside clips resolve per clip). Delete already handled multi-selections. CLI parity: `neon-cli timeline move <clip...> --by 2s` (negative `--by=-15f`) via `POST /api/timeline/nudge`; shortcuts dialog lists the gestures.
- ☑ **"Checking for updates gives me a 404"** — cause: the v0.8.0 Windows CI build failed, so `releases/latest/download/stable-win-x64-update.json` did not exist and Windows apps got HTTP 404 (mac/linux feeds were fine). Fixes: the publish step now **backfills** a missing platform's feed files (`stable-<plat>-update.json` + `.tar.zst`) from the previous release, so `latest` always carries every platform and those apps see "up to date" until the platform is rebuilt (re-run the failed job from the Actions UI → its assets are added to the same release); the updater turns a 404 into a readable "No Windows x64 build in the latest release yet" instead of a raw HTTP error. Root cause of the Windows build failures (v0.8.0, v0.8.1): the "retry flaky electrobun build" commit forced `shell: bash` on the build step, which on the Windows runner swaps PowerShell for Git Bash and breaks electrobun's toolchain. v0.8.2 restores the native shell (retry moved to a separate conditional step) and the backfill walks back through releases until it finds the platform.

## 2026-09-02 · round 17

- ☑ **"New lanes always append to the bottom — V2 should go under V1, A2 under A1, FX2 under FX1"** — `ProjectDoc.addTrack` now inserts a lane directly after the last lane of its kind (shifting later lanes down inside the same transaction, so one undo reverts it); an empty section goes after the sections that precede it (video → audio → FX). Covered by tests.
- ☑ **"I lose undo history when I close a project / shut the machine down"** — persistent checkpoint history: the main process keeps the last 30 whole-project snapshots in `<project>.neon/history/` (`HistoryStore`). The renderer's Y.UndoManager still handles the live session (fine-grained, own edits only — safe in rooms); every in-memory undo/redo moves the persisted cursor, and when the in-memory stack is empty (after a relaunch) undo/redo step through the checkpoints via a minimal-diff `applySnapshot`. Undo/redo buttons are now enabled/disabled for real. Persisted stepping is disabled while in a room.
- ☑ **"Audio bars on video/audio clips should show what is being said, not generic stripes"** — real waveforms: one max-amplitude byte per 10 ms is streamed out of ffmpeg per asset (constant memory), cached in `~/.neon-video/waveforms/<hash>.peaks`, served at `/waveforms/<hash>` and drawn on a canvas per clip, aligned to trim and zoom (also live while trimming). Video-only assets show nothing; the stripe pattern remains only as a loading/no-ffmpeg fallback.
- ☑ **"Make FX a proper plugin system: a packages/library section, drag-and-drop packs into the project, categories, search with previews; move boba out as a custom pack"** — FX packs are now folders (`pack.json` manifest + `index.tsx`), installed to `~/.neon-video/packs` from the new **FX → Library** view (Install folder…, drag a folder, one-click Examples from `examples/packs/`), enabled **per project** (`meta.packs`; button or drag the pack card onto the project zone). **FX → Components** shows built-in + enabled packs grouped by category with search and live-rendered thumbnails (looping preview on hover). The main process compiles packs with Bun against host-provided react/remotion/@neon/core/@neon/fx-kit; exports webpack-bundle the pack source through a generated entry, so installed packs render in previews and exports. Boba Expressive lives in `examples/packs/boba-expressive` as the reference pack; `@neon/fx-kit` is the stable helper surface for pack authors. `neon-cli list templates` shows pack + category. Guide: `docs/fx-packs.md`.

## 2026-09-01 · round 16

- ☑ **"Cutting a word from the transcript cuts the video as well — let me fix my voice-over instead, and remove multiple words at once"** — the Script panel now has two actions: **Cut** (video+audio, ripple — the old behaviour) and **Mute** (audio only: the words are zeroed with 40 ms ramps via volume keyframes; the picture and all timing stay untouched). Selection supports multiple words: click = select, shift-click = range, ⌘/Ctrl-click = add/remove individual words — both actions apply to everything selected, including non-contiguous words. CLI: `ai cut <asset> --words 3,7,12-15 [--audio-only]`.

## 2026-09-01 · round 15

- ☑ **Transcribe on Windows: "Speech recognition is not installed" with a manual download command** — whisper-cli now installs automatically on every OS: brew on macOS, the official prebuilt binaries (pinned tag, CLI + its DLLs/.so libs into `~/.neon-video/tools`) on Windows and Linux. The "Install automatically" button and `neon-cli ai setup` do the whole thing — binary + speech model — on all three platforms; the error hint now just says to click the button. Linux runs the prebuilt CLI with `LD_LIBRARY_PATH` pointing at its own libs.

## 2026-09-01 · round 14

- ☑ **Voice-over didn't work on Windows ("can't enable my microphone / app not in the list")** — recording was macOS-only (ffmpeg avfoundation). The recorder now picks the right capture backend per OS: avfoundation (macOS), DirectShow (Windows, first device named like a microphone), PulseAudio→ALSA (Linux). Error messages explain the real permission model — on Windows, desktop apps never appear in the per-app microphone list; only the global "Microphone access" + "Let desktop apps access your microphone" toggles apply.
- ☑ **v0.6.4 shipped without Linux builds** — the new symlink guard (correctly) rejected the Linux runtime pack: hoisted installs still symlink `.bin` in *nested* node_modules. The tar now excludes `.bin` at every level; guard stays.

## 2026-09-01 · round 13

- ☑ **Bug: "Downloaded render runtime is incomplete" on Windows** — the v0.6.3 runtime pack contained 435 symlinks (pnpm's `.pnpm` node_modules layout); Windows can't create symlinks from tar without admin rights, so `node_modules/@neon/*` came out broken. Packs are now built with `node-linker=hoisted` (real directories, zero links — CI fails the build if a single link entry sneaks into the archive), and the downloader validates per source and falls back from the exact-version pack to `latest`, so a once-broken release heals itself after the next good one.

## 2026-09-01 · round 12

- ☑ **Render failed on installed apps: "Cannot locate the neon-video-editor repository root"** — exporting used to require the source repo (render worker + Remotion toolchain + composition sources). CI now publishes a self-contained **render runtime** per OS (`pnpm deploy` of @neon/render → `render-runtime-<platform>.tar.gz` on every release); installed apps download it automatically on the first render into `~/.neon-video/render-runtime/v<version>` and render from it. Override via `renderRuntimeDir` in settings.json or `NEON_RENDER_RUNTIME_DIR`; dev checkouts keep using the repo. The Remotion headless-browser cache is shared across runtime versions (symlink → `~/.neon-video/remotion-bin`), and the worker now runs with its cwd pinned to the runtime so packaged apps (cwd = /) can't trip Remotion's cwd-relative paths.

## 2026-09-01 · round 11

- ☑ **"Now it says ffmpeg is missing — bundle the libraries so it just works"** — the core media engines (ffmpeg + ffprobe, yt-dlp) now provision themselves: on every app launch a check runs and anything missing is installed automatically (official static builds into `~/.neon-video/tools` — no package manager, no admin, all three OSes), with a toast + visible setup job. Rips also self-heal ffmpeg on demand. Every engine is checkable in one list (`ai status` / AI-panel pills, ffmpeg pill added) and documented in a table in docs/cli.md. Chose first-launch download over baking ffmpeg into the app bundle: same "just works" result, but updates stay ~25 MB instead of +120 MB per release, and the engines survive app updates. Also fixed: asset import probing used bare `ffprobe` from PATH and cached a *negative* result for the whole session — it now resolves through the tools dir and re-checks after installs.

## 2026-09-01 · round 10

- ☑ **Rip installs yt-dlp by itself** — "when the popup says we don't have the thing to rip, just install it": the rip job now self-heals. If yt-dlp is missing it installs it as the job's first step (brew/winget when available, otherwise the official static binary into `~/.neon-video/tools`) and then downloads the video — no error popup, no manual step. The install shows as job progress and in the Live feed. A missing ffmpeg now fails with the exact platform install command instead of a cryptic yt-dlp merge error.

## 2026-09-01 · round 9

- ☑ **App was mac-coded on Windows** — tooltips/shortcut hints showed ⌘ everywhere. All shortcut labels now render per platform (⌘I → Ctrl+I, ⇧⌘Z → Ctrl+Shift+Z, ⌫ → Del, snap-pause ⌘ → Alt) via `lib/kbd.ts`; the handlers always accepted Ctrl, only the text was wrong.
- ☑ **FX grab boxes covered the whole frame** — the canvas editor now measures each element's *painted* content (text glyph runs, media, styled boxes) in the live composition and fits the box to it; scale/rotate handles, snapping and guides all work on the content box. Snap targets are other elements' content centres/edges, so two text blocks align on their actual text.
- ☑ **Ripper suggested `brew` on Windows** — engine install hints and `ai setup` are platform-aware: brew (macOS), winget (Windows), apt/manual (Linux); yt-dlp falls back to the official static binary downloaded into `~/.neon-video/tools` on every platform. Also fixed `which()` for Windows (`;` PATH, `.exe`, winget links dir, tools dir).
- ☑ **Auto-update** — Electrobun updater wired to GitHub Releases (`release.baseUrl` → `releases/latest/download`; CI uploads the update feed + native installers). The app checks on boot & every 4 h; an ⬆ Update pill appears in the title bar (accept = download, install, restart), plus "Check for updates" on the Projects overview and in the app menu. Apps ≤ 0.5.0 predate the feed and need one manual reinstall.
- ☑ **Icon had a white background** — qlmanage composites SVGs onto white; icons are now rasterised with AppKit (`scripts/svg2png.swift`) with true transparency and regenerated for mac/win/linux.

## 2026-09-01 · round 8

- ☑ **Direct manipulation for every FX** — all visible FX/images get a draggable box on the preview (click selects, drag moves — no inputs needed); the selected one has corner scale handles and a rotate knob. Soft snapping to canvas centre/margins/thirds and other elements' centres/edges (e.g. aligning two text blocks on the same y), rotation soft-snaps to 45° steps. The magnet toggle (N / transport button) now controls canvas snapping too; ⌘/Alt pauses it while held. Rotation is a first-class transform: inspector field + `neon-cli timeline update --rotation deg`, renders in preview and export.
- ☑ **Bug: CLI couldn't set transforms/animations** — the control server's timeline/update handler silently dropped `transform`, `animateIn`, `animateOut`, `volumeKeyframes` and `reframe` (UI drags worked because they bypass that route). `--pos/--scale/--rotation/--in/--out` now persist via the API.

## 2026-09-01 · round 7

- ☑ **Raspberry Pi build orchestrator write-up** — "can a Pi run a build queue that calls my mac/windows/ubuntu machines to build the app?" → added §6 to the self-hosted-builder concept review (three shapes: machines as labelled GitHub runners with the Pi as wake-on-LAN kicker; a real CI server like Woodpecker/Forgejo on the Pi; full DIY SSH fan-out with sketch code). The Pi itself builds nothing — it's arm64, all three targets are covered by the machines.
- ☑ **Bug: ripped YouTube videos could be AV1** — WKWebView can't decode AV1/VP9 (media error code 4 in the preview). Rips now prefer H.264+AAC (`-S codec:avc:m4a`) and auto-convert to H.264 after download when a site only offers AV1/VP9.
- ☑ **Boba Expressive FX pack committed** — 5 templates (BobaTitle, BobaLowerThird, BobaTag, BobaBlob, BobaMorphLoader), verified in an exported frame.

## 2026-08-31 · round 6

- ☑ **YouTube ripper** — paste a URL in the Media panel (or `neon-cli rip <url> [--quality] [--at T]`): yt-dlp downloads, remuxes to mp4/m4a, imports into the library (optionally straight onto the timeline). `ai setup` installs yt-dlp; progress in the AI jobs / Live feed.
- ☑ **Self-hosted builder write-up** — concept review with the recommended hybrid (mac builds on your own machine as a self-hosted runner, publish stays on GitHub) incl. the security rules: `concept-reviews/2026-08-31-self-hosted-build-runner.html` on the HTML hub.

## 2026-08-31 · round 5

- ☑ **FX draggable + scalable on the canvas with snapping** — selected elements (templates, images, video) get a manipulation box in the preview: drag to move, corner handles to scale, light snapping to centre / margins / thirds / other elements (magenta guides, ⌘ disables), double-click resets. Numeric position/scale in the inspector, `--pos`/`--scale` in the CLI.
- ☑ **Animate in/out for elements** — fade, slide (4 directions), pop; per-clip in/out with duration; inspector selects + `--in pop:12 --out fade:10`.
- ☑ **Bug: microphone "undefined is not an object (navigator.mediaDevices)"** — `views://` is not a secure context, so WKWebView has no media APIs at all. Recording moved to the main process (ffmpeg/avfoundation, device auto-pick); first use triggers the macOS mic permission prompt. Also exposed as `neon-cli record start/stop`.
- ☑ **Bug: transcript said "speech recognition is not installed" although it is** — the engine check was cached from app launch; it now re-detects before failing and names exactly what's missing.
- ☑ **Release pipeline shipped no artifacts** — `macos-13` runners no longer exist (job queued ~10 h and blocked publishing), Linux needed glibc ≥ 2.38 (→ ubuntu-24.04), Windows failed on an ESM path quirk + missing `zip` (→ file:// import, 7z). Publish now posts a release on every tag with whatever platforms succeeded, notes include the mac install one-liner.

## 2026-08-30 · round 5

- ◐ **Canvas editing for FX & images** — drag elements on the preview, scale with handles, light snapping (canvas center, margins, other elements), works for FX components and images.
- ◐ **Animate in/out for all elements** — per-clip enter/exit animation (fade, slide, pop) with duration.
- ◐ **Bug: microphone** — `navigator.mediaDevices` is undefined in the WKWebView (views:// isn't a secure context). Fix: record in the main process via ffmpeg/avfoundation; renderer keeps MediaRecorder for browser mode.
- ◐ **Bug: transcript says whisper not installed** — engine detection is cached from app start; re-detect before failing and report exactly what's missing.

## 2026-08-30 · round 4

- ☑ **Whisper install UX** — when speech recognition is missing, offer one-click "Install automatically" (runs the brew + model download as a visible AI job) and a copy-able command. → AI panel button + `neon-cli ai setup`
- ☑ **AI voice enhance** — one button: clearer voice at broadcast loudness (high-pass → de-esser → compressor → EBU R128 loudnorm, optional light denoise). → `neon-cli ai enhance`
- ☑ **Record voice-over** — mic button in the transport: plays the timeline while recording, drops the take on a `VO` audio track at the playhead. (WKWebView MediaRecorder; falls back with a clear error if mic permission is unavailable.)
- ☑ **Project overview page** — start screen listing recent projects (name, path, when), open/new/save-location controls; reachable anytime via the logo / ⌘⇧O.
- ☑ **Resizable right sidebar** — drag the left edge (260–560 px, persisted per session).
- ☑ **Smoother trackpad pinch zoom** — zoom factor now follows the actual pinch delta (exponential, clamped) and anchors under the cursor.
- ☑ **Per-clip volume bar** — horizontal level line across video/audio clips; drag it up/down to change the clip volume, synced with the inspector.
- ☑ **Bug: FX clips stuck on FX1** — clip dragging now uses window-level pointer tracking (WKWebView pointer-capture quirk); target lanes highlight while dragging.
- ☑ **Split audio from video** — "Detach audio" in the inspector & `neon-cli timeline detach <clip>`: linked audio clip on an audio track, video muted.
- ☑ **FX pack system** — templates are now pluggable packs (`apps/remotion-workspace/src/templates/packs/`): one folder per pack with a pure-TS `meta.ts` (fields → auto-generated schema/inspector/CLI validation) and a `Component.tsx` that may use any npm library. Ships with the "Neon Essentials" example pack. See `docs/fx-packs.md`.
- ☑ **CLI documentation** — full reference in `docs/cli.md` (every command, flags, JSON mode, examples, agent recipes).

## 2026-08-30 · round 3 (done in v0.2.x)

- ☑ Integrated AI: fillers, silence trim, breath softening, denoise, B-roll, text-driven editing, person matting, auto-reframe (v0.2.0–v0.2.1)

## 2026-08-30 · rounds 1–2 (done in v0.1.0)

- ☑ Editor, CLI/agent control with live activity feed, P2P rooms, renders, icons, CI/releases, mac installer
