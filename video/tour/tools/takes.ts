// The takes: each one sets up the demo, opens the real app and acts out its lines of script.json.
// Off-camera setup runs before take.start(); everything after it is on screen.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Frame, Locator, Page } from "playwright-core";
import type { Take } from "./director.ts";
import { appUrl, demo, freshInstance, PEER_HOME, seedAll, seedTrailer, seedWalkthrough, TRAILER, VIDEO } from "./demo.ts";
import { DEMO_HOME, neonAt, neonText } from "./neon.ts";
import type { Ctx, TakeFn } from "./record.ts";

const STAGE = join(VIDEO, "stage");
const SCRATCH = join(VIDEO, "build", "scratch");

/** Browser mode draws its own window buttons; the desktop app on a Mac has traffic lights instead. */
const HIDE_WINDOW_BUTTONS = ".window-controls{display:none!important}";

/** Centre of `target` as fractions of the frame, for callouts and zooms. */
async function fraction(page: Page, target: Locator): Promise<[number, number]> {
  const box = await target.boundingBox();
  if (!box) throw new Error("Target has no box");
  const size = page.viewportSize()!;
  return [(box.x + box.width / 2) / size.width, (box.y + box.height / 2) / size.height];
}
async function callout(t: Take, target: Locator, text: string, seconds = 3) {
  const [x, y] = await fraction(t.page, target);
  t.callout(text, x, y, seconds);
}
async function zoomTo(t: Take, target: Locator, seconds: number, zoom = 1.6) {
  t.zoom(await fraction(t.page, target), seconds, zoom);
}
/** Glides the cursor across several targets in turn, pausing on each. */
async function sweep(t: Take, targets: Locator[], pause = 0.35) {
  for (const target of targets) {
    await t.moveTo(target, 450);
    await t.pause(pause);
  }
}
const centre = async (l: Locator) => {
  const b = await l.boundingBox();
  if (!b) throw new Error("no box");
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
/** Drags with the real mouse off camera, in small steps so pointer handlers see a move. */
async function quietDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12);
    await page.waitForTimeout(25);
  }
  await page.mouse.up();
}

/** A point on a timeline clip clear of its volume line, which runs through the middle. */
const grab = async (l: Locator, fx = 0.5) => {
  const b = await l.boundingBox();
  if (!b) throw new Error("no box");
  return { x: b.x + Math.min(b.width * fx, b.width - 20), y: b.y + b.height * 0.28 };
};
/** Selects a clip the way a person does: one click on its body. */
async function selectClip(t: Take, l: Locator) {
  const p = await grab(l, 0.15);
  await t.moveTo(p, 500);
  await t.page.mouse.click(p.x, p.y);
  await t.pause(0.2);
}

type Root = Page | Frame;
/** Waits for the editor, closes the overview, and sets the panel sizes every take uses. */
async function prepareEditor(page: Page, root: Root = page, opts: { side?: number; timeline?: number } = {}) {
  await root.locator(".titlebar").waitFor({ timeout: 30_000 });
  await root.addStyleTag({ content: HIDE_WINDOW_BUTTONS });
  const close = root.locator('[title="Close (Esc)"]');
  if (await close.isVisible().catch(() => false)) await close.click();
  await page.waitForTimeout(500);
  if (root === page) {
    const side = await centre(page.locator(".side-resize"));
    await quietDrag(page, { x: side.x, y: side.y + 120 }, { x: side.x - (opts.side ?? 80), y: side.y + 120 });
    const tl = await centre(page.locator(".timeline-resize"));
    await quietDrag(page, { x: tl.x + 200, y: tl.y }, { x: tl.x + 200, y: tl.y + (opts.timeline ?? 20) });
  }
  await root.locator('[title="Fit timeline"]').click();
  await page.waitForTimeout(800);
}

