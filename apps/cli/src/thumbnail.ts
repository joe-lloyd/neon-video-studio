/**
 * `neon-cli thumbnail …`: build the video's thumbnail from template / FX-pack components and
 * images over a timeline frame or a colour, then render it to a 1280x720 PNG.
 *
 *   thumbnail [show] | thumbnail render [--out f.png]
 *   thumbnail add --component NAME [--props JSON] | --asset REF   [--name N] [--pos x,y] [--scale S] [--rotation DEG]
 *   thumbnail update <layer> [--props JSON] [--name N] [--pos x,y] [--scale S] [--rotation DEG]
 *   thumbnail move <layer> --to N | thumbnail remove <layer...>
 *   thumbnail background --color CSS | --at T
 */
import { framesToTimecode, type ClipTransform, type StillResult, type Thumbnail, type ThumbnailLayer } from '@neon/core';
import { ApiError, type NeonClient } from './client.ts';
import { table } from './format.ts';

export interface ThumbnailFlags {
  component?: string;
  asset?: string;
  props?: string;
  name?: string;
  pos?: string;
  scale?: string;
  rotation?: string;
  to?: string;
  color?: string;
  at?: string;
  out?: string;
}

type Io = { json: boolean; out: (data: unknown, human: () => string) => void; appPath: (p: string) => string };

function number(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ApiError('USAGE', `--${flag} expects a number, got "${raw}"`);
  return n;
}

/** Only the transform fields that were passed; the app keeps the rest. */
export function transformPatch(flags: Pick<ThumbnailFlags, 'pos' | 'scale' | 'rotation'>): Partial<ClipTransform> | undefined {
  const patch: Partial<ClipTransform> = {};
  if (flags.pos !== undefined) {
    const parts = flags.pos.split(',');
    if (parts.length !== 2) throw new ApiError('USAGE', `--pos expects x,y (0..1 of the thumbnail), got "${flags.pos}"`);
    patch.x = number(parts[0]!, 'pos');
    patch.y = number(parts[1]!, 'pos');
  }
  if (flags.scale !== undefined) patch.scale = number(flags.scale, 'scale');
  if (flags.rotation !== undefined) patch.rotation = number(flags.rotation, 'rotation');
  return Object.keys(patch).length ? patch : undefined;
}

