import { test } from 'node:test';
import assert from 'node:assert/strict';
import { YouTubeUploadRequestSchema, youtubeVideoId } from '@neon/core';
import { describeAuth, describeUpload, youtubeUploadBody } from '../src/youtube.ts';

const io = { appPath: (p: string) => `/abs/${p}` };
const files = { json: () => ({ title: 'From file', description: 'File description', tags: ['a'] }), text: () => 'Long description\nfrom a file' };

test('flags map onto a body the app accepts', () => {
  const body = youtubeUploadBody('out.mp4', { title: 'Neon in 60s', kids: false, tags: 'video editor, typescript,', privacy: 'unlisted', 'ai-content': true, license: 'cc', notify: false, playlist: 'PL1', thumbnail: 't.png', 'description-file': 'd.md' }, io, files);
  assert.deepEqual(body, {
    source: { kind: 'file', path: '/abs/out.mp4' },
    metadata: { title: 'Neon in 60s', description: 'Long description\nfrom a file', tags: ['video editor', 'typescript'], privacy: 'unlisted', madeForKids: false, containsSyntheticMedia: true, license: 'creativeCommon', notifySubscribers: false, playlistId: 'PL1', thumbnail: '/abs/t.png' },
  });
  const parsed = YouTubeUploadRequestSchema.parse(body);
  assert.equal(parsed.metadata.categoryId, '28');
  assert.equal(parsed.metadata.embeddable, true);
});

test('no file renders the timeline; flags beat --metadata', () => {
  const body = youtubeUploadBody(undefined, { metadata: 'meta.json', title: 'From flag', kids: true, preset: '1080p30', from: '0:10' }, io, files);
  assert.deepEqual(body, {
    source: { kind: 'timeline', preset: '1080p30', from: '0:10', to: undefined },
    metadata: { title: 'From flag', description: 'File description', tags: ['a'], madeForKids: true },
  });
});

test('the questions YouTube insists on are asked before anything uploads', () => {
  assert.throws(() => youtubeUploadBody('a.mp4', { kids: false }, io, files), /needs --title/);
  assert.throws(() => youtubeUploadBody('a.mp4', { title: 'x' }, io, files), /made for kids\? Pass --no-kids/);
  assert.throws(() => youtubeUploadBody('a.mp4', { title: 'x', kids: false, preset: '4k30' }, io, files), /leave out the file/);
});

test('status lines say where the video went and what needs attention', () => {
  assert.equal(describeAuth({ state: 'signed-in', channel: { id: 'UC1', title: 'Joe Lloyd Web Apps', handle: '@joelloydwebapps' } }), 'Signed in to YouTube as Joe Lloyd Web Apps (@joelloydwebapps)');
  assert.equal(
    describeUpload({ id: 'yt_1', status: 'done', title: 'Demo', privacy: 'unlisted', renderJobId: null, filePath: '/a.mp4', progress: 1, bytesSent: 10, totalBytes: 10, videoId: 'v1', url: 'https://youtu.be/v1', warnings: ['locked to private'], error: null, startedAt: '', finishedAt: '' }),
    'yt_1 “Demo” done → https://youtu.be/v1 (unlisted)\n  warning: locked to private',
  );
  assert.equal(
    describeUpload({ id: 'yt_2', status: 'uploading', title: 'Demo', privacy: 'private', renderJobId: null, filePath: '/a.mp4', progress: 0.5, bytesSent: 5 * 1024 * 1024, totalBytes: 10 * 1024 * 1024, videoId: null, url: null, warnings: [], error: null, startedAt: '', finishedAt: null }),
    `yt_2 “Demo” uploading [${'█'.repeat(15)}${'░'.repeat(15)}]  50.0% 5.0/10.0 MB`,
  );
});

test('video ids come from ids and every kind of YouTube link', () => {
  for (const input of ['hN8Oma0a6G0', 'https://youtu.be/hN8Oma0a6G0', 'https://www.youtube.com/watch?v=hN8Oma0a6G0&t=3', 'https://studio.youtube.com/video/hN8Oma0a6G0/edit', 'https://www.youtube.com/shorts/hN8Oma0a6G0']) {
    assert.equal(youtubeVideoId(input), 'hN8Oma0a6G0', input);
  }
  assert.equal(youtubeVideoId('https://example.com/nothing'), null);
});