async function openApp(ctx: Ctx, url = appUrl()) {
  const page = await ctx.page();
  await page.goto(url);
  // The renderer settles (packs, proxies, project) a moment after the first paint.
  await page.waitForTimeout(2500);
  return page;
}
/** Moves the playhead by clicking the ruler at `seconds`, given the timeline's px per frame. */
async function rulerX(root: Root, seconds: number): Promise<{ x: number; y: number }> {
  const ruler = await root.locator(".tl-ruler").boundingBox();
  const px = await pxPerFrame(root);
  const scroll = await root.locator(".tl-lanes").evaluate((el) => el.scrollLeft);
  if (!ruler) throw new Error("no ruler");
  return { x: ruler.x + seconds * 30 * px - scroll, y: ruler.y + ruler.height / 2 };
}
/** The timeline's zoom, read off the status bar ("2.00 px/f"). */
async function pxPerFrame(root: Root): Promise<number> {
  const text = (await root.locator(".statusbar, .status-bar, footer").first().textContent()) ?? "";
  const m = /([\d.]+) px\/f/.exec(text);
  if (!m) throw new Error(`No px/f in status bar: ${text}`);
  return Number(m[1]);
}
const clip = (root: Root, name: string, nth = 0) => root.locator(".clip", { has: root.locator(".clip-name", { hasText: new RegExp(`^${name}$`) }) }).nth(nth);
const tab = (root: Root, panel: string) => root.locator(`.side-tabs button[data-panel="${panel}"]`);

// ---------------------------------------------------------------------------------------------

const overview: TakeFn = async (ctx) => {
  await freshInstance(DEMO_HOME);
  await seedAll();
  const page = await openApp(ctx);
  await prepareEditor(page);
  await page.locator('[title="Projects overview"]').click();
  await page.locator(".start-grid").waitFor();
  await page.waitForTimeout(800);
  const t = await ctx.take("overview", page);
  const items = page.locator(".start-grid .list-item");
  await t.line("2.1", async () => {
    // The overview is a dialog in the middle of the window; hold a zoom on it.
    await zoomTo(t, page.locator(".start-grid"), 18.5, 1.55);
    await t.pause(0.6);
    await sweep(t, [items.nth(0), items.nth(1), items.nth(2), items.nth(3)], 0.45);
    await t.cue("folder");
    await t.moveTo(items.nth(0).locator(".meta"), 600);
  });
  await t.line("2.2", async () => {
    await t.cue("name");
    await t.type(page.getByPlaceholder("Client video 01"), "Product demo", 70);
    await t.cue("format");
    const format = page.locator(".start-grid select").first();
    await t.click(format);
    await format.selectOption({ index: 1 });
    await t.cue("frame");
    const fps = page.locator(".start-grid select").nth(1);
    await t.click(fps);
    await fps.selectOption("60");
    await t.cue("vertical");
    await callout(t, format, "Vertical and square for shorts", 3);
  });
  await t.line("2.3", async () => {
    await t.click(items.nth(0));
    await t.pause(0.6);
  });
  await t.finish(0.6);
};

