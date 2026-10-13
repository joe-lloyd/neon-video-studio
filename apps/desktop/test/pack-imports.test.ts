import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBareImport } from '../src/main/pack-imports.ts';

test('a Windows absolute entry path is a file, not a package', () => {
  assert.equal(isBareImport('C:\\Users\\joell\\.neon-video\\packs\\bytemyfaceoff\\index.tsx'), false);
  assert.equal(isBareImport('D:/packs/x/index.tsx'), false);
});

test('POSIX absolute and relative paths are files', () => {
  assert.equal(isBareImport('/Users/joe/.neon-video/packs/my-pack/index.tsx'), false);
  assert.equal(isBareImport('./tokens.ts'), false);
  assert.equal(isBareImport('../shared.ts'), false);
});

test('package names are bare', () => {
  assert.equal(isBareImport('react'), true);
  assert.equal(isBareImport('@neon/fx-kit'), true);
  assert.equal(isBareImport('d3'), true);
});
