// Contact sheet of the render: a frame 3 s into every chapter plus one every 20 s, labelled.
//   node video/tour/tools/check.mjs   → build/sheets/render-check.png
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VIDEO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FFMPEG = join(homedir(), ".neon-video", "tools", "ffmpeg");
const FFPROBE = join(homedir(), ".neon-video", "tools", "ffprobe");
const render = join(VIDEO, "build", "renders", "neon-video-studio.mp4");
const length = Number(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", render]).toString());
const chapters = JSON.parse(readFileSync(join(VIDEO, "build", "publish", "chapters.json"), "utf8"));
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const points = [...chapters.map((c) => [c.at + 3, `${clock(c.at + 3)} ${c.title}`])];
for (let t = 10; t < length; t += 20) points.push([t, clock(t)]);
points.sort((a, b) => a[0] - b[0]);
const tmp = join(VIDEO, "build", "sheets", "check");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
points.forEach(([t, label], i) => {
  execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-ss", String(t), "-i", render, "-frames:v", "1",
    "-vf", `scale=480:-1,drawtext=fontfile=/System/Library/Fonts/Helvetica.ttc:text='${label.replace(/[':]/g, (c) => (c === ":" ? "\\:" : ""))}':x=6:y=6:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.7`, join(tmp, `${String(i).padStart(3, "0")}.png`)]);
});
const out = join(VIDEO, "build", "sheets", "render-check.png");
execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-pattern_type", "glob", "-i", join(tmp, "*.png"), "-vf", `tile=4x${Math.ceil(points.length / 4)}`, out]);
console.log(out, `${points.length} frames, ${clock(length)}`);
