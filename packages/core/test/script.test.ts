import { test } from 'node:test';
import * as Y from 'yjs';
import assert from 'node:assert/strict';
import { ProjectDoc } from '../src/doc.ts';
import { ProjectSchema } from '../src/schemas.ts';
import { cueStateAt, speakingSeconds, cueIsTight, lineTimings, scriptCues } from '../src/script.ts';

const fresh = () => {
  const doc = new ProjectDoc();
  doc.ensureInitialized({ name: 'script test' });
  return doc;
};
const placed = (startFrame: number, durationFrames: number) => ({ startFrame, durationFrames });
/** The script as [section title, [say, show, placement?][]] for literal comparison. */
const outline = (doc: ProjectDoc) =>
  doc.getScript().sections.map((s) => [s.title, s.lines.map((l) => (l.placed ? [l.say, l.show, l.placed.startFrame, l.placed.durationFrames] : [l.say, l.show]))]);

test('a script is planned in sections of lines, edited and reordered in place', () => {
  const doc = fresh();
  doc.setScript([
    { title: 'Cold open', lines: [{ say: 'I have built four git clients.', show: 'four-apps graphic' }] },
    { title: 'The graph', status: 'review', lines: [{ say: 'Everything starts with the graph.' }, { say: 'Each branch is a lane.' }] },
  ]);
  const [open, graph] = doc.getScript().sections;
  assert.equal(graph!.status, 'review');
  const lane = graph!.lines[1]!;
  doc.updateLine(lane.id, { say: 'Each branch gets a lane.', show: 'zoom on the lanes' });
  doc.addLine({ sectionId: graph!.id, say: 'Stashes hang off their commit.', after: null });
  doc.moveLine(lane.id, { sectionId: open!.id, after: open!.lines[0]!.id });
  doc.updateSection(graph!.id, { status: 'approved' });
  assert.deepEqual(outline(doc), [
    ['Cold open', [['I have built four git clients.', 'four-apps graphic'], ['Each branch gets a lane.', 'zoom on the lanes']]],
    ['The graph', [['Stashes hang off their commit.', ''], ['Everything starts with the graph.', '']]],
  ]);
  assert.equal(doc.getScript().sections[1]!.status, 'approved');
  doc.removeSection(open!.id);
  assert.deepEqual(outline(doc), [['The graph', [['Stashes hang off their commit.', ''], ['Everything starts with the graph.', '']]]]);
});

test('placed lines are the prompter cues, in timeline order', () => {
  const doc = fresh();
  doc.setScript([{ title: 'Recorded', lines: [{ say: 'Second.', placed: placed(300, 90) }, { say: 'Planned only.' }, { say: 'First.', placed: placed(0, 120) }] }]);
  assert.deepEqual(scriptCues(doc.getScript()).map((c) => [c.startFrame, c.durationFrames, c.text]), [[0, 120, 'First.'], [300, 90, 'Second.']]);
});

test('a ripple cut across the timeline trims, shifts and unplaces lines, and moves frame notes', () => {
  const doc = fresh();
  doc.setScript([
    {
      title: 'Recorded',
      lines: [
        { say: 'before', placed: placed(0, 100) },
        { say: 'overlaps the cut start', placed: placed(100, 100) },
        { say: 'inside', placed: placed(210, 30) },
        { say: 'overlaps the cut end', placed: placed(260, 100) },
        { say: 'after', placed: placed(400, 50) },
      ],
    },
  ]);
  doc.addNote({ on: { kind: 'frame', frame: 220 }, text: 'in the cut', author: 'person' });
  doc.addNote({ on: { kind: 'frame', frame: 420 }, text: 'after the cut', author: 'person' });
  doc.cutRanges([{ start: 150, end: 300 }]);
  assert.deepEqual(outline(doc), [
    [
      'Recorded',
      [
        ['before', '', 0, 100],
        ['overlaps the cut start', '', 100, 50],
        ['inside', ''],
        ['overlaps the cut end', '', 150, 60],
        ['after', '', 250, 50],
      ],
    ],
  ]);
  assert.deepEqual(doc.getScript().notes.map((n) => n.on), [{ kind: 'frame', frame: 150 }, { kind: 'frame', frame: 270 }]);
});

test('a cut limited to some tracks leaves the script alone', () => {
  const doc = fresh();
  doc.setScript([{ title: 'Recorded', lines: [{ say: 'after', placed: placed(400, 50) }] }]);
  const v1 = doc.toJSON().tracks[0]!.id;
  doc.cutRanges([{ start: 150, end: 300 }], { trackIds: [v1] });
  assert.deepEqual(outline(doc), [['Recorded', [['after', '', 400, 50]]]]);
});

