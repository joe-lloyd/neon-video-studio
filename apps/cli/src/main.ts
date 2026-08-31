#!/usr/bin/env node
/**
 * neon-cli — command line / AI-agent interface for Neon Video Studio.
 * Talks to the running desktop app over its local control API (127.0.0.1 + bearer token),
 * or renders a project directory headlessly without the app.
 */
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RENDER_PRESETS, framesToTimecode, listTemplates, templateDefaults, templateJsonSchema, type AiJob, type ImportAssetResponse, type RenderJob } from '@neon/core';
import { renderHeadless } from '@neon/render';
import { registerAllPacks } from '@neon/remotion-workspace/packs';

registerAllPacks();
import { ApiError, NeonClient, discoverClient } from './client.ts';
import { clipRow, progressBar, table } from './format.ts';

const HELP = `neon-cli — Neon Video Studio control

USAGE
  neon-cli <command> [subcommand] [options]

COMMANDS
  status                                  App, project, room and render status
  list [templates|tracks|clips|assets|presets]
  state dump [--out file]                 Full project JSON
  project new [--name N] [--fps 30] [--width W] [--height H]
  project open <dir>                      Open a .neon project directory
  project save [<dir>]                    Save (optionally Save As)
  timeline insert --component NAME [--props JSON] [--at T] [--duration T] [--track REF] [--name N] [--ripple|--overlap|--free]
  timeline insert --asset REF [--at T] [--duration T] [--trim T] [--track REF] [--volume V] [--ripple|--overlap|--free]
      placement: --ripple = insert edit (later clips shift; default for media with --at)
                 --overlap = exact position (default for overlays with --at) · --free = nearest gap (default without --at)
  timeline update <clip> [--props JSON] [--start T] [--duration T] [--trim T] [--name N] [--volume V] [--track REF]
  timeline move <clip> --at T [--track REF]
  timeline split <clip> --at T
  timeline remove <clip...>
  tracks add --kind video|audio|overlay [--name N]
  tracks update <track> [--name N] [--mute|--unmute] [--lock|--unlock] [--hide|--show]
  tracks remove <track>
  assets import <file...> [--at T] [--track REF]
  assets remove <ref>
  render --output out.mp4 [--preset ID] [--from T] [--to T] [--no-wait]
  render --headless --project <dir> --output out.mp4 [--preset ID]
  render status <jobId> | render cancel <jobId>
  room host [--password P] | room join <code> [--password P] [--host-url ws://ip:port] | room leave | room info
  events [--history N]                    Live-tail everything the app does (CLI actions, renders, peers) — Ctrl-C to stop
  timeline cut --from T --to T [--track REF] [--no-ripple]   Remove a timeline range (all tracks, ripple)
  timeline detach <clip>                  Split a video clip's audio onto an audio track (video muted)
  timeline update <clip> --pos 0.5,0.3 --scale 0.6 --in pop:12 --out fade:10   Canvas placement + enter/exit animation
  record start | record stop [--at T]     Record a mic voice-over in the app (take lands on the VO track)
  rip <url> [--quality 1080|720|best|audio] [--at T]   Download a YouTube/web video into the media library (yt-dlp)

AI (local engines: whisper.cpp, ffmpeg, Apple Vision; Claude optional for B-roll)
  ai status                               Which engines are available + how to install the missing ones
  ai transcribe <clip|asset> [--force]    Word-level transcript (cached per asset)
  ai transcript <clip|asset> [--json]     Print the transcript, fillers marked with ⟨⟩
  ai fillers <clip> [--apply] [--words um,uh,like] [--pad 40]      Find/remove "um, uh, like, you know"
  ai silence <clip> [--apply] [--threshold=-38] [--min 400] [--keep 150]   Dead-air trimming
  ai breaths <clip> [--db 15]             Attenuate breaths/mouth clicks with volume keyframes
  ai denoise <clip> [--engine auto|rnnoise|afftdn|deepfilter] [--strength 0.7]
  ai enhance <clip> [--lufs=-16] [--no-denoise]                    Clearer voice at broadcast loudness
  ai setup [--model tiny.en|base.en|small.en]                      Install whisper.cpp + models automatically
  ai matte <clip> [--mode person|chroma] [--quality fast|balanced|accurate] [--color 0x00FF00]
  ai reframe <clip> [--aspect 9:16] [--resize]                     Face-tracked auto-reframe
  ai broll [<asset>] [--apply] [--no-claude] [--duration 3]        Suggest/place B-roll from the transcript
  ai clean <clip> [--no-fillers] [--no-silences] [--no-breaths] [--denoise]   One-shot voice clean-up
  ai cut <asset> <fromWord> <toWord>      Text-driven edit: delete words → cut the video
  ai jobs | ai job <id> | ai cancel <id>
  preview play|pause|toggle|seek <T>      Drive the app's preview player (watch your edits play back)
  ui panel <media|fx|inspect|room|ai|script|render|live> | ui select <clip...> | ui select none | ui dialog <render|room|shortcuts|none>

TIME (T)   HH:MM:SS[:FF] · MM:SS · 12.5s · 300f · 300 (frames)
REF        id, id prefix, or name (tracks: "V1"; assets: file name or hash prefix)

GLOBAL OPTIONS
  --json                Machine-readable output ({ok, data|error})
  --endpoint URL        Override control API endpoint (default: from ~/.neon-video/instance.json)
  --token TOKEN         Override API token
  -h, --help
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  strict: true,
  options: {
    json: { type: 'boolean', default: false },
    endpoint: { type: 'string' },
    token: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
    component: { type: 'string' },
    props: { type: 'string' },
    asset: { type: 'string' },
    at: { type: 'string' },
    duration: { type: 'string' },
    trim: { type: 'string' },
    start: { type: 'string' },
    track: { type: 'string' },
    name: { type: 'string' },
    volume: { type: 'string' },
    overlap: { type: 'boolean', default: false },
    free: { type: 'boolean', default: false },
    ripple: { type: 'boolean', default: false },
    kind: { type: 'string' },
    mute: { type: 'boolean', default: false },
    unmute: { type: 'boolean', default: false },
    lock: { type: 'boolean', default: false },
    unlock: { type: 'boolean', default: false },
    hide: { type: 'boolean', default: false },
    show: { type: 'boolean', default: false },
    output: { type: 'string' },
    preset: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    wait: { type: 'boolean', default: true },
    headless: { type: 'boolean', default: false },
    project: { type: 'string' },
    out: { type: 'string' },
    fps: { type: 'string' },
    width: { type: 'string' },
    height: { type: 'string' },
    password: { type: 'string' },
    'host-url': { type: 'string' },
    history: { type: 'string' },
    force: { type: 'boolean', default: false },
    apply: { type: 'boolean', default: false },
    words: { type: 'string' },
    pad: { type: 'string' },
    threshold: { type: 'string' },
    min: { type: 'string' },
    keep: { type: 'string' },
    db: { type: 'string' },
    engine: { type: 'string' },
    strength: { type: 'string' },
    mode: { type: 'string' },
    quality: { type: 'string' },
    color: { type: 'string' },
    aspect: { type: 'string' },
    lufs: { type: 'string' },
    model: { type: 'string' },
    pos: { type: 'string' },
    scale: { type: 'string' },
    in: { type: 'string' },
    resize: { type: 'boolean', default: false },
    claude: { type: 'boolean', default: true },
    fillers: { type: 'boolean', default: true },
    silences: { type: 'boolean', default: true },
    breaths: { type: 'boolean', default: true },
    denoise: { type: 'boolean', default: false },
  },
});

const json = flags.json;

function out(data: unknown, human: () => string | void): void {
  if (json) process.stdout.write(`${JSON.stringify({ ok: true, data }, null, 2)}\n`);
  else {
    const text = human();
    if (text) process.stdout.write(`${text}\n`);
  }
}

function fail(err: unknown): never {
  const e = err instanceof ApiError ? err : err instanceof Error ? new ApiError('ERROR', err.message) : new ApiError('ERROR', String(err));
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: { code: e.code, message: e.message, details: e.details } })}\n`);
  else process.stderr.write(`error [${e.code}]: ${e.message}\n`);
  process.exit(1);
}

