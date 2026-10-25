// Where the tour's edit and render live, and the shape of script.json.
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const VIDEO = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BUILD = join(VIDEO, "build");
export const PROJECT = join(homedir(), "Videos", "tours", "neon-video-studio.neon");
export const RENDER = join(BUILD, "renders", "neon-video-studio.mp4");

export type Fx = { name: string; props: Record<string, unknown> };
export type Line = { say: string; show?: string; take?: string; fx?: Fx };
export type Script = {
  title: string;
  subtitle: string;
  youtube: { title: string; thumbTitle: string; thumbKicker: string; thumbFrom: string };
  sections: { title: string; intent?: string; take?: string; lines: Line[] }[];
};
