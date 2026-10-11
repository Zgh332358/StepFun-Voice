import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { NativeAudioEngine } from '../src/native-audio.mjs';

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
  assert.deepEqual(Object.keys(fixture.launch[2].env).sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR']);
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