const timeline: TakeFn = async (ctx) => {
  await seedTrailer();
  const page = await openApp(ctx);
  await prepareEditor(page);
  // Start with the playhead in the second shot, so the preview has a picture.
  const start = await rulerX(page, 7.5);
  await page.mouse.click(start.x, start.y);
  await page.waitForTimeout(1500);
  const t = await ctx.take("timeline", page);
  await t.line("3.1", async () => {
    await t.cue("video");
    await sweep(t, [page.locator(".tl-headers").getByText("V1", { exact: true }), page.locator(".tl-headers").getByText("A1", { exact: true }), page.locator(".tl-headers").getByText("FX1", { exact: true })], 0.4);
    await t.cue("waveform");
    await zoomTo(t, clip(page, "VO 2"), 3.4, 1.8);
    await t.moveTo(clip(page, "VO 2"), 600);
    await t.pause(0.4);
    await t.moveTo(clip(page, "Music bed"), 600);
  });
  await t.line("3.2", async () => {
    const last = clip(page, "Push and pull");
    const from = await grab(last);
    await t.drag(from, { x: from.x + 160, y: from.y }, 1100);
    await t.pause(0.3);
    await t.cue("snaps");
    // Drop a few pixels past the previous clip's end; snapping pulls it onto the edge.
    const prev = await clip(page, "Commit graph").boundingBox();
    const now = await last.boundingBox();
    await t.drag({ x: now!.x + now!.width / 2, y: from.y }, { x: prev!.x + prev!.width + now!.width / 2 + 7, y: from.y }, 1300);
  });
  await t.line("3.3", async () => {
    const box = (await clip(page, "Commit graph").boundingBox())!;
    const edge = { x: box.x + 2, y: box.y + box.height / 2 };
    await t.cue("edge");
    await t.drag(edge, { x: edge.x + 70, y: edge.y }, 1200);
  });
  await t.line("3.4", async () => {
    const at = await rulerX(page, 8.5);
    await t.moveTo(at, 400);
    await page.mouse.click(at.x, at.y);
    // Split acts on the selection, so pick the shot under the playhead first.
    const shot = (await clip(page, "Architecture").boundingBox())!;
    await t.moveTo({ x: at.x + 30, y: shot.y + shot.height * 0.28 }, 400);
    await page.mouse.click(at.x + 30, shot.y + shot.height * 0.28);
    await t.cue("splits");
    await page.keyboard.press("s");
    t.keys("S");
    await t.pause(0.5);
    await zoomTo(t, page.locator(".tl-lanes"), 2.2, 1.3);
  });
  await t.line("3.5", async () => {
    await t.click(tab(page, "assets"));
    const row = page.locator(".list-item", { hasText: "conflict-b-roll.mp4" });
    await t.moveTo(row, 500);
    await t.cue("playhead");
    await t.click(row.locator('[title="Add at playhead"]'));
    await t.cue("never");
    await t.moveTo(clip(page, "conflict-b-roll.mp4"), 700);
  });
  await t.line("3.6", async () => {
    await t.cue("undo");
    await page.keyboard.press("ControlOrMeta+z");
    t.keys("Cmd+Z");
    await t.pause(0.9);
    await page.keyboard.press("ControlOrMeta+z");
    t.keys("Cmd+Z");
  });
  await t.line("3.7", async () => {
    await t.cue("mark");
    await page.keyboard.press("?");
    t.keys("?");
  });
  await page.keyboard.press("Escape");
  await t.finish(0.5);
};

const templates: TakeFn = async (ctx) => {
  await seedTrailer();
  const page = await openApp(ctx);
  await prepareEditor(page);
  const start = await rulerX(page, 5.2);
  await page.mouse.click(start.x, start.y);
  await page.waitForTimeout(1500);
  const t = await ctx.take("templates", page);
  await t.line("4.1", async () => {
    await t.cue("components");
    await t.click(tab(page, "templates"));
    await t.pause(0.5);
    await t.moveTo(page.locator(".fx-card").first(), 600);
    await t.pause(0.8);
    await t.moveTo(page.locator(".fx-card").nth(1), 600);
  });
  await t.line("4.2", async () => {
    await t.type(page.getByPlaceholder(/Search components/), "lower", 80);
    await t.cue("click");
    const card = page.locator(".fx-card", { hasText: "Lower Third" }).first();
    await t.moveTo(card, 500);
    await t.cue("lands");
    await t.click(card);
    // Into the clip, past its entrance, so the whole lower third is on screen.
    await t.pause(0.4);
    const inside = await rulerX(page, 6.6);
    await t.moveTo(inside, 500);
    await page.mouse.click(inside.x, inside.y);
  });
  await t.line("4.3", async () => {
    await t.click(tab(page, "inspector"));
    const title = page.locator(".field", { has: page.locator("label", { hasText: /^title$/i }) }).locator("input").first();
    await t.cue("change");
    await t.click(title);
    await page.keyboard.press("ControlOrMeta+a");
    await title.pressSequentially("Joe Lloyd", { delay: 80 });
    const subtitle = page.locator(".field", { has: page.locator("label", { hasText: /^subtitle$/i }) }).locator("input").first();
    await t.click(subtitle);
    await page.keyboard.press("ControlOrMeta+a");
    await subtitle.pressSequentially("Made Git Gud", { delay: 70 });
    await zoomTo(t, page.locator(".preview-stage"), 3, 1.35);
  });
  await t.line("4.4", async () => {
    const from = await centre(page.locator(".canvas-box:not(.idle)").first());
    const stage = (await page.locator(".preview-stage .player-wrap").boundingBox())!;
    await t.drag(from, { x: stage.x + stage.width * 0.5 + 3, y: stage.y + stage.height * 0.8 }, 1600);
    await t.cue("thirds");
    await t.pause(0.2);
  });
  await t.line("4.5", async () => {
    const animIn = page.locator(".field", { has: page.locator("label", { hasText: "Animate in" }) }).locator("select");
    await animIn.scrollIntoViewIfNeeded();
    await t.click(animIn);
    await animIn.selectOption("pop");
    await t.cue("pop");
    const back = await rulerX(page, 4.9);
    await page.mouse.click(back.x, back.y);
    await page.keyboard.press("Space");
    await t.pause(2.2);
    await page.keyboard.press("Space");
  });
  await t.finish(0.5);
};

