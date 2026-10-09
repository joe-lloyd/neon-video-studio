import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SheetRequestSchema, StillRequestSchema, sheetFrames, sheetFramesFor, sheetLayout, stillFileName, stillFrame } from '../src/index.ts';

test('count picks the middle of equal slices', () => {
  assert.deepEqual(sheetFrames(0, 359, { by: 'count', count: 12 }), [15, 45, 75, 105, 135, 165, 195, 225, 255, 285, 315, 345]);
  assert.deepEqual(sheetFrames(100, 199, { by: 'count', count: 4 }), [112, 137, 162, 187]);
  assert.deepEqual(sheetFrames(0, 89, { by: 'count', count: 1 }), [45]);
});

test('count never repeats a frame on a short range', () => {
  assert.deepEqual(sheetFrames(10, 12, { by: 'count', count: 12 }), [10, 11, 12]);
});

test('every steps from the start of the range and keeps the end when it lands on it', () => {
  assert.deepEqual(sheetFrames(0, 299, { by: 'every', every: 150 }), [0, 150]);
  assert.deepEqual(sheetFrames(0, 300, { by: 'every', every: 150 }), [0, 150, 300]);
  assert.deepEqual(sheetFrames(30, 30, { by: 'every', every: 5 }), [30]);
});

test('every refuses more frames than a sheet holds', () => {
  assert.throws(() => sheetFrames(0, 1000, { by: 'every', every: 1 }), /at most 100/);
  assert.throws(() => sheetFrames(10, 5, { by: 'count', count: 2 }), /before it starts/);
});

test('sheet requests resolve timecodes against the timeline', () => {
  const req = SheetRequestSchema.parse({});
  assert.deepEqual(sheetFramesFor(req, 30, 120), [5, 15, 25, 35, 45, 55, 65, 75, 85, 95, 105, 115]);
  assert.deepEqual(sheetFramesFor(SheetRequestSchema.parse({ every: '1s' }), 30, 120), [0, 30, 60, 90]);
  assert.deepEqual(sheetFramesFor(SheetRequestSchema.parse({ from: '1s', to: '2s', count: 2 }), 30, 120), [37, 53]);
  // `to` past the end clamps to the last frame.
  assert.deepEqual(sheetFramesFor(SheetRequestSchema.parse({ from: 100, to: '1:00', every: 10 }), 30, 120), [100, 110]);
  assert.throws(() => sheetFramesFor(req, 30, 0), /empty/);
  assert.equal(SheetRequestSchema.safeParse({ count: 4, every: '1s' }).success, false);
});

test('still requests reject frames past the end', () => {
  assert.equal(stillFrame(StillRequestSchema.parse({ at: '2s' }), 30, 120), 60);
  assert.equal(StillRequestSchema.parse({ at: 0 }).width, 1280);
  assert.throws(() => stillFrame({ at: '4s' }, 30, 120), /past the end of the timeline \(00:00:04:00\)/);
});

test('sheet layout fills the width with 16:9 cells and label strips', () => {
  const layout = sheetLayout({ frames: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], cols: 4, width: 1920, source: { width: 1920, height: 1080 } });
  assert.deepEqual(
    { width: layout.width, height: layout.height, cols: layout.cols, rows: layout.rows, gap: layout.gap, cellWidth: layout.cellWidth, cellHeight: layout.cellHeight, labelHeight: layout.labelHeight },
    { width: 1920, height: 921, cols: 4, rows: 3, gap: 12, cellWidth: 465, cellHeight: 262, labelHeight: 29 },
  );
  assert.deepEqual(layout.cells[0], { frame: 1, x: 12, y: 12 });
  assert.deepEqual(layout.cells[5], { frame: 6, x: 489, y: 315 });
  assert.deepEqual(layout.cells[11], { frame: 12, x: 1443, y: 618 });
});

test('sheet layout drops unused columns and centres the grid', () => {
  const layout = sheetLayout({ frames: [0, 10], cols: 4, width: 1000, source: { width: 1080, height: 1920 } });
  assert.equal(layout.cols, 2);
  assert.equal(layout.cellWidth, 491);
  assert.equal(layout.cellHeight, 873);
  assert.deepEqual(layout.cells.map((c) => c.x), [6, 503]);
  assert.throws(() => sheetLayout({ frames: [1, 2, 3, 4, 5, 6, 7, 8], cols: 8, width: 256, source: { width: 16, height: 9 } }), /do not fit/);
});

test('still file names are file-system safe', () => {
  assert.equal(stillFileName('My Demo!', 30, [45]), 'My-Demo-00-00-01-15.png');
  assert.equal(stillFileName('demo', 30, [0, 30, 60]), 'demo-sheet-00-00-00-00-00-00-02-00.png');
  assert.equal(stillFileName('***', 30, [0]), 'project-00-00-00-00.png');
});
