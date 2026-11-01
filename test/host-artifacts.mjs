import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Resolve the advertised ESM entry, not require() conditions or an assumed dist layout. */
export function hostEntryURL(source, name, subpath = '.') {
  const directory = resolve(source, 'packages', name);
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const exported = manifest.exports?.[subpath];
  const entry = typeof exported === 'string' ? exported : exported?.import;
  if (typeof entry !== 'string' || !entry.startsWith('./')) throw new Error(`Host package ${name} has no ESM export for ${subpath}`);
  return pathToFileURL(resolve(directory, entry)).href;
}