const packs: TakeFn = async (ctx) => {
  await seedTrailer();
  // Neon Tour starts uninstalled, so the Library shows it arriving.
  execFileSync("rm", ["-rf", join(DEMO_HOME, "packs", "neon-tour"), join(TRAILER, "packs", "neon-tour")]);
  demo("packs", "reload");
  const page = await openApp(ctx);
  await prepareEditor(page);
  const start = await rulerX(page, 7.5);
  await page.mouse.click(start.x, start.y);
  await tab(page, "templates").click();
  await page.waitForTimeout(1500);
  const t = await ctx.take("packs", page);
  await t.line("5.2", async () => {
    await zoomTo(t, page.locator(".side"), 8, 1.5);
    await t.click(page.getByRole("tab", { name: "Library" }));
    await t.cue("folder");
    await t.moveTo(page.getByRole("button", { name: /Install folder/ }), 600);
    await t.cue("running");
    demo("packs", "install", join(VIDEO, "fx", "neon-tour"));
    await page.getByText("Neon Tour", { exact: true }).first().waitFor({ timeout: 8000 });
    await t.moveTo(page.getByText("Neon Tour", { exact: true }).first(), 600);
  });
  await t.line("5.3", async () => {
    await zoomTo(t, page.locator(".side"), 7, 1.5);
    await t.click(page.getByRole("tab", { name: "Components" }));
    await t.type(page.getByPlaceholder(/Search components/), "neon", 80);
    await t.pause(0.4);
    await t.moveTo(page.locator(".fx-card", { hasText: "Neon stage" }).first(), 600);
    await t.cue("colours");
    await t.click(page.locator(".fx-card", { hasText: "Neon title" }).first());
  });
  await t.line("5.4", async () => {
    await page.keyboard.press("Space");
    await t.pause(3);
    await page.keyboard.press("Space");
  });
  await t.finish(0.5);
};

