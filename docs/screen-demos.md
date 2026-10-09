# Screen demos

How to turn a screen recording with your own narration into a finished demo video, mostly by
letting an agent drive `neon-cli`. Every step below is also a button in the app, so you can take
over at any point and adjust by hand.

## The loop

1. You record: the screen and your voice, in one take or several.
2. The agent cleans: fillers, pauses, breaths and loudness.
3. The agent edits: zooms on what matters, speeds up waiting, adds callouts and captions.
4. The agent checks its own work with stills and contact sheets, then renders.
5. You review in the app and tweak anything by hand. Edits from both sides show up live.

## 1. Record

Record from the app (the screen button next to the mic in the transport) or from the CLI:

```bash
neon-cli capture devices                         # displays and microphones on this machine
neon-cli capture start --display 0               # screen + default mic in one take
neon-cli capture stop                            # the take lands at the end of V1
neon-cli capture start --display 1 --duration 90s   # stops by itself
```

The screen and the mic go into the same file, so they stay in sync. Each take is appended to V1,
so several takes line up in order. Permissions:

- **macOS:** allow the app (or your terminal) in System Settings → Privacy & Security → Screen
  Recording, and under Microphone.
- **Windows:** enable "Microphone access" and "Let desktop apps access your microphone" in
  Settings → Privacy & security → Microphone. Screen capture needs no permission.

Recorded somewhere else (OBS, Game Bar, QuickTime)? Import the file instead:
`neon-cli assets import take.mp4 --at 0`.

Prefer to narrate afterwards? Record the screen with `--no-mic`, then record the voice-over
while the timeline plays: `neon-cli record start` … `neon-cli record stop --at 0`.

Every video you record or import also gets a preview proxy: a 720p copy with frequent keyframes,
made in the background and kept in `~/.neon-video/proxies`. The editor's preview plays the proxy,
so scrubbing a 4K recording shows a picture straight away. Exports always read the original, so
the final video is at full quality. `neon-cli status` shows how many proxies are ready.

## 2. Clean the narration

```bash
neon-cli ai setup                 # once per machine: speech recognition + models
neon-cli ai clean take.mp4 --screen
neon-cli ai enhance take.mp4      # clearer voice at broadcast loudness
```

`ai clean --screen` does three things:

- It mutes filler words (um, uh, you know) where they are. The picture is never cut for a word, so
  the voice stays in sync with the screen.
- It handles pauses by what the screen does. A pause over a still screen is cut. A pause while the
  screen changes, such as an install or a page load, plays at 6× so the viewer sees it happen.
- It softens breaths and mouth noise.

Word timings come from whisper.cpp, aligned to the real pauses in your voice, so cuts land between
words. A narration recorded as its own audio file is treated the same way: `ai clean voice.wav`
mutes its fillers, keeps its pauses and leaves the video alone. Only a talking-head video, where
the viewer sees you speak, has its fillers cut from picture and sound together. Check the result with `neon-cli ai transcript take.mp4`. Remove anything else by word
index with `neon-cli ai cut take.mp4 --words 12-15`.

## 3. Edit

```bash
neon-cli timeline                                         # what is on the timeline, per track
neon-cli zoom add take.mp4 --from 0:12 --to 0:18 --center 0.7,0.3 --zoom 2
neon-cli timeline speed take.mp4 8 --from 1:05 --to 1:40  # skip through a slow part
neon-cli timeline insert --component Callout --props '{"text":"Click Export","x":0.82,"y":0.12}' --at 0:14 --duration 3s
neon-cli timeline insert --component KeyCombo --props '{"combo":"Ctrl+Shift+P"}' --at 0:21 --duration 2s
neon-cli captions add --style karaoke
```

Zooms ease in, hold and ease out. Back-to-back zooms pan straight from one area to the next.
Zooms are anchored to the moment in the recording, so they stay put when you cut around them.
The Demo Kit components (Callout, Spotlight, HighlightBox, KeyCombo, StepBadge, ClickPulse) take
positions as fractions of the frame: `x: 0.5, y: 0.5` is the centre. List their props with
`neon-cli templates Callout`.

For many edits at once, write a plan and apply it as one step. It undoes as one step, and if any
edit fails, the whole plan is rolled back:

```bash
neon-cli apply plan.json
```

## 4. Check, then render

```bash
neon-cli sheet --count 12 --out sheet.png     # 12 frames across the whole video in one image
neon-cli still --at 0:14 --out frame.png      # one frame, full size
neon-cli render --output demo.mp4 --preset 1080p30
neon-cli captions srt --out demo.srt          # subtitles for YouTube and similar
```

## Editing on another machine

Run the agent on one machine and edit on another, such as a Windows PC that does the recording.
Set `NEON_HOST=<ssh-host>` (or add `--on <ssh-host>`) and every command above runs against the
app on that machine through an SSH tunnel. You watch the edit happen there. Local files are
uploaded on import, and stills, sheets and `render --fetch` outputs are copied back. See
"Driving the app on another machine" in `docs/cli.md`.

## Working without the app window

`neon-cli serve` runs the whole app without a window, which is useful on a server or when an
agent works alone. `neon-cli stop` shuts it down. Open the project in the desktop app afterwards
to review.

## Tips for recording

- Record at the size you will publish (1920×1080), or record larger and let zooms crop in.
- Pause briefly before and after each step you narrate. The cleanup trims those pauses, and they
  give the cuts room.
- Move the mouse slowly onto what you are about to click; the zoom has something to follow.
- Say a sentence again rather than stopping the recording. Cut the bad take later by word index.
