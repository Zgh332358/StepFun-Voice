import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { NativeAudioEngine, findCsc } from '../src/native-audio.mjs';

function nativeFixture(hooks = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
  const commands = [];
  let buffer = '';
  child.stdin.on('data', (data) => {
    buffer += String(data);
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) { commands.push(JSON.parse(buffer.slice(0, newline))); buffer = buffer.slice(newline + 1); }
  });
  child.stdin.on('finish', () => { child.exitCode = 0; child.emit('exit', 0); });
  let launch;
  const audio = new NativeAudioEngine(hooks, { binaryPath: '/test/audio-helper', spawnImpl: (...args) => { launch = args; return child; }, readyTimeoutMs: 50 });
  const emit = (value) => child.stdout.write(`${JSON.stringify(value)}\n`);
  const start = async () => { const pending = audio.start(); emit({ type: 'ready' }); await pending; };
  return { audio, child, commands, emit, start, get launch() { return launch; } };
}

test('native audio starts explicitly with pipe IPC and excludes all credential environment variables', async () => {
  const fixture = nativeFixture();
  assert.equal(fixture.launch, undefined);
  await fixture.start();
  assert.deepEqual(fixture.launch[2].stdio, ['pipe', 'pipe', 'pipe']);
  assert.deepEqual(Object.keys(fixture.launch[2].env).sort(), ['SystemRoot', 'TEMP', 'TMP']);
  assert.equal(fixture.launch[2].env.STEP_API_KEY, undefined);
  assert.equal(fixture.launch[2].env.STEPFUN_API_KEY, undefined);
  await fixture.audio.stop();
});

test('native audio forwards PCM and real levels, drops capture while muted and preserves playback', async () => {
  const frames = [], levels = [], playback = [];
  const f = nativeFixture({ onAudio: (audio) => frames.push(audio), onLevel: (level) => levels.push(level), onPlayback: (active) => playback.push(active) });
  await f.start();
  f.emit({ type: 'audio', audio: 'AAABAA==' }); f.emit({ type: 'level', value: 0.25 });
  f.audio.setMuted(true); f.emit({ type: 'audio', audio: 'AgADAA==' }); f.emit({ type: 'playback', active: true });
  f.audio.play('AAABAA==', 24000);
  assert.deepEqual(frames, ['AAABAA==']); assert.ok(levels.includes(0.25)); assert.ok(levels.includes(0)); assert.deepEqual(playback, [true]);
  assert.ok(f.commands.some((event) => event.type === 'mute' && event.muted));
  assert.ok(f.commands.some((event) => event.type === 'play'));
  await f.audio.stop();
});

test('clear interrupts scheduled native playback and rejects invalid PCM before IPC', async () => {
  const f = nativeFixture(); await f.start();
  assert.throws(() => f.audio.play('AA=='), /PCM16/);
  assert.throws(() => f.audio.play('AAABAA==', 16000), /24 kHz/);
  f.audio.clear(); assert.equal(f.commands.at(-1).type, 'clear');
  await f.audio.stop();
});

test('stop during pending microphone permission cancels readiness and releases the process', async () => {
  const f = nativeFixture(); const pending = f.audio.start();
  const rejected = assert.rejects(pending, /已取消/);
  await f.audio.stop(); await rejected;
  f.emit({ type: 'ready' });
  assert.equal(f.child.exitCode, 0);
  assert.equal(f.commands.at(-1).type, 'stop');
});

test('native helper startup errors surface rather than claiming a live microphone', async () => {
  const errors = [];
  const f = nativeFixture({ onError: (error) => errors.push(error.message) });
  const pending = f.audio.start(); f.emit({ type: 'error', message: '麦克风权限未开启' });
  await assert.rejects(pending, /麦克风权限/);
  assert.deepEqual(errors, ['麦克风权限未开启']);
  await f.audio.stop();
});

test('stop settles startup during compilation without waiting for preparation or launching a late helper', async () => {
  let resolvePreparation;
  let launches = 0;
  const states = [];
  const audio = new NativeAudioEngine({ onStatus: (state) => states.push(state) }, {
    prepareImpl: () => new Promise(resolve => { resolvePreparation = resolve; }),
    spawnImpl: () => { launches++; throw new Error('late launch'); },
  });
  const pending = audio.start();
  const rejected = assert.rejects(pending, /已取消/);
  await audio.stop();
  await rejected;
  assert.deepEqual(states, ['preparing']);
  resolvePreparation('/test/audio-helper');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launches, 0);
});

test('native startup exposes audio preparation and permission stages before readiness', async () => {
  const states = [];
  const fixture = nativeFixture({ onStatus: (state) => states.push(state) });
  await fixture.start();
  assert.deepEqual(states, ['preparing', 'permission', 'ready']);
  await fixture.audio.stop();
});

test('the Windows compiler is discovered in the 64-bit .NET Framework directory first', () => {
  const expected64 = join('C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const expected32 = join('C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe');
  const seen = [];
  const csc = findCsc({ WINDIR: 'C:\\Windows' }, (candidate) => { seen.push(candidate); return candidate === expected64; });
  assert.equal(csc, expected64);
  assert.deepEqual(seen, [expected64], 'the 64-bit compiler is used without probing the 32-bit one');
  assert.equal(findCsc({ WINDIR: 'C:\\Windows' }, (candidate) => candidate === expected32), expected32, '32-bit-only .NET Framework installs still work');
  assert.equal(findCsc({ WINDIR: 'C:\\Windows' }, () => false), undefined, 'a missing .NET Framework is reported as undefined');
});

test('the Windows helper keeps the JSONL protocol and WinMM contract the controller expects', () => {
  const source = readFileSync(new URL('../native/VoiceAudio.cs', import.meta.url), 'utf8');
  for (const token of [
    'waveOutOpen', 'waveOutWrite', 'waveOutReset', 'waveInOpen', 'waveInAddBuffer', 'waveInReset',
    'Convert.ToBase64String', '--echo-cancel', 'CaptureChunkBytes = 1920', 'MaxPlaybackFrames = SampleRate * 30',
    'playback', 'notice', 'closed',
  ]) {
    assert.ok(source.includes(token), `helper source must keep: ${token}`);
  }
});