test('notes thread between the person and the agent and survive a rewrite of the script', () => {
  const doc = fresh();
  doc.setScript([{ title: 'The graph', lines: [{ say: 'Each branch is a lane.' }] }]);
  const line = doc.getScript().sections[0]!.lines[0]!;
  const note = doc.addNote({ on: { kind: 'line', lineId: line.id }, text: 'Too slow. Lead with the stashes.', author: 'person' });
  doc.replyToNote(note.id, { text: 'Swapped the order.', author: 'agent' });
  doc.setNoteResolved(note.id, true);
  doc.setScript([{ id: doc.getScript().sections[0]!.id, title: 'The graph', lines: [{ id: line.id, say: 'Stashes first.' }] }]);
  const [kept] = doc.getScript().notes;
  assert.deepEqual([kept!.on, kept!.text, kept!.replies.map((r) => [r.author, r.text]), kept!.resolved], [{ kind: 'line', lineId: line.id }, 'Too slow. Lead with the stashes.', [['agent', 'Swapped the order.']], true]);
});

test('planned lines get a running time estimate; placed ones keep their place', () => {
  const doc = fresh();
  doc.setScript([{ title: 'A', lines: [{ say: 'one two three' }, { say: 'four five six seven eight nine' }, { say: 'placed', placed: placed(600, 60) }, { say: 'ten' }] }]);
  const lines = doc.getScript().sections[0]!.lines;
  const t = lineTimings(doc.getScript(), 30);
  // 3 words = 1 s + 0.45 s gap = 44 frames (rounded); 6 words = 2.45 s = 74 frames.
  assert.deepEqual(lines.map((l) => [t.get(l.id)!.startFrame, t.get(l.id)!.estimated]), [[0, true], [44, true], [600, false], [660, true]]);
});

test('projects from before the script load with an empty one', () => {
  const json = fresh().toJSON() as unknown as Record<string, unknown>;
  delete json.script;
  assert.deepEqual(ProjectSchema.parse(json).script, { sections: [], notes: [] });
});

test('a Neon 0.10 project with bare cues loads them as a recorded section', () => {
  const json = fresh().toJSON() as unknown as Record<string, unknown>;
  delete json.script;
  json.cues = [{ id: 'cue_b', startFrame: 90, durationFrames: 60, text: 'Second.' }, { id: 'cue_a', startFrame: 0, durationFrames: 90, text: 'First.' }];
  const doc = ProjectDoc.fromJSON(ProjectSchema.parse(json));
  assert.deepEqual(outline(doc), [['Script', [['First.', '', 0, 90], ['Second.', '', 90, 60]]]]);
});

test('a Neon 0.10 document with a cues map migrates once', () => {
  const doc = fresh();
  doc.doc.getMap('cues').set('cue_a', new Y.Map(Object.entries({ id: 'cue_a', startFrame: 30, durationFrames: 60, text: 'Hello.' })));
  assert.equal(doc.migrateLegacyCues(), true);
  assert.equal(doc.migrateLegacyCues(), false);
  assert.deepEqual(outline(doc), [['Script', [['Hello.', '', 30, 60]]]]);
});

test('cueStateAt finds the line being said and the one coming up', () => {
  const cues = [
    { id: 'a', startFrame: 30, durationFrames: 60, text: 'a' },
    { id: 'b', startFrame: 120, durationFrames: 60, text: 'b' },
  ];
  assert.deepEqual(cueStateAt(cues, 0), { current: -1, next: 0, framesToNext: 30 });
  assert.deepEqual(cueStateAt(cues, 45), { current: 0, next: 1, framesToNext: 75 });
  assert.deepEqual(cueStateAt(cues, 100), { current: -1, next: 1, framesToNext: 20 });
  assert.deepEqual(cueStateAt(cues, 500), { current: -1, next: -1, framesToNext: null });
});

test('a line is tight when it takes longer to say than its slot', () => {
  assert.equal(speakingSeconds('one two three four five six'), 2);
  assert.equal(cueIsTight({ id: 'x', startFrame: 0, durationFrames: 45, text: 'one two three four five six' }, 30), true);
  assert.equal(cueIsTight({ id: 'x', startFrame: 0, durationFrames: 75, text: 'one two three four five six' }, 30), false);
});
