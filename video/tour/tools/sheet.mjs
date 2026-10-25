// Contact sheet of a take: one frame shortly after each line starts, plus one mid-line, labelled.
//   node video/tour/tools/sheet.mjs <take>   → build/sheets/<take>.png
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VIDEO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FFMPEG = join(homedir(), ".neon-video", "tools", "ffmpeg");
const [take] = process.argv.slice(2);
const dir = join(VIDEO, "build", "takes");
const meta = JSON.parse(readFileSync(join(dir, `${take}.json`), "utf8"));
const tmp = join(VIDEO, "build", "sheets", take);
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const points = [];
meta.lines.forEach((l, i) => {
  const end = meta.lines[i + 1]?.start ?? meta.duration;
  points.push([l.start + 0.3, `${l.id} start`], [l.start + (end - l.start) * 0.5, `${l.id} mid`], [end - 0.4, `${l.id} end`]);
});
points.forEach(([t, label], i) => {
  execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-ss", String(t), "-i", join(dir, `${take}.mp4`), "-frames:v", "1",
    "-vf", `scale=640:-1,drawtext=fontfile=/System/Library/Fonts/Helvetica.ttc:text='${label}':x=8:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6`, join(tmp, `${String(i).padStart(3, "0")}.png`)]);
});
const out = join(VIDEO, "build", "sheets", `${take}.png`);
execFileSync(FFMPEG, ["-loglevel", "error", "-y", "-pattern_type", "glob", "-i", join(tmp, "*.png"), "-vf", "tile=3x" + Math.ceil(points.length / 3), out]);
rmSync(tmp, { recursive: true, force: true });
console.log(out, `${meta.duration.toFixed(1)}s`);
