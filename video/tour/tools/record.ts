// Records the takes of the tour against the real app: a headless Neon from this checkout with the
// renderer in a browser (see demo.ts).
//
//   node video/tour/tools/voice.mjs
//   node video/tour/tools/record.ts [take...]      # no arguments records every take
//
// Takes land in build/takes/<take>.mp4 plus <take>.json with each line's start time.
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { Take, type VoLine } from "./director.ts";
import { ensureVite, VIDEO } from "./demo.ts";
import { takes } from "./takes.ts";

export const VIEWPORT = { width: 1440, height: 810 };
const BROWSER = process.env.NEON_CHROME ?? join(homedir(), ".neon-video", "browser", "155.0.8059.39", "chrome-headless-shell-mac-x64", "chrome-headless-shell");
const OUT = join(VIDEO, "build", "takes");

export type Ctx = {
  /** A fresh 1440×810 page drawn at 1920×1080. */
  page(): Promise<Page>;
  take(name: string, page: Page): Promise<Take>;
};
export type TakeFn = (ctx: Ctx) => Promise<void>;

const manifestFile = join(VIDEO, "build", "vo", "manifest.json");
if (!existsSync(manifestFile)) throw new Error("No narration; run voice.mjs first");
const vo = new Map<string, VoLine>(JSON.parse(await readFile(manifestFile, "utf8")).lines.map((l: VoLine) => [l.id, l]));

// Pre-flight: every t.cue("word") must name a word of its line, or the take dies minutes in.
const source = await readFile(join(VIDEO, "tools", "takes.ts"), "utf8");
const problems: string[] = [];
for (const block of source.split(/\b\w\.line\("/).slice(1)) {
  const lineId = block.slice(0, block.indexOf('"'));
  const line = vo.get(lineId);
  if (!line) {
    problems.push(`${lineId}: no such line`);
    continue;
  }
  const spoken = line.words.map((w) => w.word.toLowerCase().replace(/[^a-z0-9-]/g, ""));
  for (const [, word, nth] of block.matchAll(/\b\w\.cue\("([^"]+)"(?:,\s*(\d+))?\)/g)) {
    if (spoken.filter((w) => w === word!.toLowerCase()).length < Number(nth ?? 1)) problems.push(`${lineId}: no "${word}" in "${line.say}"`);
  }
}
if (problems.length) throw new Error(`cues:\n  ${problems.join("\n  ")}`);

await ensureVite();
await mkdir(OUT, { recursive: true });
const wanted = process.argv.slice(2);
for (const [name, fn] of Object.entries(takes)) {
  if (wanted.length && !wanted.includes(name)) continue;
  process.stdout.write(`▶ ${name}\n`);
  const browser: Browser = await chromium.launch({ executablePath: BROWSER, args: ["--autoplay-policy=no-user-gesture-required", "--hide-scrollbars"] });
  const pages: Page[] = [];
  const ctx: Ctx = {
    async page() {
      const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1920 / VIEWPORT.width });
      page.on("pageerror", (e) => process.stdout.write(`  page error: ${e.message}\n`));
      pages.push(page);
      return page;
    },
    async take(takeName, page) {
      const take = new Take(takeName, page, vo, { outDir: OUT, viewport: VIEWPORT });
      await take.start();
      return take;
    },
  };
  try {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${name} ran over 6 minutes`)), 6 * 60_000);
    });
    await Promise.race([fn(ctx), limit]).finally(() => clearTimeout(timer));
  } catch (error) {
    // What the screen showed when the take broke is usually the whole story.
    const debug = join(VIDEO, "build", "debug");
    await mkdir(debug, { recursive: true });
    for (const [i, page] of pages.entries()) await page.screenshot({ path: join(debug, `${name}-${i}.png`) }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}
