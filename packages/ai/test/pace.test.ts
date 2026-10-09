import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFreezes, planPacing } from '../src/pace.ts';

test('freezedetect output becomes frozen spans, an open freeze runs to the end', () => {
  const log = [
    '[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 2.5',
    '[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 1.5',
    '[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 4',
    '[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 9.2',
  ].join('\n');
  assert.deepEqual(parseFreezes(log, 12), [
    { start: 2.5, end: 4 },
    { start: 9.2, end: 12 },
  ]);
});

test('a pause is split where the screen stops moving: the moving part speeds up, the still part is cut', () => {
  assert.deepEqual(planPacing([{ start: 3, end: 9 }], [{ start: 6, end: 9.5 }], { keepMs: 200, rate: 6 }), [
    { kind: 'speed', start: 3.1, end: 6, rate: 6 },
    { kind: 'cut', start: 6, end: 8.9 },
  ]);
});

test('pauses over a frozen screen are cut, pauses over a moving screen are sped up', () => {
  const pauses = [
    { start: 2, end: 4 }, // screen frozen the whole time
    { start: 6, end: 10 }, // screen changing (install progress)
    { start: 11, end: 11.15 }, // too short once the kept edges are taken
  ];
  const freezes = [{ start: 1.9, end: 4.2 }];
  assert.deepEqual(planPacing(pauses, freezes, { keepMs: 200, rate: 6 }), [
    { kind: 'cut', start: 2.1, end: 3.9 },
    { kind: 'speed', start: 6.1, end: 9.9, rate: 6 },
  ]);
});
