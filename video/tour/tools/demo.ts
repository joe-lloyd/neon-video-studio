// The demo world the takes film: a headless Neon in its own NEON_HOME, the renderer in a browser,
// and a few projects built from rendered Git Gud episodes. Nothing from the owner's own projects
// appears on screen.
//
//   node video/tour/tools/demo.ts        # fresh demo home with every project seeded
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spoken } from "./voice.mjs";
import { DEMO_HOME, neonAt, REPO } from "./neon.ts";

export const VIDEO = join(REPO, "video", "tour");
const MEDIA = join(VIDEO, "build", "media");
const FFMPEG = join(homedir(), ".neon-video", "tools", "ffmpeg");
const EPISODES = join(homedir(), "htmlify", "videos", "git-gud-series", "git-gud-series-2026-10-24-assets");
/** Where the demo projects live. A short path, because the overview shows it. */
export const PROJECTS = join(homedir(), "Videos", "neon-demo");
export const PEER_HOME = join(homedir(), ".neon-video-tour-peer");
export const TRAILER = join(PROJECTS, "git-gud-launch.neon");
export const WALKTHROUGH = join(PROJECTS, "staging-walkthrough.neon");
const KOKORO = process.env.KOKORO_URL ?? "http://127.0.0.1:8882";

export const demo = <T = unknown>(...args: string[]) => neonAt<T>(DEMO_HOME, ...args);
const env = (home: string) => ({ ...process.env, NEON_HOME: home, PATH: `${homedir()}/.bun/bin:${process.env.PATH}` });
const CLI = join(REPO, "apps", "cli", "src", "main.ts");

export type Instance = { port: number; token: string; pid: number };
export const instance = (home = DEMO_HOME): Instance => JSON.parse(readFileSync(join(home, "instance.json"), "utf8"));
/** The renderer, from Vite, attached to a headless instance. 5174 serves a second origin for a peer. */
export const appUrl = (home = DEMO_HOME, vite = 5173) => {
  const i = instance(home);
  return `http://localhost:${vite}/?port=${i.port}&token=${i.token}`;
};

/** Stops `home`'s instance, wipes its state (keeping the tools link) and starts it again. */
export async function freshInstance(home: string): Promise<void> {
  try {
    execFileSync("node", [CLI, "stop"], { env: env(home), stdio: "ignore" });
  } catch {
    /* not running */
  }
  await mkdir(home, { recursive: true });
  for (const entry of await readdir(home)) if (entry !== "tools") await rm(join(home, entry), { recursive: true, force: true });
  execFileSync("node", [CLI, "serve", "--detach"], { env: env(home), stdio: "ignore" });
}

/** Starts the renderer dev servers unless they already answer. */
export async function ensureVite(): Promise<void> {
  for (const port of [5173, 5174]) {
    const up = await fetch(`http://localhost:${port}/`).then((r) => r.ok).catch(() => false);
    if (up) continue;
    const child = spawn("pnpm", ["--filter", "@neon/desktop", "exec", "vite", "--port", String(port), "--strictPort"], { cwd: REPO, detached: true, stdio: "ignore", env: env(DEMO_HOME) });
    child.unref();
    for (let i = 0; i < 60 && !(await fetch(`http://localhost:${port}/`).then((r) => r.ok).catch(() => false)); i++) await new Promise((r) => setTimeout(r, 500));
  }
}

const ffmpeg = (...args: string[]) => execFileSync(FFMPEG, ["-y", "-loglevel", "error", ...args]);

