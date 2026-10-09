/**
 * Usage errors that teach: the closest known word for a typo, and the exact usage lines from the
 * HELP text (the single source of truth, so a new command documented there is covered too).
 */

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row.push(Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = row;
  }
  return prev[b.length]!;
}

/** The candidate a typo most likely meant: a unique prefix match, or the nearest within a third of its length. */
export function closest(input: string, candidates: readonly string[]): string | undefined {
  const needle = input.toLowerCase();
  const prefixed = candidates.filter((c) => c.toLowerCase().startsWith(needle));
  if (needle.length >= 2 && prefixed.length === 1) return prefixed[0];
  let best: string | undefined;
  let bestDistance = Math.max(1, Math.floor(needle.length / 3)) + 1;
  for (const c of candidates) {
    const d = editDistance(needle, c.toLowerCase());
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}

/** Usage entries in HELP: indented lines and their `a | b` alternatives, without the trailing description. */
function helpEntries(help: string): string[] {
  return help
    .split('\n')
    .filter((line) => /^ {2}[a-z]/.test(line))
    .flatMap((line) => line.trim().split(/\s+\|\s+/))
    .map((entry) => entry.split(/\s{2,}/)[0]!.trim());
}

/** First words of the documented commands. */
export function helpCommands(help: string): string[] {
  return [...new Set(helpEntries(help).map((entry) => entry.split(' ')[0]!))].filter((word) => word !== 'neon-cli');
}

/** The HELP entries for `cmd sub` (or every entry of `cmd` when none match the subcommand). */
export function usageLines(help: string, cmd: string, sub?: string): string[] {
  const entries = helpEntries(help);
  const starts = (prefix: string) => entries.filter((e) => e === prefix || e.startsWith(`${prefix} `));
  const exact = sub ? starts(`${cmd} ${sub}`) : [];
  return exact.length ? exact : starts(cmd);
}
