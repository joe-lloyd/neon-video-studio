// Everything YouTube needs, made from the edit: the thumbnail from Neon's Thumb feature, and the
// title, description, chapters, tags and captions. Nothing is uploaded.
//
//   node video/tour/tools/publish.ts     # after edit.ts --render, with the edit's Neon running
//
// Writes build/thumbs/neon-video-studio.png and build/publish/.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { VoLine } from "./director.ts";
import { neon } from "./neon.ts";
import { BUILD, PROJECT, RENDER, type Script, VIDEO } from "./tour.ts";

const OUT = join(BUILD, "publish");
const FPS = 30;
const REPO = "https://github.com/joe-lloyd/neon-video-studio";
const FFPROBE = join(homedir(), ".neon-video", "tools", "ffprobe");

const script: Script = JSON.parse(await readFile(join(VIDEO, "script.json"), "utf8"));
type Placed = { sections: { title: string; lines: { say: string; at: number; duration: number }[] }[] };
const placed: Placed = JSON.parse(await readFile(join(BUILD, "neon", "script.json"), "utf8"));
const vo = new Map<string, VoLine>(JSON.parse(await readFile(join(BUILD, "vo", "manifest.json"), "utf8")).lines.map((l: VoLine) => [l.id, l]));
const length = Number(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", RENDER]).toString());

// ---- thumbnail: a frame of the edit under the pack's thumbnail layer -------------------------
neon("project", "open", PROJECT);
const state = neon<{ layers: { id: string }[] }>("api", "GET", "thumbnail");
if (state.layers.length) neon("thumbnail", "remove", ...state.layers.map((l) => l.id));
const [s, l] = script.youtube.thumbFrom.split(".").map(Number);
const from = placed.sections[s! - 1]!.lines[l! - 1]!;
neon("thumbnail", "background", "--at", `${from.at + Math.round(from.duration * 0.6)}f`);
neon("thumbnail", "add", "--component", "NeonThumbnail", "--props", JSON.stringify({ title: script.youtube.thumbTitle, kicker: script.youtube.thumbKicker }), "--pos", "0.5,0.5", "--scale", "1");
await mkdir(join(BUILD, "thumbs"), { recursive: true });
const thumb = join(BUILD, "thumbs", "neon-video-studio.png");
neon("thumbnail", "render", "--out", thumb);
neon("project", "save");

// ---- captions: each line split at sentence ends or every eight words, timed from the voice ----
const stamp = (seconds: number, sep = ".") => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const sec = seconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${sec.toFixed(3).padStart(6, "0").replace(".", sep)}`;
};
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
type Cue = { from: number; to: number; text: string };
const cues: Cue[] = [];
const chapters: { title: string; at: number }[] = [];
for (const [si, section] of placed.sections.entries()) {
  for (const [li, line] of section.lines.entries()) {
    const start = line.at / FPS;
    if (li === 0) {
      // YouTube chapters: the first at 0:00, each at least ten seconds long.
      const at = chapters.length === 0 ? 0 : Math.max(0, start - 0.4);
      if (chapters.length === 0 || at - chapters.at(-1)!.at >= 10) chapters.push({ title: section.title, at });
    }
    const words = vo.get(`${si + 1}.${li + 1}`)?.words.filter((w) => /\w/.test(w.word)) ?? [];
    if (!words.length) continue;
    // The script's own spelling, so "neon-cli" and "FX" read as written.
    const written = line.say.split(/\s+/);
    const perWord = words.length / written.length;
    let chunk: { text: string[]; from: number; to: number } | undefined;
    const flush = () => {
      if (chunk) cues.push({ from: start + chunk.from, to: start + chunk.to, text: chunk.text.join(" ") });
      chunk = undefined;
    };
    written.forEach((text, i) => {
      const w = words[Math.min(words.length - 1, Math.floor(i * perWord))]!;
      chunk ??= { text: [], from: w.start, to: w.end };
      chunk.text.push(text);
      chunk.to = w.end;
      if (/[.?!:]$/.test(text) || chunk.text.length >= 8) flush();
    });
    flush();
  }
}

const tags = ["Neon Video Studio", "video editor", "AI agent", "neon-cli", "screen recording", "React", "Bun", "Yjs", "open source", "developer tools", "YouTube thumbnail", "local first"];
const description = [
  "A tour of Neon Video Studio, a desktop video editor where every button is also a command, so an AI agent can edit a video through neon-cli while you watch the changes land in the app.",
  "",
  "Chapters",
  ...chapters.map((c) => `${clock(c.at)} ${c.title}`),
  "",
  `Neon Video Studio on GitHub: ${REPO}`,
  `Download for Mac, Windows and Linux: ${REPO}/releases`,
  "",
  "Everything on screen is the real app, driven by a script against demo projects. This video was scripted, recorded, edited and rendered by an agent through neon-cli.",
  "The narration is a synthetic voice (Kokoro).",
].join("\n");

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "title.txt"), `${script.youtube.title}\n`);
await writeFile(join(OUT, "description.md"), `${description}\n`);
await writeFile(join(OUT, "chapters.txt"), `${chapters.map((c) => `${clock(c.at)} ${c.title}`).join("\n")}\n`);
await writeFile(join(OUT, "tags.txt"), `${tags.join(", ")}\n`);
await writeFile(join(OUT, "captions.vtt"), ["WEBVTT", "", ...cues.flatMap((c) => [`${stamp(c.from)} --> ${stamp(c.to)}`, c.text, ""])].join("\n"));
await writeFile(join(OUT, "captions.srt"), cues.map((c, i) => `${i + 1}\n${stamp(c.from, ",")} --> ${stamp(c.to, ",")}\n${c.text}\n`).join("\n"));
await writeFile(join(OUT, "chapters.json"), JSON.stringify(chapters, null, 2));
process.stdout.write(`${thumb}\n${OUT}: ${chapters.length} chapters, ${cues.length} captions, ${clock(length)} long\n`);
