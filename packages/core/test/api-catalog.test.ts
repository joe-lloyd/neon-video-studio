import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_ROUTES } from '../src/api.ts';
import { bodyJsonSchema, catalogEntries, checkBatchRoute, findRoute } from '../src/api-catalog.ts';

test('every API_ROUTES path has exactly one catalogue entry and nothing else does', () => {
  const routePaths = Object.values(API_ROUTES).sort();
  const catalogPaths = catalogEntries().map((e) => e.path).sort();
  assert.deepEqual(catalogPaths, routePaths);
});

test('every POST route that takes a JSON body exports a JSON Schema object', () => {
  const posts = catalogEntries().filter((e) => e.spec.method === 'POST');
  assert.ok(posts.length >= 40, `expected the full POST surface, got ${posts.length}`);
  for (const e of posts) {
    const schema = bodyJsonSchema(e.spec);
    if (e.spec.method === 'POST' && e.spec.body === null) assert.equal(schema, null, e.path);
    else assert.ok(schema?.type === 'object' || Array.isArray(schema?.oneOf) || Array.isArray(schema?.anyOf), `${e.path} has an object schema`);
  }
});

test('the insert schema describes both clip kinds', () => {
  const insert = findRoute('POST', '/api/timeline/insert');
  assert.equal(insert?.key, 'timelineInsert');
  const schema = bodyJsonSchema(insert!.spec);
  const variants = (schema?.oneOf ?? schema?.anyOf) as { properties: Record<string, unknown>; required: string[] }[];
  assert.deepEqual(variants.map((v) => v.required), [['kind', 'componentName'], ['kind', 'assetId']]);
});

test('findRoute matches :param routes and prefers literal paths', () => {
  assert.equal(findRoute('POST', '/api/render/r_123/cancel')?.key, 'renderCancel');
  assert.equal(findRoute('GET', '/api/ai/jobs/j_9')?.key, 'aiJob');
  assert.equal(findRoute('POST', '/api/ai/transcript/cut')?.key, 'aiTranscriptCut');
  assert.equal(findRoute('GET', '/api/ai/transcript/abc123')?.key, 'aiTranscriptGet');
  assert.equal(findRoute('POST', '/api/status'), undefined);
  assert.equal(findRoute('GET', '/api/nope'), undefined);
});

test('batches accept edits and refuse routes a rollback cannot undo', () => {
  assert.equal(checkBatchRoute('/api/timeline/insert').ok, true);
  assert.equal(checkBatchRoute('/api/tracks/add').ok, true);
  for (const route of ['/api/batch', '/api/render', '/api/room/host', '/api/shutdown', '/api/history/undo', '/api/project/open', '/api/ai/fillers']) {
    assert.equal(checkBatchRoute(route).ok, false, route);
  }
  assert.deepEqual(checkBatchRoute('/api/render'), { ok: false, reason: '/api/render cannot run inside a batch: it starts a background job that keeps editing after the batch ends' });
  assert.deepEqual(checkBatchRoute('/api/timeline/nope'), { ok: false, reason: 'no POST route /api/timeline/nope (see neon-cli schema)' });
});
