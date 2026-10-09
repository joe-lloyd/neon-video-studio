import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closest, helpCommands, usageLines } from '../src/usage.ts';

const HELP = `neon-cli

USAGE
  neon-cli <command> [subcommand] [options]

COMMANDS
  status                                  App status
  timeline insert --component NAME [--at T]
      placement: --ripple = insert edit
  timeline move <clip> --at T  |  timeline move <clip...> --by T    (several clips)
  room host [--password P] | room join <code> | room leave
  preview play|pause|toggle|seek <T>      Drive the preview

GLOBAL OPTIONS
  --json                Machine-readable output
`;

test('closest picks the likely meant word or nothing', () => {
  assert.equal(closest('tiemline', ['timeline', 'tracks', 'status']), 'timeline');
  assert.equal(closest('inser', ['insert', 'update', 'move']), 'insert');
  assert.equal(closest('clip', ['clips', 'tracks', 'assets']), 'clips');
  assert.equal(closest('--prop', ['--props', '--at', '--asset']), '--props');
  assert.equal(closest('xyz', ['insert', 'update']), undefined);
});

test('usageLines quotes the HELP entries for a subcommand, without descriptions', () => {
  assert.deepEqual(usageLines(HELP, 'timeline', 'move'), ['timeline move <clip> --at T', 'timeline move <clip...> --by T']);
  assert.deepEqual(usageLines(HELP, 'room', 'join'), ['room join <code>']);
  assert.deepEqual(usageLines(HELP, 'preview', 'seek'), ['preview play|pause|toggle|seek <T>']);
  assert.deepEqual(usageLines(HELP, 'status'), ['status']);
  assert.deepEqual(usageLines(HELP, 'nope'), []);
});

test('helpCommands lists the documented commands', () => {
  assert.deepEqual(helpCommands(HELP), ['status', 'timeline', 'room', 'preview']);
});
