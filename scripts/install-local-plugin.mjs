import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const release = JSON.parse(readFileSync(join(root, `.cache/releases/step-voice-${version}-manifest.json`), 'utf8'));
const packageRoot = join(homedir(), '.stepcode/local-packages');
const target = join(packageRoot, 'step-voice');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
if (!existsSync(target) || lstatSync(target).isSymbolicLink()) throw new Error('Expected the existing regular local plugin directory');
const previous = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
if (previous.name !== 'step-voice' || previous.version === release.version) throw new Error('Unexpected or already-current installation; inspect before replacing');
if (hash(release.archive) !== release.archiveSha256) throw new Error('Release archive checksum mismatch');
function verify(directory) {
  for (const file of release.files) {
    const path = resolve(directory, file.path);
    if (!path.startsWith(resolve(directory) + '/') || lstatSync(path).isSymbolicLink() || hash(path) !== file.sha256) {
      throw new Error(`Release file verification failed: ${file.path}`);
    }
  }
}
verify(release.directory);
const officialRoot = join(resolve(process.env.STEP_CODE_APP || '/Applications/StepCode.app'), 'Contents');
const officialFiles = ['Info.plist', 'MacOS/StepCode', 'Resources/app.asar', 'Resources/server/node_modules/@step-harness/web/dist/runtime.js'];
const officialBefore = Object.fromEntries(officialFiles.map(path => [path, hash(join(officialRoot, path))]));
const incoming = mkdtempSync(join(packageRoot, '.incoming-step-voice-'));
cpSync(release.directory, incoming, { recursive: true });
verify(incoming);
const backupRoot = join(homedir(), '.stepcode/local-package-backups');
mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
const backup = join(mkdtempSync(join(backupRoot, `step-voice-${previous.version}-`)), 'step-voice');
renameSync(target, backup);
try {
  renameSync(incoming, target);
  verify(target);
} catch (error) {
  if (existsSync(target)) renameSync(target, `${incoming}-failed`);
  renameSync(backup, target);
  throw error;
}
const officialUnchanged = officialFiles.every(path => hash(join(officialRoot, path)) === officialBefore[path]);
const receipt = { version: release.version, previousVersion: previous.version, installed: target, backup,
  archive: release.archive, archiveSha256: release.archiveSha256, verifiedFiles: release.files.length,
  officialApplicationUnchanged: officialUnchanged, configurationChanged: false,
  credentialsChanged: false, runningAppRestarted: false, requiresRestart: true };
writeFileSync(join(root, `.cache/releases/step-voice-${version}-installation.json`), JSON.stringify(receipt, null, 2));
if (!officialUnchanged) throw new Error('Official app changed during installation; investigate concurrent changes');
console.log(JSON.stringify(receipt, null, 2));