const script: TakeFn = async (ctx) => {
  await seedTrailer();
  const page = await openApp(ctx);
  await prepareEditor(page);
  await page.waitForTimeout(800);
  const t = await ctx.take("script", page);
  await t.line("6.1", async () => {
    await t.click(page.locator(".titlebar").getByRole("button", { name: /^Script/ }));
    await t.pause(0.6);
    t.zoom([0.36, 0.33], 7.5, 1.5);
    await t.cue("sections");
    await t.moveTo(page.getByText("Features", { exact: true }).first(), 600);
    await t.cue("say");
    await t.moveTo(page.getByText("Every branch gets its own lane in the commit graph.").first(), 600);
    await t.cue("shows");
    await t.moveTo(page.getByText("Zoom on the lanes.").first(), 600);
  });
  await t.line("6.2", async () => {
    await t.cue("draft");
    await t.moveTo(page.getByText("your turn").nth(1), 500);
    await t.cue("approved");
    await t.moveTo(page.getByText("approved").first(), 500);
    await t.cue("notes");
    await t.moveTo(page.getByText("Can this line land on the zoom?"), 600);
    await t.cue("answers");
    // The agent's reply arrives through the CLI while the view is open.
    demo("notes", "reply", "#1", "It starts at 0:13 now, as the zoom begins.");
    await t.pause(0.6);
    await zoomTo(t, page.getByText("Can this line land on the zoom?"), 3, 1.6);
  });
  await t.line("6.3", async () => {
    await t.click(page.locator(".titlebar").getByRole("button", { name: "Edit", exact: true }));
    await t.click(tab(page, "script"));
    await t.click(page.getByRole("button", { name: "Prompter" }));
    const a = await rulerX(page, 13.6);
    await t.moveTo(a, 500);
    await page.mouse.click(a.x, a.y);
  });
  await t.line("6.4", async () => {
    const active = page.getByRole("button", { name: /Re-record line/ }).nth(1);
    await t.cue("record");
    await t.moveTo(active, 700);
    await zoomTo(t, active, 4, 1.6);
    await t.cue("replaces");
    await t.moveTo(page.getByRole("button", { name: /Re-record line/ }).nth(2), 700);
  });
  await t.finish(0.5);
};

const ai: TakeFn = async (ctx) => {
  await seedWalkthrough();
  const page = await openApp(ctx);
  await prepareEditor(page);
  const start = await rulerX(page, 2);
  await page.mouse.click(start.x, start.y);
  await page.waitForTimeout(1500);
  const t = await ctx.take("ai", page);
  await t.line("7.1", async () => {
    const screen = page.locator('[title="Record screen"]');
    await t.cue("screen");
    await t.moveTo(screen, 600);
    await callout(t, screen, "Screen + mic in one file", 3);
    await t.cue("recording", 2);
    await t.moveTo(page.locator(".clip").first(), 700);
  });
  await t.line("7.2", async () => {
    await selectClip(t, page.locator(".clip").first());
    await t.click(tab(page, "ai"));
    await t.cue("pills");
    await zoomTo(t, page.locator(".pill", { hasText: "whisper" }), 6.5, 1.9);
    await sweep(t, [page.locator(".pill", { hasText: "ffmpeg" }), page.locator(".pill", { hasText: "vision" }), page.locator(".pill", { hasText: "yt-dlp" })], 0.6);
    await t.cue("speech");
    await t.moveTo(page.locator(".pill", { hasText: "whisper" }), 500);
  });
  await t.line("7.3", async () => {
    const trim = page.getByRole("button", { name: /Trim dead air/ }).first();
    await trim.scrollIntoViewIfNeeded();
    await t.moveTo(trim, 500);
    await t.cue("pauses");
    await t.click(trim);
    await t.cue("cuts");
    await t.moveTo(page.locator(".tl-lanes"), 700);
  });
  await t.line("7.4", async () => {
    await selectClip(t, page.locator(".clip").first());
    const enhance = page.getByRole("button", { name: /Enhance voice/ }).first();
    await enhance.scrollIntoViewIfNeeded();
    await t.moveTo(enhance, 500);
    await t.cue("clearer");
    await t.click(enhance);
    await t.pause(1.5);
  });
  await t.line("7.5", async () => {
    const install = page.getByRole("button", { name: "Install automatically" });
    await install.scrollIntoViewIfNeeded();
    await t.moveTo(install, 700);
    await callout(t, install, "Installs whisper.cpp and a model", 3.5);
  });
  await t.line("7.6", async () => {
    // A zoom on one of the longer pieces, starting mid-way through it.
    const piece = page.locator(".clip").nth(3);
    const box = (await piece.boundingBox())!;
    const ruler = (await page.locator(".tl-ruler").boundingBox())!;
    await selectClip(t, piece);
    await t.click(tab(page, "inspector"));
    await t.moveTo({ x: box.x + box.width * 0.4, y: ruler.y + ruler.height / 2 }, 400);
    await page.mouse.click(box.x + box.width * 0.4, ruler.y + ruler.height / 2);
    const add = page.locator('button[title="Add a 2× zoom at the playhead"]');
    await add.scrollIntoViewIfNeeded();
    await t.cue("eases");
    await t.click(add);
    await page.mouse.click(box.x + 4, ruler.y + ruler.height / 2);
    await page.keyboard.press("Space");
    await t.pause(3.2);
    await page.keyboard.press("Space");
  });
  await t.finish(0.5);
};

