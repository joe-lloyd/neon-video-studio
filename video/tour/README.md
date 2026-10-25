# Tour video

Everything that produces the Neon Video Studio tour: the script, the narration, the footage, the
Neon edit, the thumbnail, the YouTube files and the watch page. Adapted from the Git Gud series kit.

| Path | What it is |
| --- | --- |
| `script.json` | Sections of lines, each with what is said and either a take or a Neon Tour FX component to show. |
| `tools/voice.mjs` | Narrates every line with a local Kokoro server (voice `af_heart`), cached per line. |
| `tools/demo.ts` | A headless Neon in `~/.neon-video-tour-demo` with demo projects made from the Git Gud episodes, and the renderer on Vite. |
| `tools/takes.ts` | The takes: each sets up the demo and acts out its lines in the real app. |
| `tools/director.ts` | Records a page through the DevTools screencast, draws a cursor, and times actions to the narration's words. |
| `tools/record.ts` | Runs the takes. Checks every cue word against the narration first. |
| `tools/edit.ts` | Builds the edit in a private Neon (`~/.neon-video-tour-edit`) and renders it. |
| `tools/publish.ts` | The thumbnail from Neon's Thumb feature, plus title, description, chapters, tags and captions. |
| `tools/page.ts` | The watch page in `~/htmlify/videos/neon-video-studio-tour/`. |
| `tools/sheet.mjs` | Contact sheet of one take, for checking it. |
| `tools/check.mjs` | Contact sheet of the render: every chapter and every 20 seconds. |
| `fx/neon-tour` | FX pack in Neon's look: title, chapter label, explainer stage, thumbnail. |
| `stage/` | The terminal-and-app and two-machine pages that two takes are recorded in. |

## Make it again

Needs Bun, Node 24, the Git Gud tour renders in `~/htmlify/videos/git-gud-series/`, and Kokoro:

```sh
pnpm install --ignore-scripts && pnpm --dir video/tour install --ignore-workspace
docker run -d --rm --name kokoro-tours -p 8882:8880 ghcr.io/remsky/kokoro-fastapi-cpu:v0.9.0
node video/tour/tools/voice.mjs
node video/tour/tools/record.ts            # all takes; name takes to redo only those
node video/tour/tools/neon.ts serve --detach
node video/tour/tools/edit.ts --render     # ~/Videos/tours/neon-video-studio.neon → build/renders/
node video/tour/tools/publish.ts           # build/thumbs/ and build/publish/
node video/tour/tools/check.mjs            # look at it before publishing
node video/tour/tools/page.ts
```

`record.ts` starts the Vite servers on 5173 and 5174 if they are not running. The takes drive the
renderer in a browser, so they use the HTTP bridge (`apps/desktop/src/renderer/lib/bridge.ts`).

## What's real and what's stood in

- Every scene is the app from this checkout, in a browser attached to a headless main process.
- The footage inside the demo projects is the Git Gud tour; the trailer's voice-over is Kokoro.
- The AI scene runs silence trimming and voice enhance for real. Speech recognition is not
  installed on the recording machine, so the scene shows its install offer instead of transcripts.
- Screen capture needs a Screen Recording grant the headless app does not have, so the AI scene
  starts from an existing recording.
- The YouTube form shows a stand-in signed-in channel, answered in the browser; nothing is uploaded.
- The two machines in the room scene are two headless instances on one computer.