function parseJsonFlag(raw: string | undefined, label: string): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must be a JSON object');
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new ApiError('BAD_JSON', `--${label} ${(err as Error).message}`);
  }
}

function num(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ApiError('BAD_NUMBER', `Expected a number, got "${raw}"`);
  return n;
}

async function client(): Promise<NeonClient> {
  return new NeonClient(await discoverClient({ endpoint: flags.endpoint, token: flags.token }));
}

async function waitForRender(api: NeonClient, job: RenderJob): Promise<RenderJob> {
  let current = job;
  let lastLine = '';
  while (current.status === 'queued' || current.status === 'bundling' || current.status === 'rendering') {
    await new Promise((r) => setTimeout(r, 500));
    current = await api.renderJob(job.id);
    if (!json) {
      const line = `${current.status.padEnd(9)} ${progressBar(current.progress)} ${current.renderedFrames}/${current.totalFrames || '?'} frames`;
      if (line !== lastLine) {
        process.stderr.write(`\r${line}`);
        lastLine = line;
      }
    }
  }
  if (!json) process.stderr.write('\n');
  return current;
}

async function main(): Promise<void> {
  const [cmd, sub, ...rest] = positionals;
  if (flags.help || !cmd || cmd === 'help') {
    process.stdout.write(HELP);
    return;
  }

  // Headless render does not need the app.
  if (cmd === 'render' && flags.headless) {
    if (!flags.project || !flags.output) throw new ApiError('USAGE', 'render --headless requires --project <dir> and --output <file>');
    let last = '';
    const result = await renderHeadless({
      projectDir: flags.project,
      outputPath: flags.output,
      presetId: flags.preset,
      onEvent: (e) => {
        if (json) return;
        if (e.type === 'stage') process.stderr.write(`${e.stage}: ${e.message ?? ''}\n`);
        if (e.type === 'bundle') process.stderr.write(`bundle ${e.cached ? 'cache hit' : 'built'}: ${e.location}\n`);
        if (e.type === 'progress') {
          const line = `rendering ${progressBar(e.progress)} ${e.renderedFrames} frames`;
          if (line !== last) process.stderr.write(`\r${line}`);
          last = line;
        }
      },
      onLog: (line) => {
        if (!json && process.env.NEON_VERBOSE) process.stderr.write(`  ${line}\n`);
      },
    });
    if (!json) process.stderr.write('\n');
    out(result, () => `Rendered ${result.outputPath} in ${(result.durationMs / 1000).toFixed(1)}s`);
    return;
  }

  const api = await client();

  switch (cmd) {
    case 'status': {
      const s = await api.status();
      out(s, () =>
        [
          `Neon Video Studio v${s.version} (pid ${s.pid}, api ${api.endpoint})`,
          `Project : ${s.project.name}  ${s.project.width}×${s.project.height} @ ${s.project.fps}fps  ${framesToTimecode(s.project.durationFrames, s.project.fps)}  ${s.project.dirty ? '(unsaved changes)' : ''}`,
          `Path    : ${s.project.path ?? '(unsaved)'}`,
          `Tracks  : ${s.project.tracks}   Clips: ${s.project.clips}   Assets: ${s.project.assets}`,
          `Room    : ${s.room.role === 'none' ? 'not connected' : `${s.room.role} ${s.room.roomCode} · ${s.room.peers.length} peer(s)${s.room.lanUrl ? ` · ${s.room.lanUrl}` : ''}`}`,
          `Renders : ${s.renders.length === 0 ? 'none' : s.renders.map((r) => `${r.id} ${r.status} ${(r.progress * 100).toFixed(0)}%`).join(', ')}`,
          `Tools   : ffprobe ${s.capabilities.ffprobe ? 'yes' : 'no'} · render runtime ${s.capabilities.renderRuntime}`,
        ].join('\n'),
      );
      return;
    }

    case 'list': {
      const what = sub ?? 'all';
      const data = await api.list();
      const fps = (await api.status()).project.fps;
      if (json) {
        const templates = data.templates;
        const payload =
          what === 'templates' ? templates : what === 'tracks' ? data.tracks : what === 'clips' ? data.clips : what === 'assets' ? data.assets : what === 'presets' ? data.presets : data;
        out(payload, () => undefined);
        return;
      }
      const sections: string[] = [];
      if (what === 'all' || what === 'templates') {
        sections.push('TEMPLATES (--component)\n' + table(data.templates.map((t) => [t.name, t.label, `${t.defaultDurationSeconds}s`, t.description]), ['name', 'label', 'default', 'description']));
      }
      if (what === 'all' || what === 'tracks') {
        sections.push('TRACKS\n' + table(data.tracks.map((t) => [t.id, t.name, t.kind, t.muted ? 'muted' : '', t.locked ? 'locked' : '', t.hidden ? 'hidden' : '']), ['id', 'name', 'kind', '', '', '']));
      }
      if (what === 'all' || what === 'clips') {
        sections.push('CLIPS\n' + (data.clips.length ? table(data.clips.map((c) => clipRow(c, fps, data.tracks)), ['id', 'track', 'kind', 'name', 'in', 'out', 'length', 'detail']) : '  (empty timeline)'));
      }
      if (what === 'all' || what === 'assets') {
        sections.push(
          'ASSETS\n' +
            (data.assets.length
              ? table(
                  data.assets.map((a) => [a.id.slice(0, 12), a.name, a.kind, a.durationFrames ? framesToTimecode(a.durationFrames, fps) : '', a.width ? `${a.width}×${a.height}` : '', `${(a.size / 1e6).toFixed(1)} MB`]),
                  ['hash', 'name', 'kind', 'duration', 'size', 'bytes'],
                )
              : '  (no assets — use `assets import <file>`)'),
        );
      }
      if (what === 'all' || what === 'presets') {
        sections.push('PRESETS (--preset)\n' + table(data.presets.map((p) => [p.id, p.label, `${p.width}×${p.height}`, `${p.fps}fps`]), ['id', 'label', 'size', 'fps']));
      }
      out(data, () => sections.join('\n\n'));
      return;
    }

    case 'state': {
      if (sub !== 'dump') throw new ApiError('USAGE', 'state dump [--out file]');
      const s = await api.state();
      if (flags.out) {
        await writeFile(resolve(flags.out), JSON.stringify(s.project, null, 2));
        out({ written: resolve(flags.out) }, () => `Wrote ${resolve(flags.out!)}`);
        return;
      }
      process.stdout.write(`${JSON.stringify(json ? { ok: true, data: s } : s.project, null, 2)}\n`);
      return;
    }

    case 'project': {
      if (sub === 'new') {
        const r = await api.projectNew({ name: flags.name, fps: num(flags.fps), width: num(flags.width), height: num(flags.height) });
        out(r, () => `Created project "${r.project.meta.name}" (${r.path ?? 'unsaved'})`);
      } else if (sub === 'open') {
        if (!rest[0]) throw new ApiError('USAGE', 'project open <dir>');
        const r = await api.projectOpen(resolve(rest[0]));
        out(r, () => `Opened ${r.path} — ${r.project.clips.length} clips`);
      } else if (sub === 'save') {
        const r = await api.projectSave(rest[0] ? resolve(rest[0]) : undefined);
        out(r, () => `Saved ${r.path}`);
      } else throw new ApiError('USAGE', 'project new|open|save');
      return;
    }

    case 'timeline': {
      if (sub === 'insert') {
        const placement = flags.overlap ? 'overlap' : flags.free ? 'free' : flags.ripple ? 'ripple' : undefined;
        const trackId = flags.track ? (await api.resolveTrack(flags.track)).id : undefined;
        let clip;
        if (flags.component) {
          clip = await api.insert({ kind: 'component', componentName: flags.component, props: parseJsonFlag(flags.props, 'props'), at: flags.at, duration: flags.duration, trackId, name: flags.name, placement });
        } else if (flags.asset) {
          const asset = await api.resolveAsset(flags.asset);
          clip = await api.insert({ kind: asset.kind, assetId: asset.id, at: flags.at, duration: flags.duration, trimBefore: flags.trim, trackId, name: flags.name, volume: num(flags.volume), placement });
        } else throw new ApiError('USAGE', 'timeline insert requires --component NAME or --asset REF');
        out(clip, () => `Inserted ${clip.kind} "${clip.name}" as ${clip.id} at frame ${clip.startFrame} (${clip.durationFrames} frames)`);
      } else if (sub === 'update') {
        if (!rest[0]) throw new ApiError('USAGE', 'timeline update <clip> [...]');
        const target = await api.resolveClip(rest[0]);
        const trackId = flags.track ? (await api.resolveTrack(flags.track)).id : undefined;
        const parseAnim = (raw: string | undefined) => {
          if (raw === undefined) return undefined;
          if (raw === 'none') return null;
          const [type, frames] = raw.split(':');
          return { type, durationFrames: frames ? Number(frames) : 12 };
        };
        let transform;
        if (flags.pos !== undefined || flags.scale !== undefined) {
          const prev = target.kind !== 'component' || true ? (target as { transform?: { x: number; y: number; scale: number } }).transform : undefined;
          const [px, py] = (flags.pos ?? '').split(',').map(Number);
          transform = {
            x: Number.isFinite(px) ? px : prev?.x ?? 0.5,
            y: Number.isFinite(py) ? py : prev?.y ?? 0.5,
            scale: flags.scale !== undefined ? Number(flags.scale) : prev?.scale ?? 1,
          };
        }
        const clip = await api.update(target.id, {
          props: parseJsonFlag(flags.props, 'props'),
          startFrame: flags.start,
          durationFrames: flags.duration,
          trimBefore: flags.trim,
          name: flags.name,
          volume: num(flags.volume),
          trackId,
          transform,
          animateIn: parseAnim(flags.in),
          animateOut: parseAnim(flags.out),
        });
        out(clip, () => `Updated ${clip.id}: start ${clip.startFrame}, length ${clip.durationFrames}`);
      } else if (sub === 'move') {
        if (!rest[0] || !flags.at) throw new ApiError('USAGE', 'timeline move <clip> --at T [--track REF]');
        const target = await api.resolveClip(rest[0]);
        const trackId = flags.track ? (await api.resolveTrack(flags.track)).id : undefined;
        const clip = await api.move(target.id, flags.at, trackId);
        out(clip, () => `Moved ${clip.id} to frame ${clip.startFrame}`);
      } else if (sub === 'split') {
        if (!rest[0] || !flags.at) throw new ApiError('USAGE', 'timeline split <clip> --at T');
        const target = await api.resolveClip(rest[0]);
        const [l, r] = await api.split(target.id, flags.at);
        out([l, r], () => `Split into ${l.id} (${l.durationFrames}f) and ${r.id} (${r.durationFrames}f)`);
      } else if (sub === 'cut') {
        if (!flags.from || !flags.to) throw new ApiError('USAGE', 'timeline cut --from T --to T [--track REF] [--no-ripple]');
        const trackIds = flags.track ? [(await api.resolveTrack(flags.track)).id] : undefined;
        const r = await api.cut({ ranges: [{ start: flags.from, end: flags.to }], trackIds, ripple: flags.ripple });
        out(r, () => `Removed ${r.removedFrames} frames (${r.cuts} clip segment(s) touched)`);
      } else if (sub === 'detach') {
        if (!rest[0]) throw new ApiError('USAGE', 'timeline detach <clip>');
        const target = await api.resolveClip(rest[0]);
        const audio = await api.detach(target.id);
        out(audio, () => `Audio detached → clip ${audio.id} on an audio track (video muted; undo with ⌘Z in the app)`);
      } else if (sub === 'remove') {
        if (rest.length === 0) throw new ApiError('USAGE', 'timeline remove <clip...>');
        const all = (await api.list()).clips;
        const ids = [];
        for (const ref of rest) ids.push((await api.resolveClip(ref, all)).id);
        const r = await api.remove(ids);
        out(r, () => `Removed ${r.removed} clip(s)`);
      } else throw new ApiError('USAGE', 'timeline insert|update|move|split|remove|cut|detach');
      return;
    }

    case 'tracks': {
      if (sub === 'add') {
        if (!flags.kind) throw new ApiError('USAGE', 'tracks add --kind video|audio|overlay');
        const t = await api.trackAdd(flags.kind, flags.name);
        out(t, () => `Added ${t.kind} track "${t.name}" (${t.id})`);
      } else if (sub === 'update') {
        if (!rest[0]) throw new ApiError('USAGE', 'tracks update <track> [...]');
        const target = await api.resolveTrack(rest[0]);
        const patch: Record<string, unknown> = { name: flags.name };
        if (flags.mute) patch.muted = true;
        if (flags.unmute) patch.muted = false;
        if (flags.lock) patch.locked = true;
        if (flags.unlock) patch.locked = false;
        if (flags.hide) patch.hidden = true;
        if (flags.show) patch.hidden = false;
        const t = await api.trackUpdate(target.id, patch);
        out(t, () => `Updated track ${t.name}`);
      } else if (sub === 'remove') {
        if (!rest[0]) throw new ApiError('USAGE', 'tracks remove <track>');
        const target = await api.resolveTrack(rest[0]);
        const r = await api.trackRemove(target.id);
        out(r, () => `Removed track ${target.name}`);
      } else throw new ApiError('USAGE', 'tracks add|update|remove');
      return;
    }

    case 'assets': {
      if (sub === 'import') {
        if (rest.length === 0) throw new ApiError('USAGE', 'assets import <file...>');
        const trackId = flags.track ? (await api.resolveTrack(flags.track)).id : undefined;
        const results: ImportAssetResponse[] = [];
        for (const file of rest) {
          const r = await api.importAsset(resolve(file), flags.at !== undefined || trackId ? { at: flags.at, trackId } : undefined);
          results.push(r);
        }
        out(results, () =>
          results
            .map((r) => `${r.deduplicated ? 'Already had' : 'Imported'} ${r.asset.name} → ${r.asset.id.slice(0, 12)}…${r.clip ? ` (clip ${r.clip.id} at frame ${r.clip.startFrame})` : ''}`)
            .join('\n'),
        );
      } else if (sub === 'remove') {
        if (!rest[0]) throw new ApiError('USAGE', 'assets remove <ref>');
        const asset = await api.resolveAsset(rest[0]);
        const r = await api.removeAsset(asset.id);
        out(r, () => `Removed asset ${asset.name}`);
      } else throw new ApiError('USAGE', 'assets import|remove');
      return;
    }

    case 'render': {
      if (sub === 'status') {
        if (!rest[0]) throw new ApiError('USAGE', 'render status <jobId>');
        const job = await api.renderJob(rest[0]);
        out(job, () => `${job.id} ${job.status} ${progressBar(job.progress)} → ${job.outputPath}${job.error ? `\n${job.error}` : ''}`);
        return;
      }
      if (sub === 'cancel') {
        if (!rest[0]) throw new ApiError('USAGE', 'render cancel <jobId>');
        const job = await api.renderCancel(rest[0]);
        out(job, () => `${job.id} ${job.status}`);
        return;
      }
      if (!flags.output) throw new ApiError('USAGE', 'render --output <file.mp4> [--preset ID] [--from T] [--to T]');
      let job = await api.render({ output: resolve(flags.output), preset: flags.preset ?? 'project', from: flags.from, to: flags.to });
      if (flags.wait) job = await waitForRender(api, job);
      if (job.status === 'failed') throw new ApiError('RENDER_FAILED', job.error ?? 'Render failed', job.log);
      out(job, () => (job.status === 'done' ? `Rendered ${job.outputPath}` : `Render ${job.id} ${job.status} (use \`render status ${job.id}\`)`));
      return;
    }

    case 'room': {
      if (sub === 'host') {
        const r = await api.roomHost(flags.password);
        out(r, () => `Hosting room ${r.roomCode}${r.lanUrl ? ` · LAN ${r.lanUrl}` : ''}\nOthers join with: neon-cli room join ${r.roomCode}${flags.password ? ' --password …' : ''}`);
      } else if (sub === 'join') {
        if (!rest[0]) throw new ApiError('USAGE', 'room join <code> [--password P] [--host-url ws://ip:port]');
        const r = await api.roomJoin({ roomCode: rest[0], password: flags.password, hostUrl: flags['host-url'] });
        out(r, () => `Joined room ${r.roomCode} (${r.peers.length} peer(s))`);
      } else if (sub === 'leave') {
        const r = await api.roomLeave();
        out(r, () => 'Left room');
      } else if (sub === 'info' || sub === undefined) {
        const r = (await api.status()).room;
        out(r, () =>
          r.role === 'none'
            ? 'Not in a room'
            : `${r.role} ${r.roomCode}${r.lanUrl ? ` · ${r.lanUrl}` : ''}\n${table(r.peers.map((p) => [p.name, p.isLocal ? 'you' : p.transport, p.playheadFrame !== undefined ? String(p.playheadFrame) : '']), ['peer', 'via', 'playhead'])}`,
        );
      } else throw new ApiError('USAGE', 'room host|join|leave|info');
      return;
    }

    case 'preview': {
      if (!sub || !['play', 'pause', 'toggle', 'seek'].includes(sub)) throw new ApiError('USAGE', 'preview play|pause|toggle|seek <T>');
      if (sub === 'seek' && !rest[0] && !flags.at) throw new ApiError('USAGE', 'preview seek <T>');
      const r = await api.preview(sub as 'play' | 'pause' | 'toggle' | 'seek', rest[0] ?? flags.at);
      out(r, () => (sub === 'seek' ? `Playhead → frame ${r.frame}` : `Preview ${sub}`));
      return;
    }

    case 'rip': {
      if (!sub) throw new ApiError('USAGE', 'rip <url> [--quality 1080|720|best|audio] [--at T]');
      const job = await api.aiRun('rip', { url: sub, quality: flags.quality && ['360','480','720','1080','1440','2160','best','audio'].includes(flags.quality) ? flags.quality : flags.quality === undefined ? undefined : (() => { throw new ApiError('USAGE', '--quality 360|480|720|1080|1440|2160|best|audio'); })(), at: flags.at });
      const done = flags.wait ? await waitForAi(api, job) : job;
      out(done, () => (done.status === 'done' ? (done.result as { title: string; assetId: string; clipId?: string; startFrame?: number; deduplicated: boolean }).deduplicated ? `Already in the library: ${(done.result as { name: string }).name}` : `Ripped “${(done.result as { title: string }).title}” → ${(done.result as { name: string }).name}${(done.result as { clipId?: string }).clipId ? ` (placed at frame ${(done.result as { startFrame?: number }).startFrame})` : ''}` : `${done.op} ${done.status} (${done.id})`));
      return;
    }

    case 'record': {
      if (sub === 'start') {
        const r = (await api.call2('POST', '/api/record/start')) as { device: string };
        out(r, () => `Recording from “${r.device}” — stop with: neon-cli record stop [--at T]`);
      } else if (sub === 'stop') {
        const status = await api.status();
        const at = flags.at ?? String(status.project.durationFrames === 0 ? 0 : 0);
        const r = (await api.call2('POST', '/api/record/stop', { at: flags.at ?? 0 })) as ImportAssetResponse;
        void at;
        out(r, () => `Take “${r.asset.name}” placed${r.clip ? ` at frame ${r.clip.startFrame} on the VO track` : ''}`);
      } else throw new ApiError('USAGE', 'record start | record stop [--at T]');
      return;
    }

    case 'ai': {
      await aiCommand(api, sub, rest);
      return;
    }

    case 'ui': {
      const panelAlias: Record<string, string> = { media: 'assets', assets: 'assets', fx: 'templates', templates: 'templates', inspect: 'inspector', inspector: 'inspector', room: 'peers', peers: 'peers', render: 'renders', renders: 'renders', live: 'activity', activity: 'activity', ai: 'ai', script: 'script' };
      if (sub === 'panel') {
        const panel = panelAlias[(rest[0] ?? '').toLowerCase()];
        if (!panel) throw new ApiError('USAGE', 'ui panel <media|fx|inspect|room|render|live>');
        const r = await api.ui({ panel });
        out(r, () => `Opened ${panel} panel`);
      } else if (sub === 'select') {
        if (rest.length === 0) throw new ApiError('USAGE', 'ui select <clip...> | ui select none');
        let ids: string[] = [];
        if (rest[0] !== 'none') {
          const all = (await api.list()).clips;
          for (const ref of rest) ids.push((await api.resolveClip(ref, all)).id);
        }
        const r = await api.ui({ select: ids, panel: ids.length ? 'inspector' : undefined });
        out(r, () => (ids.length ? `Selected ${ids.length} clip(s)` : 'Selection cleared'));
      } else if (sub === 'dialog') {
        if (!rest[0]) throw new ApiError('USAGE', 'ui dialog <render|room|shortcuts|none>');
        const r = await api.ui({ dialog: rest[0] });
        out(r, () => `Dialog: ${rest[0]}`);
      } else throw new ApiError('USAGE', 'ui panel|select|dialog');
      return;
    }

    case 'events':
    case 'watch': {
      await tailEvents(api, Number(flags.history ?? 20));
      return;
    }

    case 'templates': {
      // Convenience alias: `neon-cli templates <Name>` prints the JSON schema.
      const name = sub;
      if (!name) {
        out(listTemplates().map((t) => t.name), () => listTemplates().map((t) => t.name).join('\n'));
        return;
      }
      const info = { name, defaults: templateDefaults(name), jsonSchema: templateJsonSchema(name) };
      out(info, () => JSON.stringify(info, null, 2));
      return;
    }

    default:
      throw new ApiError('USAGE', `Unknown command "${cmd}". Run neon-cli --help`);
  }
}