const thumb: TakeFn = async (ctx) => {
  await seedTrailer({ packs: true });
  const page = await openApp(ctx);
  await prepareEditor(page);
  const start = await rulerX(page, 15);
  await page.mouse.click(start.x, start.y);
  await page.waitForTimeout(1500);
  const t = await ctx.take("thumb", page);
  await t.line("8.1", async () => {
    await t.click(tab(page, "thumbnail"));
    await t.cue("background");
    await t.click(page.getByRole("button", { name: "Timeline at playhead" }));
    await zoomTo(t, page.locator(".side .panel").first(), 5, 1.5);
  });
  await t.line("8.2", async () => {
    const select = page.locator(".side select").first();
    await t.click(select);
    await select.selectOption("NeonThumbnail");
    await t.click(page.getByRole("button", { name: "Add", exact: true }));
    await t.pause(1.2);
    await t.cue("thumbnail");
    await t.moveTo(page.locator(".side .list-item").first(), 600);
  });
  await t.finish(0.5);
};

const render: TakeFn = async (ctx) => {
  await seedTrailer({ packs: true });
  const page = await openApp(ctx);
  // A signed-in channel for the camera: the panel's state is answered locally, nothing is uploaded.
  await page.route(/\/api\/youtube$/, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: { auth: { state: "signed-in", channel: { id: "UCdemo", title: "Neon demo channel", handle: "@neon-demo" } }, loginError: null, uploads: [] } }) }),
  );
  await prepareEditor(page);
  await page.waitForTimeout(800);
  const t = await ctx.take("render", page);
  await t.line("9.1", async () => {
    await t.click(tab(page, "renders"));
    const preset = page.locator(".side select").first();
    await t.cue("presets");
    await t.click(preset);
    await zoomTo(t, preset, 3.5, 1.7);
    await preset.selectOption("draft");
  });
  await t.line("9.2", async () => {
    const go = page.getByRole("button", { name: /^Render \d/ }).first();
    await t.click(go);
    await t.cue("editing");
    await t.moveTo(page.locator(".tl-lanes"), 700);
  });
  await t.line("9.3", async () => {
    const yt = page.getByText("YouTube", { exact: false }).first();
    await yt.scrollIntoViewIfNeeded();
    await t.moveTo(yt, 500);
    await t.cue("title");
    const title = page.locator(".side .field", { has: page.locator("label", { hasText: /^Title$/ }) }).locator("input");
    await title.scrollIntoViewIfNeeded();
    await t.click(title);
    await page.keyboard.press("ControlOrMeta+a");
    await title.pressSequentially("Git Gud in 25 seconds", { delay: 60 });
    await t.cue("thumbnail");
    await t.moveTo(page.getByText("Use the project thumbnail"), 600);
  });
  await t.finish(0.5);
};

