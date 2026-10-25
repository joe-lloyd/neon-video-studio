// The watch page: the video with its chapters and captions, in ~/htmlify/videos/neon-video-studio-tour/.
//
//   node video/tour/tools/page.ts     # after publish.ts
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { BUILD, RENDER, type Script, VIDEO } from "./tour.ts";

const OUT = join(homedir(), "htmlify", "videos", "neon-video-studio-tour");
const PUBLISH = join(BUILD, "publish");
const script: Script = JSON.parse(await readFile(join(VIDEO, "script.json"), "utf8"));
const chapters: { title: string; at: number }[] = JSON.parse(await readFile(join(PUBLISH, "chapters.json"), "utf8"));
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

await mkdir(OUT, { recursive: true });
await copyFile(RENDER, join(OUT, "neon-video-studio.mp4"));
await copyFile(join(PUBLISH, "captions.vtt"), join(OUT, "neon-video-studio.vtt"));
await copyFile(join(BUILD, "thumbs", "neon-video-studio.png"), join(OUT, "poster.png"));
const description = (await readFile(join(PUBLISH, "description.md"), "utf8")).split("\n\n")[0]!;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(script.youtube.title)}</title>
<style>
  :root { color-scheme: dark; --bg: #09090b; --panel: #15151b; --hover: #1c1c24; --line: rgba(255,255,255,.08); --text: #f4f4f5; --muted: #a1a1aa; --accent: #ff007f; --cyan: #00f3ff; }
  body { margin: 0; background: radial-gradient(1200px 600px at 70% -10%, rgba(255,0,127,.12), transparent 70%), var(--bg); color: var(--text); font: 16px/1.6 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 1280px; margin: 0 auto; padding: 40px 24px 80px; }
  .kicker { color: var(--accent); font: 600 12px/1 "JetBrains Mono", Menlo, monospace; letter-spacing: .16em; text-transform: uppercase; }
  h1 { font-size: 38px; line-height: 1.12; margin: 10px 0 8px; letter-spacing: -0.01em; }
  .lede { color: var(--muted); margin: 0 0 26px; max-width: 820px; }
  .player { display: grid; grid-template-columns: 1fr 320px; gap: 24px; align-items: start; }
  video { width: 100%; border-radius: 12px; background: #000; box-shadow: 0 20px 60px rgba(0,0,0,.5), 0 0 0 1px rgba(255,0,127,.25); }
  aside { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px; }
  aside h2 { font-size: 13px; margin: 4px 8px 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .12em; }
  button { font: inherit; color: var(--muted); background: none; border: 0; cursor: pointer; text-align: left; display: flex; gap: 12px; width: 100%; padding: 6px 8px; border-radius: 6px; }
  button:hover { background: var(--hover); color: var(--text); } button.active { color: var(--text); box-shadow: inset 3px 0 0 var(--accent); background: rgba(255,0,127,.1); }
  time { color: var(--cyan); min-width: 40px; font-variant-numeric: tabular-nums; }
  .notes { margin-top: 40px; color: var(--muted); max-width: 820px; } .notes a { color: var(--accent); }
  @media (max-width: 960px) { .player { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
  <div class="kicker">Neon Video Studio · tour</div>
  <h1>${escape(script.youtube.title)}</h1>
  <p class="lede">${escape(description)}</p>
  <div class="player">
    <video id="v" controls preload="metadata" poster="poster.png">
      <source src="neon-video-studio.mp4" type="video/mp4">
      <track kind="captions" src="neon-video-studio.vtt" srclang="en" label="English" default>
    </video>
    <aside>
      <h2>Chapters</h2>
      ${chapters.map((c) => `<button data-t="${c.at.toFixed(2)}"><time>${clock(c.at)}</time><span>${escape(c.title)}</span></button>`).join("\n      ")}
    </aside>
  </div>
  <div class="notes">
    <p>Everything on screen is the real app from source, driven by a script against demo projects built from the Git Gud tour episodes. An agent scripted, recorded, edited and rendered it through <code>neon-cli</code>. The narration is a synthetic voice (Kokoro, <code>af_heart</code>).</p>
    <p><a href="https://github.com/joe-lloyd/neon-video-studio">Neon Video Studio on GitHub</a> · <a href="https://github.com/joe-lloyd/neon-video-studio/releases">Releases</a></p>
  </div>
</main>
<script>
  const video = document.getElementById("v");
  const buttons = [...document.querySelectorAll("[data-t]")];
  for (const b of buttons) b.addEventListener("click", () => { video.currentTime = Number(b.dataset.t); video.play(); });
  video.addEventListener("timeupdate", () => {
    let current = buttons[0];
    for (const b of buttons) if (Number(b.dataset.t) <= video.currentTime + 0.05) current = b;
    for (const b of buttons) b.classList.toggle("active", b === current);
  });
</script>
</body>
</html>
`;
await writeFile(join(OUT, "index.html"), html);
process.stdout.write(`${join(OUT, "index.html")}\n`);
