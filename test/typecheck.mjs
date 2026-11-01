import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = process.env.STEP_CODE_VOICE_SOURCE;
if (!source) throw new Error('Set STEP_CODE_VOICE_SOURCE to the patched, built Step-Code checkout');
const host = resolve(source);
const plugin = resolve(fileURLToPath(new URL('..', import.meta.url)));
const declaration = name => {
  const root = join(host, 'packages', name);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const entry = manifest.exports?.['.']?.types ?? manifest.types;
  if (typeof entry !== 'string') throw new Error(`Host package ${name} has no declared public types`);
  return resolve(root, entry);
};
const directory = mkdtempSync(join(tmpdir(), 'step-voice-typecheck-'));
try {
  const config = { compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    noEmit: true, allowImportingTsExtensions: true, skipLibCheck: true, types: ['node'],
    typeRoots: [join(host, 'node_modules/@types')], paths: {
      '@step-harness/coding-agent': [declaration('coding-agent')],
      '@step-harness/pi-tui': [declaration('tui')],
    },
  }, files: ['index.ts', 'src/terminal-controller.ts', 'src/harness-provider.d.mts', 'src/harness-transport.d.mts'].map(path => join(plugin, path)) };
  const path = join(directory, 'tsconfig.json');
  writeFileSync(path, JSON.stringify(config));
  const result = spawnSync(join(host, 'node_modules/.bin/tsgo'), ['-p', path], { cwd: plugin, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { rmSync(directory, { recursive: true }); }