const agent: TakeFn = async (ctx) => {
  await seedTrailer();
  await mkdir(SCRATCH, { recursive: true });
  const url = `file://${join(STAGE, "agent.html")}?app=${encodeURIComponent(appUrl())}`;
  const page = await openApp(ctx, url);
  const app = page.frame({ url: /localhost:5173/ }) ?? page.frames()[1]!;
  await prepareEditor(page, app);
  await tab(app, "activity").click();
  await page.evaluate(() => (window as unknown as { term: { clear(): void } }).term.clear());
  const term = {
    type: (cmd: string) => page.evaluate((c) => (window as unknown as { term: { type(c: string): Promise<void> } }).term.type(c), cmd),
    print: (text: string) => page.evaluate((s) => (window as unknown as { term: { print(s: string): void } }).term.print(s), text),
  };
  const run = async (cmd: string, args: string[]) => {
    await term.type(cmd);
    await t.pause(0.3);
    await term.print(neonText(DEMO_HOME, ...args));
  };
  const t = await ctx.take("agent", page);
  await t.line("10.2", async () => {
    await run("neon-cli timeline", ["timeline"]);
  });
  await t.line("10.3", async () => {
    await run(`neon-cli timeline insert --component LowerThird \\\n  --props '{"title":"Joe Lloyd","subtitle":"Built this"}' --at 2s`, ["timeline", "insert", "--component", "LowerThird", "--props", '{"title":"Joe Lloyd","subtitle":"Built this"}', "--at", "2s"]);
    await t.cue("live");
    await zoomTo(t, page.locator(".app"), 3.4, 1.35);
  });
  await t.line("10.4", async () => {
    const plan = { ops: [
      { route: "/api/timeline/insert", body: { kind: "component", componentName: "Callout", props: { text: "Lanes", x: 0.3, y: 0.4 }, at: "13s", duration: "3s" } },
      { route: "/api/timeline/insert", body: { kind: "component", componentName: "KeyCombo", props: { combo: "Cmd+Shift+P" }, at: "19s", duration: "2s" } },
      { route: "/api/timeline/update", body: { id: "$0.id", patch: { animateIn: { type: "pop", durationFrames: 12 } } } },
    ] };
    const file = join(SCRATCH, "plan.json");
    await writeFile(file, JSON.stringify(plan, null, 2));
    await run("neon-cli apply plan.json", ["apply", file]);
  });
  await t.line("10.5", async () => {
    await run("neon-cli still --at 14s --out frame.png", ["still", "--at", "14s", "--out", join(SCRATCH, "frame.png")]);
  });
  await t.finish(0.6);
};

const room: TakeFn = async (ctx) => {
  await seedTrailer();
  await freshInstance(PEER_HOME);
  const url = `file://${join(STAGE, "room.html")}?a=${encodeURIComponent(appUrl())}&b=${encodeURIComponent(appUrl(PEER_HOME, 5174))}`;
  const page = await openApp(ctx, url);
  await page.waitForTimeout(3000);
  const a = page.frame({ url: /localhost:5173/ })!;
  const b = page.frame({ url: /localhost:5174/ })!;
  await prepareEditor(page, a);
  await prepareEditor(page, b);
  // Display names, so each playhead says whose it is.
  for (const [frame, name] of [[a, "Joe"], [b, "Sam"]] as const) {
    await tab(frame, "peers").click();
    const input = frame.locator(".field", { has: frame.locator("label", { hasText: "Your display name" }) }).locator("input");
    await input.fill(name);
    await input.blur();
  }
  await page.waitForTimeout(800);
  const t = await ctx.take("room", page);
  let code = "";
  await t.line("11.1", async () => {
    await t.click(a.getByRole("button", { name: /Host room/ }));
    await t.pause(1.2);
    code = neonAt<{ roomCode: string }>(DEMO_HOME, "room", "info").roomCode;
    await t.cue("joins");
    const lan = neonAt<{ lanUrl: string }>(DEMO_HOME, "room", "info").lanUrl.replace(/\/\/[^:]+:/, "//127.0.0.1:");
    await t.type(b.locator(".field", { has: b.locator("label", { hasText: /^Room code$/ }) }).locator("input").first(), code, 45);
    await b.locator(".field", { has: b.locator("label", { hasText: /Host URL/ }) }).locator("input").fill(lan);
    await t.click(b.getByRole("button", { name: /^Join/ }));
    await t.pause(2.5);
  });
  await t.line("11.2", async () => {
    const lower = clip(a, "Lower Third");
    const from = await grab(lower);
    await t.drag(from, { x: from.x - 70, y: from.y }, 1200);
    await t.cue("playhead");
    const at = await rulerX(b, 4);
    await t.moveTo(at, 500);
    await page.mouse.click(at.x, at.y);
    await t.pause(1);
  });
  await t.finish(0.6);
};

export const takes: Record<string, TakeFn> = { overview, timeline, templates, packs, script, ai, thumb, render, agent, room };