async function waitForAi(api: NeonClient, job: AiJob): Promise<AiJob> {
  let current = job;
  let last = '';
  while (current.status === 'queued' || current.status === 'running') {
    await new Promise((r) => setTimeout(r, 400));
    current = await api.aiJob(job.id);
    if (!json) {
      const line = `${current.op.padEnd(10)} ${progressBar(current.progress, 24)} ${current.message}`;
      if (line !== last) {
        process.stderr.write(`\r\x1b[2K${line}`);
        last = line;
      }
    }
  }
  if (!json) process.stderr.write('\n');
  if (current.status === 'failed') throw new ApiError('AI_FAILED', current.error ?? 'AI job failed', current.log);
  return current;
}

async function aiCommand(api: NeonClient, sub: string | undefined, rest: string[]): Promise<void> {
  const numOr = (v: string | undefined, d?: number) => (v === undefined ? d : Number(v));
  const assetOrClipParam = async (ref: string | undefined, usage: string): Promise<{ clipId: string; assetId?: never } | { assetId: string; clipId?: never }> => {
    if (!ref) throw new ApiError('USAGE', usage);
    const list = await api.list();
    const byId = list.clips.filter((c) => c.id === ref || c.id.startsWith(ref));
    if (byId.length === 1) return { clipId: byId[0]!.id };
    // A name that maps to exactly one clip targets that clip; several clips with the same name
    // (e.g. after cuts) fall through to the asset so the operation covers all of them.
    const byName = list.clips.filter((c) => c.name.toLowerCase() === ref.toLowerCase());
    if (byName.length === 1) return { clipId: byName[0]!.id };
    return { assetId: (await api.resolveAsset(ref, list.assets)).id };
  };
  const finish = async (job: AiJob, human: (j: AiJob) => string) => {
    const done = flags.wait ? await waitForAi(api, job) : job;
    out(done, () => (done.status === 'done' ? human(done) : `${done.op} ${done.status} (${done.id})`));
  };

  switch (sub) {
    case 'status': {
      const s = await api.aiStatus();
      const row = (name: string, ok: boolean, detail: string | undefined, hint: string | undefined) => [name, ok ? '✓ ready' : '✗ missing', ok ? detail ?? '' : hint ?? ''];
      out(s, () =>
        table(
          [
            row('whisper.cpp', s.whisper.available, `${s.whisper.binary} · ${s.whisper.model?.split('/').pop()}`, s.hints.whisper),
            row('rnnoise model', s.rnnoise.available, s.rnnoise.model, s.hints.rnnoise),
            row('DeepFilterNet', s.deepfilter.available, s.deepfilter.binary, s.hints.deepfilter),
            row('Apple Vision', s.vision.available, s.vision.binary, s.hints.vision),
            row('yt-dlp (rip)', s.ytdlp.available, s.ytdlp.binary, s.hints.ytdlp),
            row('ffmpeg', s.ffmpeg.available, 'ffmpeg/ffprobe', 'brew install ffmpeg'),
            row('Claude (B-roll)', s.claude.available, s.claude.model, s.hints.claude),
          ],
          ['engine', 'state', 'detail / how to install'],
        ),
      );
      return;
    }
    case 'jobs': {
      const jobs = await api.aiJobs();
      out(jobs, () => (jobs.length ? table(jobs.map((j) => [j.id, j.op, j.status, `${Math.round(j.progress * 100)}%`, j.message]), ['id', 'op', 'status', 'progress', 'message']) : 'No AI jobs yet'));
      return;
    }
    case 'job': {
      if (!rest[0]) throw new ApiError('USAGE', 'ai job <id>');
      const j = await api.aiJob(rest[0]);
      out(j, () => `${j.id} ${j.op} ${j.status} ${Math.round(j.progress * 100)}% — ${j.message}${j.result ? `\n${JSON.stringify(j.result, null, 2)}` : ''}${j.error ? `\n${j.error}` : ''}`);
      return;
    }
    case 'cancel': {
      if (!rest[0]) throw new ApiError('USAGE', 'ai cancel <id>');
      const j = await api.aiCancel(rest[0]);
      out(j, () => `${j.id} ${j.status}`);
      return;
    }
    case 'transcribe': {
      const target = await assetOrClipParam(rest[0], 'ai transcribe <clip|asset>');
      await finish(await api.aiRun('transcribe', { ...target, force: flags.force }), (j) => {
        const r = j.result as { words: number; fillers: number; text: string; engine: string };
        return `${r.words} words · ${r.fillers} fillers · ${r.engine}\n${r.text}`;
      });
      return;
    }
    case 'transcript': {
      const target = await assetOrClipParam(rest[0], 'ai transcript <clip|asset>');
      let assetId: string;
      if (target.assetId) assetId = target.assetId;
      else {
        const clip = await api.resolveClip(rest[0]!);
        if (clip.kind === 'component') throw new ApiError('USAGE', 'That clip is a template, not media');
        assetId = clip.assetId;
      }
      const t = await api.transcript(assetId);
      out(t, () => t.words.map((w, i) => `${w.filler ? `⟨${w.w}⟩` : w.w}${(i + 1) % 18 === 0 ? '\n' : ''}`).join(' ') + `\n\n(${t.words.length} words · ${t.engine} · word indexes for \`ai cut\` start at 0)`);
      return;
    }
    case 'fillers': {
      const target = await assetOrClipParam(rest[0], 'ai fillers <clip> [--apply]');
      await finish(await api.aiRun('fillers', { ...target, apply: flags.apply, words: flags.words?.split(',').map((w) => w.trim()).filter(Boolean), padMs: numOr(flags.pad) }), (j) => {
        const r = j.result as { fillers: number; words: string[]; removedFrames: number; applied: boolean; ranges: unknown[] };
        return r.applied ? `Removed ${r.fillers} filler(s): ${r.words.join(' ')} — ${r.removedFrames} frames cut` : `${r.fillers} filler(s) in ${r.ranges.length} range(s): ${r.words.join(' ')}\nRe-run with --apply to cut them.`;
      });
      return;
    }
    case 'silence': {
      const target = await assetOrClipParam(rest[0], 'ai silence <clip> [--apply]');
      await finish(await api.aiRun('silence', { ...target, apply: flags.apply, thresholdDb: numOr(flags.threshold), minSilenceMs: numOr(flags.min), keepMs: numOr(flags.keep) }), (j) => {
        const r = j.result as { silences: number; cuts: unknown[]; removedFrames: number; applied: boolean; noiseFloorDb: number; thresholdDb: number };
        return `${r.silences} pause(s) ≥ threshold (floor ${r.noiseFloorDb.toFixed(1)} dB, speech > ${r.thresholdDb.toFixed(1)} dB) · ${r.cuts.length} cut(s)${r.applied ? ` applied — ${r.removedFrames} frames removed` : ' — add --apply to trim'}`;
      });
      return;
    }
    case 'breaths': {
      const target = await assetOrClipParam(rest[0], 'ai breaths <clip> [--db 15]');
      await finish(await api.aiRun('breaths', { ...target, reductionDb: numOr(flags.db) }), (j) => {
        const r = j.result as { breaths: number; reductionDb: number };
        return `${r.breaths} breath/mouth-noise event(s) attenuated by ${r.reductionDb} dB (volume keyframes on the clip)`;
      });
      return;
    }
    case 'enhance': {
      const target = await assetOrClipParam(rest[0], 'ai enhance <clip> [--lufs=-16] [--no-denoise]');
      await finish(await api.aiRun('enhance', { ...target, lufs: numOr(flags.lufs), denoise: flags.denoise !== false ? true : false, strength: numOr(flags.strength) }), (j) => {
        const r = j.result as { lufs: number; filter: string; newAssetId: string };
        return `Voice enhanced to ${r.lufs} LUFS → clip now uses asset ${r.newAssetId.slice(0, 12)}… (original kept)\nchain: ${r.filter}`;
      });
      return;
    }
    case 'setup': {
      await finish(await api.aiRun('setup', { model: flags.model ?? 'base.en' }), (j) => {
        const r = j.result as { installed: string[]; skipped: string[]; whisperReady: boolean };
        return `${r.installed.length ? `Installed: ${r.installed.join(', ')}` : 'Nothing new to install'}${r.skipped.length ? `\nAlready present: ${r.skipped.join(', ')}` : ''}\nSpeech recognition ${r.whisperReady ? 'is ready ✓' : 'still unavailable ✗'}`;
      });
      return;
    }
    case 'denoise': {
      const target = await assetOrClipParam(rest[0], 'ai denoise <clip>');
      await finish(await api.aiRun('denoise', { ...target, engine: flags.engine, strength: numOr(flags.strength) }), (j) => {
        const r = j.result as { engine: string; filter: string; newAssetId: string };
        return `Denoised with ${r.engine} (${r.filter}) → clip now uses asset ${r.newAssetId.slice(0, 12)}… (original kept)`;
      });
      return;
    }
    case 'matte': {
      const target = await assetOrClipParam(rest[0], 'ai matte <clip> [--mode person|chroma]');
      await finish(await api.aiRun('matte', { ...target, mode: flags.mode, quality: flags.quality, color: flags.color }), (j) => {
        const r = j.result as { mode: string; newAssetId: string; frames?: number };
        return `Background removed (${r.mode}${r.frames ? `, ${r.frames} frames` : ''}) → ProRes 4444 alpha asset ${r.newAssetId.slice(0, 12)}…`;
      });
      return;
    }
    case 'reframe': {
      const target = await assetOrClipParam(rest[0], 'ai reframe <clip> [--aspect 9:16] [--resize]');
      await finish(await api.aiRun('reframe', { ...target, aspect: flags.aspect, resizeProject: flags.resize }), (j) => {
        const r = j.result as { mode: string; detectedRatio: number; samples: number; resized: { width: number; height: number } | null };
        return `${r.mode}: faces in ${Math.round(r.detectedRatio * 100)}% of ${r.samples} samples${r.resized ? ` · project resized to ${r.resized.width}×${r.resized.height}` : ''}`;
      });
      return;
    }
    case 'broll': {
      const assetId = rest[0] ? (await api.resolveAsset(rest[0])).id : undefined;
      const durationSeconds = flags.duration ? Number(String(flags.duration).replace(/s$/, '')) : undefined;
      await finish(await api.aiRun('broll', { assetId, apply: flags.apply, useClaude: flags.claude, durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : undefined }), (j) => {
        const r = j.result as { suggestions: { startS: number; endS: number; keyword: string; assetName: string; score: number; reason: string; source: string }[]; placed: number; applied: boolean; claude: boolean };
        if (r.suggestions.length === 0) return 'No B-roll matches — name your library files after what they show (e.g. stock-market-chart.mp4)';
        return `${r.claude ? 'Claude + heuristic' : 'heuristic'} · ${r.suggestions.length} suggestion(s)${r.applied ? `, ${r.placed} placed` : ' (add --apply to place them)'}\n` +
          table(r.suggestions.map((s) => [`${s.startS.toFixed(1)}s–${s.endS.toFixed(1)}s`, s.keyword, s.assetName, s.source, s.reason]), ['when', 'concept', 'asset', 'via', 'reason']);
      });
      return;
    }
    case 'clean': {
      const target = await assetOrClipParam(rest[0], 'ai clean <clip>');
      await finish(await api.aiRun('clean', { ...target, fillers: flags.fillers, silences: flags.silences, breaths: flags.breaths, denoise: flags.denoise }), (j) => `Voice clean-up finished: ${(j.result as { steps: string[] }).steps.join(' → ')}`);
      return;
    }
    case 'cut': {
      if (rest.length < 3) throw new ApiError('USAGE', 'ai cut <asset> <fromWord> <toWord>');
      const asset = await api.resolveAsset(rest[0]!);
      await finish(await api.transcriptCut(asset.id, Number(rest[1]), Number(rest[2])), (j) => `Cut “${(j.result as { words: string }).words}” — ${(j.result as { removedFrames: number }).removedFrames} frames removed`);
      return;
    }
    default:
      throw new ApiError('USAGE', 'ai status|setup|transcribe|transcript|fillers|silence|breaths|denoise|enhance|matte|reframe|broll|clean|cut|jobs|job|cancel');
  }
}

