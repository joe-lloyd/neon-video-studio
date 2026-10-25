// Narrates every line of script.json with the local Kokoro TTS server and records how long each takes.
//
//   docker run -d --rm --name kokoro-tours -p 8882:8880 ghcr.io/remsky/kokoro-fastapi-cpu:v0.9.0
//   node video/tour/tools/voice.mjs
//
// Writes build/vo/<section>.<line>.mp3 and build/vo/manifest.json with each line's duration and
// word timings. Lines whose text and voice are unchanged are not regenerated.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "build", "vo");
const KOKORO = process.env.KOKORO_URL ?? "http://127.0.0.1:8882";
// The voice of the Git Gud, htmlify and Open Chinese tours, so the channel sounds like one narrator.
const VOICE = process.env.VOICE ?? "af_heart";
const FFPROBE = process.env.FFPROBE ?? join(homedir(), ".neon-video", "tools", "ffprobe");

/** Spoken forms for words the model reads wrong. Applied to the audio only, never to captions. */
export const PRONOUNCE = [
  [/\bneon-cli\b/g, "neon C L I"],
  [/\bGit Gud\b/g, "Git Good"],
  [/\bYjs\b/g, "Y J S"],
  [/\bFX\b/g, "F X"],
  [/\bMP4\b/g, "M P 4"],
  [/\bH\.264\b/g, "H two six four"],
  [/\bPNG\b/g, "P N G"],
  [/\bCLI\b/g, "C L I"],
  [/\bAPI\b/g, "A P I"],
  [/\bUI\b/g, "U I"],
  [/\bpack\.json\b/g, "pack dot jason"],
  [/\bindex\.tsx\b/g, "index dot T S X"],
  [/\bwhisper\.cpp\b/g, "whisper C P P"],
  [/\byt-dlp\b/g, "Y T D L P"],
  [/\bffmpeg\b/g, "F F mpeg"],
  [/\b4K\b/g, "four K"],
  [/\bums\b/g, "umms"],
];

export const spoken = (text) => PRONOUNCE.reduce((t, [pattern, replacement]) => t.replace(pattern, replacement), text);

if (import.meta.url === `file://${process.argv[1]}`) {
  const script = JSON.parse(await readFile(join(ROOT, "script.json"), "utf8"));
  await mkdir(OUT, { recursive: true });
  const manifestPath = join(OUT, "manifest.json");
  const previous = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, "utf8")) : { lines: [] };
  const lines = [];
  for (const [s, section] of script.sections.entries()) {
    for (const [l, line] of section.lines.entries()) {
      const id = `${s + 1}.${l + 1}`;
      const file = join(OUT, `${id}.mp3`);
      const cached = previous.lines.find((p) => p.say === line.say && p.voice === VOICE && existsSync(join(OUT, p.file)));
      if (cached) {
        // Lines move when the script changes; reuse the audio under the new id.
        if (cached.id !== id) await writeFile(file, await readFile(join(OUT, cached.file)));
        lines.push({ ...cached, id, file: `${id}.mp3` });
        continue;
      }
      const response = await fetch(`${KOKORO}/dev/captioned_speech`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "kokoro", voice: VOICE, input: spoken(line.say), response_format: "mp3", stream: false }),
      });
      if (!response.ok) throw new Error(`Kokoro failed on ${id}: HTTP ${response.status} ${await response.text()}`);
      const body = await response.json();
      await writeFile(file, Buffer.from(body.audio, "base64"));
      const duration = Number(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());
      const words = (body.timestamps ?? []).map((w) => ({ word: w.word, start: w.start_time, end: w.end_time }));
      lines.push({ id, say: line.say, voice: VOICE, file: `${id}.mp3`, duration, words });
      process.stdout.write(`${id}  ${duration.toFixed(2)}s  ${line.say.slice(0, 70)}\n`);
    }
  }
  const total = lines.reduce((sum, l) => sum + l.duration, 0);
  await writeFile(manifestPath, `${JSON.stringify({ voice: VOICE, total, lines }, null, 2)}\n`);
  process.stdout.write(`${lines.length} lines, ${(total / 60).toFixed(1)} minutes of narration\n`);
}
