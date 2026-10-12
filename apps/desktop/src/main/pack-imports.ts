import { posix, win32 } from 'node:path';

/**
 * Whether an import in an FX pack names a package rather than a file. Relative and absolute paths
 * are files; the bundler hands the pack's own entry to resolvers as an absolute path, which on
 * Windows starts with a drive letter (`C:\…`), not `/`.
 */
export function isBareImport(specifier: string): boolean {
  if (specifier.startsWith('.') || specifier.startsWith('data:')) return false;
  return !posix.isAbsolute(specifier) && !win32.isAbsolute(specifier);
}
