// neon-cli from this checkout against a private Neon instance, so the tour never touches the
// shared one in ~/.neon-video.
//
//   node video/tour/tools/neon.ts serve --detach | stop | <any neon-cli arguments>
//
// NEON_HOME picks the instance. The edit uses ~/.neon-video-tour-edit (the default here); the app
// being filmed runs in ~/.neon-video-tour-demo (see demo.ts).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = join(REPO, "apps", "cli", "src", "main.ts");
export const EDIT_HOME = join(homedir(), ".neon-video-tour-edit");
export const DEMO_HOME = join(homedir(), ".neon-video-tour-demo");

function prepare(home: string) {
  mkdirSync(home, { recursive: true });
  // Reuse the ffmpeg and friends the shared install already downloaded.
  if (!existsSync(join(home, "tools"))) symlinkSync(join(homedir(), ".neon-video", "tools"), join(home, "tools"));
}

const envFor = (home: string) => ({ ...process.env, NEON_HOME: home, PATH: `${homedir()}/.bun/bin:${homedir()}/.local/bin:${process.env.PATH}` });

/** Runs neon-cli with --json against `home` and returns its data, or throws with the CLI's message. */
export function neonAt<T = unknown>(home: string, ...args: string[]): T {
  prepare(home);
  let raw: string;
  try {
    raw = execFileSync("node", [CLI, ...args, "--json"], { env: envFor(home), maxBuffer: 64 * 1024 * 1024 }).toString();
  } catch (error) {
    const out = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);
    throw new Error(`neon-cli ${args.join(" ")} failed: ${out.slice(0, 2000)}`);
  }
  const parsed: { ok: boolean; data?: T; error?: { message: string } } = JSON.parse(raw);
  if (!parsed.ok) throw new Error(`neon-cli ${args.join(" ")}: ${parsed.error?.message}`);
  return parsed.data as T;
}

/** neon-cli against the edit instance. */
export const neon = <T = unknown>(...args: string[]) => neonAt<T>(process.env.NEON_HOME ?? EDIT_HOME, ...args);

/** Plain-text neon-cli output, as a person at a terminal would see it. */
export function neonText(home: string, ...args: string[]): string {
  prepare(home);
  return execFileSync("node", [CLI, ...args], { env: { ...envFor(home), COLUMNS: "100" }, maxBuffer: 16 * 1024 * 1024 }).toString();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const home = process.env.NEON_HOME ?? EDIT_HOME;
  prepare(home);
  execFileSync("node", [CLI, ...process.argv.slice(2)], { env: envFor(home), stdio: "inherit" });
}
