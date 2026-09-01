# Feedback log

Running list of user feedback. Newest first. Status: ☐ open · ◐ in progress · ☑ done (with commit).

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