/** Stream GET /api/events (SSE) to the terminal until interrupted. */
async function tailEvents(api: NeonClient, history: number): Promise<void> {
  const res = await api.openEventStream(history);
  if (!res.body) throw new ApiError('NO_STREAM', 'Event stream unavailable');
  const badge: Record<string, string> = { cli: '⌁ CLI', ui: '◉ UI', peer: '⇄ PEER', render: '▶ RENDER', room: '⊕ ROOM', system: '· SYS', ai: '✦ AI' };
  if (!json) process.stderr.write(`tailing ${api.endpoint}/api/events — Ctrl-C to stop\n`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      const event = JSON.parse(dataLine.slice(6)) as { type: string; [k: string]: unknown };
      if (event.type === 'heartbeat') continue;
      if (json) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
        continue;
      }
      if (event.type === 'activity') {
        const e = event.entry as { ts: string; source: string; message: string; action: string };
        process.stdout.write(`${e.ts.slice(11, 19)}  ${(badge[e.source] ?? e.source).padEnd(9)} ${e.message}\n`);
      } else if (event.type === 'render') {
        const job = event.job as RenderJob;
        if (job.status === 'rendering') process.stdout.write(`\r          ▶ RENDER  ${progressBar(job.progress, 20)} ${job.renderedFrames}/${job.totalFrames}`);
        if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') process.stdout.write('\n');
      } else if (event.type === 'ai') {
        const job = event.job as AiJob;
        process.stdout.write(`\r\x1b[2K          ✦ AI      ${job.op.padEnd(10)} ${progressBar(job.progress, 16)} ${job.message}${job.status === 'running' || job.status === 'queued' ? '' : '\n'}`);
      } else if (event.type === 'project-changed') {
        const pc = event as unknown as { clips: number; durationFrames: number };
        process.stdout.write(`          ~ DOC     ${pc.clips} clips · ${pc.durationFrames} frames\n`);
      } else if (event.type === 'room') {
        const room = event.room as { role: string; roomCode: string; peers: unknown[] };
        process.stdout.write(`          ⊕ ROOM    ${room.role === 'none' ? 'not connected' : `${room.role} ${room.roomCode} · ${room.peers.length} peer(s)`}\n`);
      }
    }
  }
}

// Local sanity for presets referenced in help output.
void RENDER_PRESETS;

main().catch(fail);
