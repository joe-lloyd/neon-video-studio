import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filterPath } from '../src/exec.ts';
import { buildEnhanceFilter } from '../src/enhance.ts';

test('a Windows model path survives both levels of ffmpeg filter escaping', () => {
  assert.equal(filterPath('C:\\Users\\joell\\.neon-video\\models\\std.rnnn'), "'C\\:/Users/joell/.neon-video/models/std.rnnn'");
  assert.equal(filterPath('/Users/joe/.neon-video/models/std.rnnn'), "'/Users/joe/.neon-video/models/std.rnnn'");
  assert.ok(buildEnhanceFilter({ lufs: -16, denoise: true, strength: 0.5, rnnoiseModel: 'C:\\m\\std.rnnn' }).includes("arnndn=m='C\\:/m/std.rnnn':mix=0.55"));
});

// Real ffmpeg, when one is around (NEON_TEST_FFMPEG + NEON_TEST_RNNOISE): a model path with a colon parses.
const ffmpeg = process.env.NEON_TEST_FFMPEG;
const model = process.env.NEON_TEST_RNNOISE;
test('ffmpeg accepts the escaped path', { skip: !ffmpeg || !model || !existsSync(model) }, () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'neon-fp-')), 'odd:dir');
  mkdirSync(dir);
  const copy = join(dir, "it's.rnnn");
  copyFileSync(model!, copy);
  const r = spawnSync(ffmpeg!, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=d=0.5', '-af', `aresample=48000,arnndn=m=${filterPath(copy)}`, '-f', 'null', '-'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
