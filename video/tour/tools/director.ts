// Records a Chromium page as video while acting out narrated script lines.
//
// Frames come from the DevTools screencast, so the footage is the page at full resolution with
// no window chrome. Each line waits for its narration, so the actions land on the words that
// describe them. The edit later places each line's voice-over at the time recorded here.
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CDPSession, Locator, Page } from "playwright-core";

export type Word = { word: string; start: number; end: number };
export type VoLine = { id: string; say: string; duration: number; words: Word[] };

/** Things the edit adds on top of the footage, timed in seconds from the start of the take. */
export type TakeEvent =
  | { kind: "keys"; at: number; combo: string }
  | { kind: "zoom"; from: number; to: number; center: [number, number]; zoom: number }
  | { kind: "callout"; at: number; duration: number; text: string; x: number; y: number };

export type TakeResult = { name: string; video: string; duration: number; lines: { id: string; start: number; end?: number }[]; events: TakeEvent[] };

const FFMPEG = process.env.FFMPEG ?? join(homedir(), ".neon-video", "tools", "ffmpeg");
const FPS = 30;
/** Silence after each line, so actions and speech have room to breathe. */
export const LINE_GAP = 1.1;

const CURSOR_SCRIPT = (touch: boolean) => `(() => {
  if (document.getElementById("__dir_cursor")) return;
  const c = document.createElement("div");
  c.id = "__dir_cursor";
  c.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transition:transform 0ms;will-change:transform;";
  c.innerHTML = ${JSON.stringify(
    touch
      ? '<div style="width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;background:rgba(255,255,255,0.55);border:2px solid rgba(20,20,30,0.45);box-shadow:0 2px 8px rgba(0,0,0,0.35)"></div>'
      : '<svg width="26" height="30" viewBox="0 0 26 30" style="filter:drop-shadow(0 2px 3px rgba(0,0,0,0.45))"><path d="M2 2 L2 24 L8 18.5 L12.5 28 L16.5 26.2 L12.2 17 L20 17 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  )};
  document.documentElement.appendChild(c);
  window.__dirMove = (x, y, ms) => { c.style.transition = "transform " + ms + "ms cubic-bezier(.45,.05,.25,1)"; c.style.transform = "translate(" + x + "px," + y + "px)"; };
  window.__dirPulse = (x, y) => {
    const p = document.createElement("div");
    p.style.cssText = "position:fixed;left:" + (x - 22) + "px;top:" + (y - 22) + "px;width:44px;height:44px;border-radius:50%;border:3px solid #ff4fc3;z-index:2147483646;pointer-events:none;transition:transform 450ms ease-out,opacity 450ms ease-out;opacity:0.95";
    document.documentElement.appendChild(p);
    requestAnimationFrame(() => { p.style.transform = "scale(1.9)"; p.style.opacity = "0"; });
    setTimeout(() => p.remove(), 500);
  };
})()`;

export class Take {
  private frames: { t: number; data: Buffer }[] = [];
  private clockStart = 0;
  private lineStarts: { id: string; start: number; end?: number }[] = [];
  private events: TakeEvent[] = [];
  private current: { line: VoLine; start: number } | undefined;
  private cursor = { x: 0, y: 0 };
  private cdp: CDPSession | undefined;

  readonly name: string;
  readonly page: Page;
  private readonly vo: Map<string, VoLine>;
  private readonly opts: { outDir: string; touch?: boolean; viewport: { width: number; height: number } };

  constructor(name: string, page: Page, vo: Map<string, VoLine>, opts: { outDir: string; touch?: boolean; viewport: { width: number; height: number } }) {
    this.name = name;
    this.page = page;
    this.vo = vo;
    this.opts = opts;
    this.cursor = { x: opts.viewport.width * 0.6, y: opts.viewport.height * 0.55 };
  }

  /** Seconds since the take's clock started. */
  now(): number {
    return Date.now() / 1000 - this.clockStart;
  }

