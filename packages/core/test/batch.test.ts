import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlan, parsePlan, resolveRefs } from '../src/batch.ts';

const clip = { id: 'c_1', name: 'Title', startFrame: 30 };
const split = [{ id: 'c_left' }, { id: 'c_right' }];

test('resolveRefs replaces whole-string refs with values from earlier results', () => {
  const body = { id: '$0.id', patch: { startFrame: '$0.startFrame', name: 'keep $0.id' }, ids: ['$1.1.id', '$1.0.id'], whole: '$0' };
  assert.deepEqual(resolveRefs(body, [clip, split]), {
    id: 'c_1',
    patch: { startFrame: 30, name: 'keep $0.id' },
    ids: ['c_right', 'c_left'],
    whole: clip,
  });
});

test('resolveRefs unescapes $$ to a literal $', () => {
  assert.deepEqual(resolveRefs({ text: '$$5.99', other: '$$0.id' }, [clip]), { text: '$5.99', other: '$0.id' });
});

test('resolveRefs explains bad refs', () => {
  assert.throws(() => resolveRefs({ id: '$1.id' }, [clip]), { message: '$1.id points at op 1, which has not run yet; refs name earlier ops (write "$$…" to send text that starts with "$")' });
  assert.throws(() => resolveRefs({ id: '$0.nope' }, [clip]), { message: '$0.nope: $0 has no "nope" (it has: id, name, startFrame)' });
  assert.throws(() => resolveRefs({ id: '$0.5.id' }, [split]), { message: '$0.5.id: $0 is a list of 2, "5" is not an index in it' });
});

test('parsePlan accepts {ops} and a bare array', () => {
  const ops = [{ route: '/api/tracks/add', body: { kind: 'overlay' } }];
  assert.deepEqual(parsePlan({ ops }), { ops });
  assert.deepEqual(parsePlan(ops), { ops });
  assert.throws(() => parsePlan({ ops: [] }));
  assert.throws(() => parsePlan([{ route: 'timeline/insert' }]));
});

test('checkPlan validates bodies offline and skips positions filled by refs', () => {
  const plan = parsePlan([
    { route: '/api/timeline/insert', body: { kind: 'component', componentName: 'TextOverlay', at: '1s' } },
    { route: '/api/timeline/update', body: { id: '$0.id', patch: { durationFrames: 45 } } },
    { route: '/api/timeline/move', body: { id: '$0.id' } },
    { route: '/api/render', body: { output: 'x.mp4' } },
    { route: '/api/timeline/remove', body: { ids: ['$5.id'] } },
    { route: '/api/timeline/update', body: { id: 7, patch: {} } },
  ]);
  assert.deepEqual(checkPlan(plan), [
    { op: 0, route: '/api/timeline/insert', problems: [] },
    { op: 1, route: '/api/timeline/update', problems: [] },
    { op: 2, route: '/api/timeline/move', problems: ['at: Invalid input'] },
    { op: 3, route: '/api/render', problems: ['/api/render cannot run inside a batch: it starts a background job that keeps editing after the batch ends'] },
    { op: 4, route: '/api/timeline/remove', problems: ['$5.id must point at an earlier op, this is op 4 (write "$$…" to send text that starts with "$")'] },
    { op: 5, route: '/api/timeline/update', problems: ['id: Invalid input: expected string, received number'] },
  ]);
});