/** Media the demo projects use, made once. */
export async function media(): Promise<void> {
  await mkdir(MEDIA, { recursive: true });
  const bed = join(MEDIA, "music-bed.m4a");
  // A soft synth pad: three detuned chords with a slow swell, so the waveform has some shape.
  if (!existsSync(bed)) {
    const chord = (f: number[]) => f.map((hz) => `0.12*sin(2*PI*${hz}*t)`).join("+");
    ffmpeg("-f", "lavfi", "-i", `aevalsrc='(${chord([220, 277.2, 329.6])})*(0.6+0.4*sin(2*PI*t/4))':s=48000:d=40`, "-af", "afade=in:d=1.5,afade=out:st=37:d=3,volume=1.4", "-c:a", "aac", "-b:a", "160k", bed);
  }
  // A short shot that sits in the trailer's media library, ready to drop in.
  const broll = join(MEDIA, "conflict-b-roll.mp4");
  if (!existsSync(broll)) ffmpeg("-ss", "64", "-t", "4", "-i", join(EPISODES, "07-conflicts-and-auto-fix.mp4"), "-c:v", "libx264", "-crf", "18", "-preset", "fast", "-c:a", "aac", "-b:a", "160k", broll);
  const walk = join(MEDIA, "staging-take.mp4");
  if (!existsSync(walk)) ffmpeg("-ss", "16", "-t", "40", "-i", join(EPISODES, "03-staging-and-committing.mp4"), "-c:v", "libx264", "-crf", "18", "-preset", "fast", "-c:a", "aac", "-b:a", "160k", walk);
  // The trailer's voice-over, one file per script line.
  for (const [i, say] of TRAILER_LINES.entries()) {
    const file = join(MEDIA, `trailer-vo-${i + 1}.mp3`);
    if (existsSync(file)) continue;
    const response = await fetch(`${KOKORO}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "kokoro", voice: "am_michael", input: spoken(say), response_format: "mp3" }),
    });
    if (!response.ok) throw new Error(`Kokoro: HTTP ${response.status}`);
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
  }
}

const TRAILER_LINES = [
  "Git Gud is a Git client you can see through.",
  "Every branch gets its own lane in the commit graph.",
  "Fetch, pull and push without leaving the graph.",
];

type Track = { id: string; name: string; kind: string };
type Clip = { id: string; name: string; trackId: string; startFrame: number; durationFrames: number };

/** Saves a fresh project at `dir`, replacing any earlier copy. */
function newProject(name: string, dir: string) {
  demo("project", "new", "--name", name, "--fps", "30", "--width", "1920", "--height", "1080");
  execFileSync("rm", ["-rf", dir]);
  demo("project", "save", dir);
}

const tracks = () => demo<{ tracks: Track[] }>("timeline", "show").tracks;
const trackId = (name: string) => {
  const t = tracks().find((t) => t.name === name);
  if (!t) throw new Error(`No track ${name}`);
  return t.id;
};
const importAsset = (path: string) => demo<{ asset: { id: string } }>("api", "POST", "assets/import", JSON.stringify({ path })).asset.id;
const apply = async (name: string, ops: { route: string; body: Record<string, unknown> }[]) => {
  const file = join(MEDIA, `${name}-plan.json`);
  await writeFile(file, JSON.stringify({ ops }));
  return demo<{ results: Clip[] }>("apply", file).results;
};
const ep = (name: string) => join(EPISODES, `${name}.mp4`);

/** A small one-clip project for the overview list. */
async function smallProject(name: string, folder: string, episode: string, trim: number) {
  newProject(name, join(PROJECTS, folder));
  const asset = importAsset(ep(episode));
  await apply(folder, [{ route: "/api/timeline/insert", body: { kind: "video", assetId: asset, at: 0, trimBefore: trim * 30, duration: 300, trackId: trackId("V1") } }]);
  demo("project", "save");
}

/**
 * The Git Gud launch trailer: four shots, a voice-over linked to a two-section script, a music
 * bed and a lower third. Most takes start from this.
 */
export async function seedTrailer(opts: { packs?: boolean } = {}): Promise<{ clips: Clip[] }> {
  await media();
  newProject("Git Gud launch trailer", TRAILER);
  demo("tracks", "add", "--kind", "audio", "--name", "Music");
  const [e1, e2, e5] = ["01-meet-git-gud", "02-commit-graph", "05-remotes"].map((e) => importAsset(ep(e)));
  importAsset(join(MEDIA, "conflict-b-roll.mp4"));
  const bed = importAsset(join(MEDIA, "music-bed.m4a"));
  const vo = [1, 2, 3].map((i) => importAsset(join(MEDIA, `trailer-vo-${i}.mp3`)));
  const V1 = trackId("V1");
  const shot = (assetId: string, at: number, trim: number, length: number, name: string) => ({ route: "/api/timeline/insert", body: { kind: "video", assetId, at: at * 30, trimBefore: trim * 30, duration: length * 30, trackId: V1, name, volume: 0.25, placement: "free" } });
  const clips = await apply("trailer", [
    shot(e1, 0, 0.5, 5, "Title"),
    shot(e1, 5, 18, 7, "Architecture"),
    shot(e2, 12, 47, 7, "Commit graph"),
    shot(e5, 19, 80, 6, "Push and pull"),
    { route: "/api/timeline/insert", body: { kind: "audio", assetId: bed, at: 0, duration: 25 * 30, trackId: trackId("Music"), volume: 0.35, placement: "free", name: "Music bed" } },
    { route: "/api/timeline/insert", body: { kind: "component", componentName: "LowerThird", props: { title: "Every branch in its own lane", subtitle: "The commit graph" }, at: 13 * 30, duration: 4 * 30, trackId: trackId("FX1"), placement: "free" } },
  ]);
  // The script, with each line placed where its voice-over plays, so the prompter has cues.
  const at = [1, 13, 20];
  const script = {
    sections: [
      { title: "Hook", intent: "Say what Git Gud is in one breath.", status: "approved", lines: [{ say: TRAILER_LINES[0], show: "Logo title.", at: at[0]! * 30, duration: 90 }] },
      {
        title: "Features",
        intent: "Two features, each on its own shot.",
        status: "review",
        lines: [
          { say: TRAILER_LINES[1], show: "Zoom on the lanes.", at: at[1]! * 30, duration: 90 },
          { say: TRAILER_LINES[2], show: "Push and pull steps.", at: at[2]! * 30, duration: 90 },
        ],
      },
      { title: "Call to action", intent: "Where to get it.", status: "draft", lines: [{ say: "Get it for Mac, Windows and Linux.", show: "Logo and the releases link." }] },
    ],
  };
  const scriptFile = join(MEDIA, "trailer-script.json");
  await writeFile(scriptFile, JSON.stringify(script));
  demo("script", "set", scriptFile);
  const ids = demo<{ sections: { lines: { id: string }[] }[] }>("api", "GET", "script").sections.flatMap((s) => s.lines.map((l) => l.id));
  const A1 = trackId("A1");
  await apply("trailer-vo", vo.map((assetId, i) => ({ route: "/api/timeline/insert", body: { kind: "audio", assetId, at: at[i]! * 30, trackId: A1, scriptLineId: ids[i], name: `VO ${i + 1}`, placement: "free" } })));
  demo("notes", "add", "2.1", "Can this line land on the zoom?", "--as", "person");
  if (opts.packs) demo("packs", "install", join(VIDEO, "fx", "neon-tour"));
  demo("project", "save");
  return { clips };
}

/** A narrated screen recording for the AI scenes. */
export async function seedWalkthrough(): Promise<void> {
  await media();
  newProject("Staging walkthrough", WALKTHROUGH);
  const take = importAsset(join(MEDIA, "staging-take.mp4"));
  await apply("walkthrough", [{ route: "/api/timeline/insert", body: { kind: "video", assetId: take, at: 0, trackId: trackId("V1"), name: "staging-take.mp4" } }]);
  demo("project", "save");
}

/** Projects listed on the overview, oldest first; the trailer ends up on top. */
export async function seedAll(): Promise<void> {
  await mkdir(PROJECTS, { recursive: true });
  await media();
  await smallProject("Conference talk intro", "conference-talk-intro.neon", "12-headless-and-relay", 10);
  await smallProject("Release notes 0.17", "release-notes.neon", "10-settings-and-updates", 20);
  await seedWalkthrough();
  await seedTrailer();
  // The scratch project the app booted into is not part of the demo.
  for (const p of demo<{ path: string; current?: boolean }[]>("project", "list")) {
    if (!p.path.startsWith(PROJECTS) && !p.current) demo("project", "delete", p.path);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await freshInstance(DEMO_HOME);
  await seedAll();
  console.log(demo<unknown[]>("project", "list"));
}
