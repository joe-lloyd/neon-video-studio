---
name: edit-demo-video
description: Edit a screen-recording demo or narrated video in Neon Video Studio through neon-cli. Use when the owner hands over a recording, a take, voice-over or assets and asks to clean it up, cut ums and pauses, zoom, speed up, add callouts or captions, check frames, or render a demo video.
---

# Edit a demo video with neon-cli

The owner records and supplies assets; you do the editing through `neon-cli`, and they review and
tweak in the app. Every command below edits the live project, and the app shows each change as it
happens. Full guide: `docs/screen-demos.md`. Reference: `docs/cli.md`.

## Start

- Run the CLI as `node apps/cli/src/main.ts` from the repo, or as `neon-cli` once
  `scripts/link-cli.sh` has run.
- If the app runs on another machine (the owner's editing PC), set `NEON_HOST=<ssh-host>` or add
  `--on <ssh-host>`; `neon-cli --on <host> launch` starts it there. Local files you import are
  uploaded, and `still`/`sheet` PNGs are copied back so you can open them here.
- If the desktop app is open on this machine, the CLI uses it. Otherwise run `neon-cli serve --detach` (needs Bun)
  and `neon-cli stop` when done.
- `neon-cli status` shows the project. Create one with `neon-cli project new --name "…" --width 1920 --height 1080 --fps 30`.
- Read before you edit: `neon-cli timeline` lists every track and clip with times, speed, zooms and
  ids. Add `--json` to any command for machine-readable output.

## The loop

1. Import or record:
   - `neon-cli assets import <file> --at 0`
   - `neon-cli capture start --display 0 --duration 2m`
2. Clean the narration:
   - `neon-cli ai setup` once per machine.
   - `neon-cli ai clean <take> --screen` for screen recordings, without `--screen` for talking heads.
   - A narration recorded as its own audio file: `neon-cli ai clean <voice-file>`. Voiceovers
     (this and `--screen`) get their fillers muted in place, so the picture is never cut to match.
   - `neon-cli ai enhance <take>` for clearer voice at broadcast loudness.
3. Read what was said with `neon-cli ai transcript <take>`. Remove anything else by word index:
   `neon-cli ai cut <asset> --words 12-15`.
4. Edit:
   - `zoom add` on what the narration points at.
   - `timeline speed` for waiting.
   - Demo Kit overlays: Callout, Spotlight, HighlightBox, KeyCombo, StepBadge, ClickPulse.
   - `captions add` last.
5. Look before you render:
   - `neon-cli sheet --count 12 --out /tmp/sheet.png`, then open the PNG and check it.
   - `neon-cli still --at T --out /tmp/f.png` for one frame.
6. Render with `neon-cli render --output <file>.mp4 --preset 1080p30`. Export subtitles with
   `neon-cli captions srt --out <file>.srt` if wanted.

## Rules

- **Time:** time is `MM:SS`, `HH:MM:SS:FF`, `12.5s` or `300f`. Positions and centres are 0..1
  fractions of the frame.
- **Cut-up takes:** after `ai clean`, one take is many clips with the same name. Pass `--from` and
  the CLI picks the piece under that time, or use clip ids from `neon-cli timeline`.
- **Zooms:** a zoom is stored in source time, so it stays on its moment through later cuts. Add
  zooms after cleaning, so their times match what you see.
- **Batches:** do many edits as one plan with `neon-cli apply plan.json`. Run `--dry-run` first.
  The plan lands as one undo step, or not at all. `neon-cli schema <route>` gives body schemas;
  `neon-cli templates <Name>` gives component props.
- **Checkpoints:** before a risky step, run `neon-cli history checkpoint`. `neon-cli history undo`
  steps back.
- **Never** edit `project.json` by hand while the app runs. Every change goes through the CLI so
  sync and undo stay consistent.
- **Check visually:** always look at a sheet or a still before you call an edit done. A command
  succeeding is not proof the picture is right.
- **Hand-off:** tell the owner what you changed, with timecodes, so they can review those spots in
  the app.
