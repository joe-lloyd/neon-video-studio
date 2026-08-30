# Feedback log

Running list of user feedback. Newest first. Status: ☐ open · ◐ in progress · ☑ done (with commit).

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
