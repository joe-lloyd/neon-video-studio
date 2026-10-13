import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Script } from '@neon/core';
import { findLine, findNote, formatNotes, formatScript, noteTarget } from '../src/script.ts';

const script: Script = {
  sections: [
    { id: 'sec_open', title: 'Cold open', intent: 'Why a fifth git client.', status: 'approved', lines: [{ id: 'line_a', say: 'I have built four git clients.', show: 'four-apps graphic', placed: { startFrame: 24, durationFrames: 90 } }] },
    {
      id: 'sec_graph',
      title: 'The graph',
      intent: '',
      status: 'review',
      lines: [
        { id: 'line_b', say: 'Everything starts with the graph.', show: '' },
        { id: 'line_c', say: 'Each branch is a lane.', show: 'zoom on the lanes' },
      ],
    },
  ],
  notes: [
    { id: 'note_1', on: { kind: 'line', lineId: 'line_c' }, author: 'person', text: 'Lead with the stashes.', createdAt: '2026-10-13T10:00:00Z', replies: [{ author: 'agent', text: 'Swapped the order.', createdAt: '2026-10-13T10:05:00Z' }], resolved: false },
    { id: 'note_2', on: { kind: 'frame', frame: 60 }, author: 'person', text: 'Dead air here.', createdAt: '2026-10-13T10:10:00Z', replies: [], resolved: true },
  ],
};

test('script show prints the outline with numbered lines, times and open notes', () => {
  assert.equal(
    formatScript('Git Gud', script, 30),
    [
      'Git Gud · 2 sections · 3 lines · ~0:07 · 1 open note',
      '',
      '1. Cold open  [approved]  ~0:03',
      '   Why a fifth git client.',
      '   1.1    00:00  I have built four git clients.',
      '                show: four-apps graphic',
      '',
      '2. The graph  [your turn]  ~0:04',
      '   2.1   ~00:03  Everything starts with the graph.',
      '   2.2   ~00:05  Each branch is a lane.  (1 open note)',
      '                show: zoom on the lanes',
    ].join('\n'),
  );
});

test('lines, sections, notes and moments are named the way a person reads them', () => {
  assert.equal(findLine(script, '2.2').line.id, 'line_c');
  assert.equal(findLine(script, 'line_b').number, '2.1');
  assert.equal(findNote(script, '#2').note.id, 'note_2');
  assert.deepEqual(noteTarget(script, '2', 30), { kind: 'section', sectionId: 'sec_graph' });
  assert.deepEqual(noteTarget(script, '@00:02', 30), { kind: 'frame', frame: 60 });
  assert.throws(() => findLine(script, '2.3'), /section 2 has 2/);
});

test('notes lists open threads with replies, and resolved ones only with --all', () => {
  assert.equal(formatNotes(script, 30, false), ['#1  open  on line 2.2 · "Each branch is a lane."', '    person: Lead with the stashes.', '      ↳ agent: Swapped the order.'].join('\n'));
  assert.match(formatNotes(script, 30, true), /#2  resolved  on at 00:02\n    person: Dead air here\./);
});
