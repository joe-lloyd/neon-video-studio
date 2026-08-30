#!/usr/bin/env node
/**
 * neon-cli — command line / AI-agent interface for Neon Video Studio.
 * Talks to the running desktop app over its local control API (127.0.0.1 + bearer token),
 * or renders a project directory headlessly without the app.
 */
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RENDER_PRESETS, framesToTimecode, listTemplates, templateDefaults, templateJsonSchema, type ImportAssetResponse, type RenderJob } from '@neon/core';
import { renderHeadless } from '@neon/render';
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
  preview play|pause|toggle|seek <T>      Drive the app's preview player (watch your edits play back)
  ui panel <media|fx|inspect|room|render|live> | ui select <clip...> | ui select none | ui dialog <render|room|shortcuts|none>

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
        const clip = await api.update(target.id, {
          props: parseJsonFlag(flags.props, 'props'),
          startFrame: flags.start,
          durationFrames: flags.duration,
          trimBefore: flags.trim,
          name: flags.name,
          volume: num(flags.volume),
          trackId,
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
      } else if (sub === 'remove') {
        if (rest.length === 0) throw new ApiError('USAGE', 'timeline remove <clip...>');
        const all = (await api.list()).clips;
        const ids = [];
        for (const ref of rest) ids.push((await api.resolveClip(ref, all)).id);
        const r = await api.remove(ids);
        out(r, () => `Removed ${r.removed} clip(s)`);
      } else throw new ApiError('USAGE', 'timeline insert|update|move|split|remove');
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

    case 'ui': {
      const panelAlias: Record<string, string> = { media: 'assets', assets: 'assets', fx: 'templates', templates: 'templates', inspect: 'inspector', inspector: 'inspector', room: 'peers', peers: 'peers', render: 'renders', renders: 'renders', live: 'activity', activity: 'activity' };
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

/** Stream GET /api/events (SSE) to the terminal until interrupted. */
async function tailEvents(api: NeonClient, history: number): Promise<void> {
  const res = await api.openEventStream(history);
  if (!res.body) throw new ApiError('NO_STREAM', 'Event stream unavailable');
  const badge: Record<string, string> = { cli: '⌁ CLI', ui: '◉ UI', peer: '⇄ PEER', render: '▶ RENDER', room: '⊕ ROOM', system: '· SYS' };
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
