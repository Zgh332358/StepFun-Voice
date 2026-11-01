import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const output = join(root, '.cache/releases');
mkdirSync(output, { recursive: true });
const archive = join(output, `step-voice-${manifest.version}-macos.zip`);
if (existsSync(archive)) throw new Error('Release archive already exists; inspect it rather than overwrite it');
const stage = mkdtempSync(join(output, 'stage-'));
const destination = join(stage, 'step-voice');
mkdirSync(destination);
const copy = (source, target) => {
  const info = lstatSync(source);
  if (info.isSymbolicLink()) throw new Error(`Refusing to package a symlink: ${source}`);
  if (info.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) copy(join(source, name), join(target, name));
  } else {
    if (!info.isFile() || !/\.(?:ts|mts|mjs|js|json|md|swift|plist)$|(?:^|\/)LICENSE$/.test(source)
      || /(?:^|\/)(?:\.[^/]+|credentials\.json|auth\.json|installation\.json)$/.test(source)) {
      throw new Error(`Unexpected release file: ${source}`);
    }
    cpSync(source, target);
  }
};
for (const path of ['index.ts', 'package-lock.json', 'step.plugin.json', 'README.md', 'FORMAL_DESKTOP.md', 'HARNESS_INTEGRATION.md', 'GITHUB.md', 'LICENSE', 'src', 'native']) {
  copy(join(root, path), join(destination, path));
}
const dependency = JSON.parse(readFileSync(join(root, 'node_modules/ws/package.json'), 'utf8'));
if (dependency.name !== 'ws' || dependency.version !== manifest.dependencies.ws) throw new Error('Installed ws does not match the pinned dependency');
copy(join(root, 'node_modules/ws'), join(destination, 'node_modules/ws'));
const { scripts: _developmentScripts, ...runtimeManifest } = manifest;
writeFileSync(join(destination, 'package.json'), JSON.stringify(runtimeManifest, null, 2) + '\n');
const files = [];
function record(directory) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (lstatSync(path).isDirectory()) record(path);
    else files.push({ path: relative(destination, path), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
  }
}
record(destination);
execFileSync('zip', ['-q', '-r', archive, 'step-voice'], { cwd: stage });
const receipt = { version: manifest.version, host: 'StepCode 0.2.0.632', directory: destination, archive,
  archiveSha256: createHash('sha256').update(readFileSync(archive)).digest('hex'), files };
const receiptPath = join(output, `step-voice-${manifest.version}-manifest.json`);
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ version: manifest.version, directory: destination, archive, manifest: receiptPath, fileCount: files.length }, null, 2));