  async start(): Promise<void> {
    await this.ensureCursor();
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on("Page.screencastFrame", (frame) => {
      this.frames.push({ t: frame.metadata.timestamp ?? Date.now() / 1000, data: Buffer.from(frame.data, "base64") });
      void this.cdp?.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
    });
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1080 });
    await this.page.waitForTimeout(400);
    this.clockStart = Date.now() / 1000;
  }

  /** Re-adds the cursor after a reload and puts it back where it was. */
  async ensureCursor(): Promise<void> {
    await this.page.evaluate(CURSOR_SCRIPT(!!this.opts.touch));
    await this.page.evaluate(({ x, y }) => (window as unknown as { __dirMove: (x: number, y: number, ms: number) => void }).__dirMove(x, y, 0), this.cursor);
  }

  /**
   * Plays one narrated line: starts it once the previous line and its actions are done, runs
   * `act` while the line is "spoken", then holds until the line and its gap are over.
   */
  async line(id: string, act: () => Promise<void> = async () => {}): Promise<void> {
    const line = this.vo.get(id);
    if (!line) throw new Error(`No narration for line ${id}`);
    const start = this.now();
    const entry: { id: string; start: number; end?: number } = { id, start };
    this.lineStarts.push(entry);
    this.current = { line, start };
    await act();
    await this.until(start + line.duration + LINE_GAP);
    // Where the line really ends, so a take recorded alongside another can be cut without the other's turns.
    entry.end = this.now();
    this.current = undefined;
  }

  /** Waits until the current line reaches `word` (its nth occurrence), or a fraction of the line. */
  async cue(where: string | number, nth = 1): Promise<void> {
    if (!this.current) throw new Error("cue() outside a line");
    const { line, start } = this.current;
    let offset: number;
    if (typeof where === "number") offset = line.duration * where;
    else {
      const matches = line.words.filter((w) => w.word.toLowerCase().replace(/[^a-z0-9-]/g, "") === where.toLowerCase());
      const word = matches[nth - 1];
      if (!word) throw new Error(`Line ${line.id} has no word "${where}" (#${nth}): ${line.say}`);
      offset = word.start;
    }
    await this.until(start + offset);
  }

  async until(t: number): Promise<void> {
    const wait = (t - this.now()) * 1000;
    if (wait > 0) await this.page.waitForTimeout(wait);
  }

  async pause(seconds: number): Promise<void> {
    await this.page.waitForTimeout(seconds * 1000);
  }

  async moveTo(target: Locator | { x: number; y: number }, ms = 650): Promise<{ x: number; y: number }> {
    let point: { x: number; y: number };
    if ("boundingBox" in target) {
      await target.waitFor({ state: "visible" });
      await target.scrollIntoViewIfNeeded();
      const box = await target.boundingBox();
      if (!box) throw new Error("Target has no box");
      point = { x: box.x + Math.min(box.width / 2, 60), y: box.y + box.height / 2 };
    } else point = target;
    await this.ensureCursor();
    await this.page.evaluate(({ x, y, ms }) => (window as unknown as { __dirMove: (x: number, y: number, ms: number) => void }).__dirMove(x, y, ms), { ...point, ms });
    await this.page.mouse.move(point.x, point.y, { steps: 8 });
    await this.page.waitForTimeout(ms);
    this.cursor = point;
    return point;
  }

  async click(target: Locator, opts: { modifiers?: ("Meta" | "Shift")[]; ms?: number } = {}): Promise<void> {
    const point = await this.moveTo(target, opts.ms);
    await this.page.evaluate(({ x, y }) => (window as unknown as { __dirPulse: (x: number, y: number) => void }).__dirPulse(x, y), point);
    for (const key of opts.modifiers ?? []) await this.page.keyboard.down(key);
    await this.page.mouse.click(point.x, point.y);
    for (const key of opts.modifiers ?? []) await this.page.keyboard.up(key);
    await this.page.waitForTimeout(250);
    // A click that navigates the page loses the injected cursor.
    await this.ensureCursor().catch(() => {});
  }

  async dblclick(target: Locator): Promise<void> {
    const point = await this.moveTo(target);
    await this.page.evaluate(({ x, y }) => (window as unknown as { __dirPulse: (x: number, y: number) => void }).__dirPulse(x, y), point);
    await this.page.mouse.dblclick(point.x, point.y);
    await this.page.waitForTimeout(250);
    await this.ensureCursor().catch(() => {});
  }

  /** Right-clicks `target` to open its context menu. */
  async rightClick(target: Locator): Promise<void> {
    const point = await this.moveTo(target);
    await this.page.evaluate(({ x, y }) => (window as unknown as { __dirPulse: (x: number, y: number) => void }).__dirPulse(x, y), point);
    await this.page.mouse.click(point.x, point.y, { button: "right" });
    await this.page.waitForTimeout(250);
  }

  /** Presses at `from`, glides to `to` over `ms`, and releases, with the cursor following. */
  async drag(from: { x: number; y: number }, to: { x: number; y: number }, ms = 1600): Promise<void> {
    await this.moveTo(from);
    await this.page.mouse.down();
    const steps = Math.max(10, Math.round(ms / 40));
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await this.page.evaluate(({ x, y }) => (window as unknown as { __dirMove: (x: number, y: number, ms: number) => void }).__dirMove(x, y, 40), { x, y });
      await this.page.mouse.move(x, y);
      await this.page.waitForTimeout(ms / steps);
    }
    await this.page.mouse.up();
    this.cursor = to;
  }

  async type(target: Locator, text: string, delay = 55): Promise<void> {
    await this.click(target);
    await target.pressSequentially(text, { delay });
  }

  keys(combo: string): void {
    this.events.push({ kind: "keys", at: this.now(), combo });
  }

  /** Zooms the edit into `center` (fractions of the frame) from now for `seconds`. */
  zoom(center: [number, number], seconds: number, zoom = 1.6): void {
    const at = this.now();
    this.events.push({ kind: "zoom", from: at, to: at + seconds, center, zoom });
  }

  callout(text: string, x: number, y: number, duration = 3): void {
    this.events.push({ kind: "callout", at: this.now(), duration, text, x, y });
  }

  /** Stops capture and encodes the take as a constant-frame-rate H.264 file. */
  async finish(tail = 0.4): Promise<TakeResult> {
    await this.page.waitForTimeout(tail * 1000);
    const end = this.now();
    await this.cdp?.send("Page.stopScreencast");
    await this.cdp?.detach().catch(() => {});
    const dir = join(this.opts.outDir, `${this.name}-frames`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    // Each frame stays on screen until the next one. The last frame before the clock started
    // opens the take, because the screen showed it at time zero.
    const firstAfter = this.frames.findIndex((f) => f.t >= this.clockStart);
    const usable = this.frames.slice(firstAfter === -1 ? this.frames.length - 1 : Math.max(firstAfter - 1, 0));
    const list: string[] = ["ffconcat version 1.0"];
    for (const [i, frame] of usable.entries()) {
      const file = `${String(i).padStart(6, "0")}.jpg`;
      await writeFile(join(dir, file), frame.data);
      const from = Math.max(0, frame.t - this.clockStart);
      const to = Math.min(end, (usable[i + 1]?.t ?? this.clockStart + end) - this.clockStart);
      list.push(`file ${file}`, `duration ${Math.max(to - from, 0.001).toFixed(4)}`);
    }
    list.push(`file ${String(usable.length - 1).padStart(6, "0")}.jpg`);
    await writeFile(join(dir, "list.ffconcat"), `${list.join("\n")}\n`);
    const video = join(this.opts.outDir, `${this.name}.mp4`);
    execFileSync(FFMPEG, [
      "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "list.ffconcat"),
      "-vf", `fps=${FPS},scale=1920:1080:flags=lanczos,format=yuv420p`,
      "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-movflags", "+faststart", video,
    ]);
    await rm(dir, { recursive: true, force: true });
    const result: TakeResult = { name: this.name, video, duration: end, lines: this.lineStarts, events: this.events };
    await writeFile(join(this.opts.outDir, `${this.name}.json`), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
}
