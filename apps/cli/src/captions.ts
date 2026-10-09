/**
 * `neon-cli captions …`: burn captions into the video (a Captions clip over the whole timeline)
 * and export subtitle files. Cues are computed here from `state dump` with the same @neon/core
 * functions the Captions template uses, so an exported SRT matches the burned-in text.
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CAPTIONS_SCHEMA, parseTrackList, projectCaptions, projectDurationFrames, toSrt, toVtt, type CaptionsProps, type ComponentClip, type Project } from '@neon/core';
import { ApiError, type NeonClient } from './client.ts';

export const CAPTIONS_USAGE = 'captions add [--track REF] [--style karaoke|block] [--source A1,V1] · captions srt|vtt [--out file] [--source A1,V1]';

/** Track name for captions when --track is not given; created on first use. */
const CAPTION_TRACK = 'CC';

export interface CaptionsFlags {
  track?: string;
  style?: string;
  source?: string;
  out?: string;
}

export interface CaptionsResult {
  data: unknown;
  text: string;
}

function captionClips(project: Project): ComponentClip[] {
  return project.clips.filter((c): c is ComponentClip => c.kind === 'component' && c.componentName === 'Captions').sort((a, b) => a.startFrame - b.startFrame);
}

/** A Captions clip's props, validated with defaults filled; plain defaults when there is no clip. */
function propsOf(clip: ComponentClip | undefined): CaptionsProps {
  const parsed = CAPTIONS_SCHEMA.safeParse(clip?.props ?? {});
  return parsed.success ? parsed.data : CAPTIONS_SCHEMA.parse({});
}

export async function captionsCommand(api: NeonClient, sub: string | undefined, flags: CaptionsFlags): Promise<CaptionsResult> {
  const { project } = await api.state();
  switch (sub) {
    case 'add':
      return addCaptions(api, project, flags);
    case 'srt':
    case 'vtt':
      return exportCaptions(project, sub, flags);
    default:
      throw new ApiError('USAGE', CAPTIONS_USAGE);
  }
}

/**
 * Insert one Captions clip from 0 to the end of the timeline. Running it again replaces the
 * Captions clips on that track (keeping their style), so it also re-spans captions after the
 * timeline grew or was cut into pieces.
 */
async function addCaptions(api: NeonClient, project: Project, flags: CaptionsFlags): Promise<CaptionsResult> {
  if (project.transcripts.length === 0) throw new ApiError('NO_TRANSCRIPT', 'No transcripts yet. Run neon-cli ai transcribe <clip> first.');
  const track = flags.track
    ? await api.resolveTrack(flags.track, project.tracks)
    : project.tracks.find((t) => t.kind === 'overlay' && t.name === CAPTION_TRACK) ?? (await api.trackAdd('overlay', CAPTION_TRACK));
  if (track.kind !== 'overlay') throw new ApiError('USAGE', `Captions go on an overlay track; "${track.name}" is a ${track.kind} track`);

  const previous = captionClips(project).filter((c) => c.trackId === track.id);
  const props = {
    ...(previous[0] ? propsOf(previous[0]) : {}),
    ...(flags.style !== undefined ? { style: flags.style } : {}),
    ...(flags.source !== undefined ? { tracks: flags.source } : {}),
  };
  // The content's length: captions clips themselves do not extend the timeline.
  const captionIds = new Set(captionClips(project).map((c) => c.id));
  const duration = projectDurationFrames({ clips: project.clips.filter((c) => !captionIds.has(c.id)) });
  if (duration === 0) throw new ApiError('EMPTY', 'The timeline is empty');

  if (previous.length) await api.remove(previous.map((c) => c.id));
  const clip = await api.insert({ kind: 'component', componentName: 'Captions', props, at: 0, duration, trackId: track.id, name: 'Captions', placement: 'overlap' });
  const resolved = propsOf(clip.kind === 'component' ? clip : undefined);
  const cues = projectCaptions(project, { tracks: parseTrackList(resolved.tracks), maxWords: resolved.maxWords });
  return {
    data: { clip, cues: cues.length, replaced: previous.length },
    text: `${previous.length ? 'Replaced' : 'Added'} captions on ${track.name} (${clip.id}, ${resolved.style}, ${duration} frames): ${cues.length} cue(s)${cues.length ? '' : '. No transcribed speech is audible on the timeline yet'}`,
  };
}

/** Subtitles for the timeline. Without --source, use the burned-in clip's track choice so both agree. */
async function exportCaptions(project: Project, format: 'srt' | 'vtt', flags: CaptionsFlags): Promise<CaptionsResult> {
  const props = propsOf(captionClips(project)[0]);
  const cues = projectCaptions(project, { tracks: parseTrackList(flags.source ?? props.tracks), maxWords: props.maxWords });
  const body = format === 'srt' ? toSrt(cues, project.meta.fps) : toVtt(cues, project.meta.fps);
  if (!flags.out) return { data: { format, cues: cues.length, text: body }, text: body.trimEnd() };
  const path = resolve(flags.out);
  await writeFile(path, body);
  return { data: { format, cues: cues.length, written: path }, text: `Wrote ${cues.length} cue(s) to ${path}` };
}