export function parseProps(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ApiError('BAD_JSON', `--props ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ApiError('BAD_JSON', '--props must be a JSON object');
  return Object.fromEntries(Object.entries(parsed));
}

/** A layer by id, id prefix, name, or its position in `thumbnail show` (0 = bottom). */
export function resolveLayer(ref: string, layers: readonly ThumbnailLayer[]): ThumbnailLayer {
  const exact = layers.find((l) => l.id === ref);
  if (exact) return exact;
  if (/^\d+$/.test(ref) && layers[Number(ref)]) return layers[Number(ref)]!;
  for (const matches of [layers.filter((l) => l.id.startsWith(ref)), layers.filter((l) => l.name.toLowerCase() === ref.toLowerCase())]) {
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new ApiError('AMBIGUOUS', `Layer "${ref}" matches ${matches.map((l) => l.id).join(', ')}`);
  }
  throw new ApiError('NOT_FOUND', `No thumbnail layer matches "${ref}" (see neon-cli thumbnail)`);
}

export function describeThumbnail(thumb: Thumbnail, fps: number): string {
  const bg = thumb.background.kind === 'color' ? `colour ${thumb.background.color}` : `timeline frame at ${framesToTimecode(thumb.background.frame, fps)}`;
  if (thumb.layers.length === 0) return `Background: ${bg}\nNo layers yet: neon-cli thumbnail add --component TitleCard --props '{"title":"…"}'`;
  const rows = thumb.layers.map((l, i) => [
    String(i),
    l.id,
    l.name,
    l.kind === 'component' ? l.componentName : 'image',
    `${l.transform.x.toFixed(2)},${l.transform.y.toFixed(2)}`,
    l.transform.scale.toFixed(2),
    String(l.transform.rotation ?? 0),
  ]);
  return `Background: ${bg}\nLayers (0 = bottom):\n${table(rows, ['#', 'ID', 'NAME', 'WHAT', 'POS', 'SCALE', 'ROT'])}`;
}

export async function thumbnailCommand(api: NeonClient, sub: string | undefined, rest: string[], flags: ThumbnailFlags, io: Io): Promise<void> {
  const fps = async () => (await api.status()).project.fps;
  switch (sub) {
    case undefined:
    case 'show': {
      const thumb = await api.thumbnail();
      const f = await fps();
      io.out(thumb, () => describeThumbnail(thumb, f));
      return;
    }
    case 'add': {
      const { component, asset } = flags;
      const placement = { name: flags.name, transform: transformPatch(flags) };
      const layer =
        component && !asset ? await api.thumbnailAdd({ kind: 'component', componentName: component, props: parseProps(flags.props) ?? {}, ...placement })
        : asset && !component ? await api.thumbnailAdd({ kind: 'image', assetId: (await api.resolveAsset(asset)).id, ...placement })
        : null;
      if (!layer) throw new ApiError('USAGE', 'thumbnail add needs --component NAME or --asset REF (an imported image)');
      io.out(layer, () => `Added layer ${layer.id} “${layer.name}” on top`);
      return;
    }
    case 'update': {
      if (!rest[0]) throw new ApiError('USAGE', 'usage: neon-cli thumbnail update <layer> [--props JSON] [--name N] [--pos x,y] [--scale S] [--rotation DEG]');
      const layer = resolveLayer(rest[0], (await api.thumbnail()).layers);
      const patch = { name: flags.name, props: parseProps(flags.props), transform: transformPatch(flags) };
      if (!patch.name && !patch.props && !patch.transform) throw new ApiError('USAGE', 'thumbnail update needs --props, --name, --pos, --scale or --rotation');
      const updated = await api.thumbnailUpdate({ id: layer.id, patch });
      io.out(updated, () => `Updated layer ${updated.id} “${updated.name}”`);
      return;
    }
    case 'move': {
      if (!rest[0] || flags.to === undefined || !/^\d+$/.test(flags.to)) throw new ApiError('USAGE', 'usage: neon-cli thumbnail move <layer> --to N   (0 = bottom)');
      const layer = resolveLayer(rest[0], (await api.thumbnail()).layers);
      const thumb = await api.thumbnailMove({ id: layer.id, index: Number(flags.to) });
      const f = await fps();
      io.out(thumb, () => describeThumbnail(thumb, f));
      return;
    }
    case 'remove': {
      if (rest.length === 0) throw new ApiError('USAGE', 'usage: neon-cli thumbnail remove <layer...>');
      const layers = (await api.thumbnail()).layers;
      const r = await api.thumbnailRemove({ ids: rest.map((ref) => resolveLayer(ref, layers).id) });
      io.out(r, () => `Removed ${r.removed.length} layer(s)`);
      return;
    }
    case 'background': {
      const { color, at } = flags;
      const body = color && !at ? { color } : at && !color ? { at } : null;
      if (!body) throw new ApiError('USAGE', 'thumbnail background needs --color CSS or --at T (a timeline frame)');
      const thumb = await api.thumbnailBackground(body);
      const f = await fps();
      io.out(thumb, () => describeThumbnail(thumb, f));
      return;
    }
    case 'render': {
      const r: StillResult = await api.thumbnailRender({ output: flags.out === undefined ? undefined : io.appPath(flags.out) });
      io.out(r, () => `Thumbnail ${r.width}x${r.height} → ${r.path}`);
      return;
    }
    default:
      throw new ApiError('USAGE', `Unknown subcommand "thumbnail ${sub}" (show, add, update, move, remove, background, render)`);
  }
}
