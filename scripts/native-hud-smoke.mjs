import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { NativeVoiceHUD, prepareNativeHUD } from '../src/native-hud.mjs';

if (process.platform !== 'darwin') throw new Error('Native HUD QA needs a logged-in macOS desktop.');
const root = resolve('.cache');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, 'hud-qa-'));
const binary = await prepareNativeHUD();
const { stdout } = await promisify(execFile)(binary, ['--self-test', directory], { timeout: 15000 });
const events = stdout.trim().split('\n').map(JSON.parse);
const result = events.find(event => event.type === 'selftest');
assert.equal(result?.ok, true);
assert.equal(result.frontmostUnchanged, true);
assert.equal(result.isKeyWindow, false);
assert.equal(result.clickThrough, false);
assert.equal(result.permissionRequested, false);
assert.ok(events.some(event => event.type === 'action' && event.action === 'mute'));

const errors = [];
const hud = new NativeVoiceHUD({ onError: error => errors.push(error.message) }, { binaryPath: binary, positionFile: join(directory, 'hud.json') });
try {
  await hud.show({ voice: 'stopped', muted: false, micLevel: 0, config: { keyConfigured: false }, transcripts: [] });
  const child = hud.child;
  assert.equal(child.spawnargs.includes('credentials.json'), false);
  assert.equal(child.spawnargs.includes(join(directory, 'hud.json')), true);
  await hud.close();
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'helper must exit when closed');
  assert.equal(errors.length, 0);
} finally { await hud.close(); }

// A parent disappearing closes the pipe. The helper must exit without leaving an orphan panel.
const child = spawn(binary, ['--position-file', join(directory, 'eof-hud.json')], {
  stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: directory, TMPDIR: directory, LANG: 'en_US.UTF-8' },
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('EOF did not release the native HUD')); }, 5000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`EOF exit: ${code}`)); });
  child.stdout.once('data', () => child.stdin.end());
});
const report = { ...result, checks: ['rendered collapsed/expanded/error AppKit views', 'programmatic mute action',
  'show and button action leave frontmost app unchanged', 'non-key panel with mouse interaction enabled',
  'explicit close and parent stdin EOF release helper', 'isolated position file; no audio or credentials'],
  manualChecksRemaining: ['real mouse clicks during Chinese IME composition', 'multiple displays and full-screen Spaces', 'real microphone and online voice/TTS'],
  screenshots: ['collapsed.png', 'expanded.png', 'error.png'].map(name => join(directory, name)) };
await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
