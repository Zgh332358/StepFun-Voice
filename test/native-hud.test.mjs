import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { NativeVoiceHUD, hudState } from '../src/native-hud.mjs';

const snapshot = (extra = {}) => ({ voice: 'ready', connection: 'connected', muted: false, speaking: false,
  micLevel: 0.4, config: { keyConfigured: true, apiKey: 'sk-never-transmit-this-key' }, transcripts: [], ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
  child.stdin.on('finish', child.kill);
  const writes = [], actions = [], errors = [];
  child.stdin.on('data', data => writes.push(...String(data).trim().split('\n').map(JSON.parse)));
  let launch;
  const hud = new NativeVoiceHUD({ onAction: action => actions.push(action), onError: error => errors.push(error) },
    { binaryPath: '/test/hud', spawnImpl: (...args) => { launch = args; return child; }, readyTimeoutMs: 50, ...options });
  const emit = event => child.stdout.write(`${JSON.stringify(event)}\n`);
  const show = async () => { const pending = hud.show(snapshot()); await tick(); emit({ type: 'ready' }); await pending; };
  return { child, hud, writes, actions, errors, emit, show, get launch() { return launch; } };
}

test('HUD sends a bounded display projection, never credentials or host internals', () => {
  const state = hudState(snapshot({ micLevel: Infinity, transcripts: [{ text: '中文字幕', role: 'user' }],
    notice: { text: 'sk-never-transmit-this-key' } }), { waitingForApproval: true, status: '等待审批', cwd: '/private', sessionId: 'private' });
  assert.equal(state.label, '等待授权'); assert.equal(state.micLevel, 0);
  assert.equal(state.caption, '你：中文字幕');
  assert.doesNotMatch(JSON.stringify(state), /never-transmit|private|apiKey|keyHint|sessionId/);
  assert.ok(hudState(snapshot({ notice: { text: 'a'.repeat(20000) } })).detail.length <= 240);
});

test('HUD renders startup, muted, playback, idle and missing-key states truthfully', () => {
  for (const [input, label] of [[{ voice: 'connecting', startupPhase: 'opening-microphone' }, '等待麦克风'],
    [{ muted: true }, '已静音'], [{ speaking: true }, '正在朗读'], [{ voice: 'error' }, '语音出错'],
    [{ voice: 'stopped' }, '准备开始']]) assert.equal(hudState(snapshot(input)).label, label);
  assert.equal(hudState(snapshot({ voice: 'stopped', config: { keyConfigured: false } })).primaryAction, 'setup');
});

test('HUD starts explicitly, strips credential environment and accepts only control actions', async () => {
  const f = fixture(); assert.equal(f.launch, undefined);
  await f.show();
  assert.deepEqual(Object.keys(f.launch[2].env).sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR']);
  assert.deepEqual(f.launch[1].slice(0, 2), ['--position-file', f.launch[1][1]]);
  assert.deepEqual(f.launch[1].slice(-2), ['--parent-pid', String(process.pid)]);
  f.emit({ type: 'action', action: 'mute' }); f.emit({ type: 'action', action: 'submit', text: 'execute' });
  assert.deepEqual(f.actions, ['mute']);
  assert.doesNotMatch(JSON.stringify(f.writes), /never-transmit/);
  await f.hud.close();
});

test('HUD coalesces meter updates and drops old actions after close', async () => {
  const f = fixture(); await f.show(); const count = f.writes.length;
  for (let i = 0; i < 50; i++) f.hud.update(snapshot({ micLevel: i / 50 }));
  assert.equal(f.writes.length, count);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(f.writes.length, count + 1);
  assert.equal(f.writes.at(-1).micLevel, 0.98);
  await f.hud.close(); f.emit({ type: 'action', action: 'start' });
  assert.deepEqual(f.actions, []); assert.equal(f.child.exitCode, 0);
});

test('close cancels compilation without spawning a late HUD', async () => {
  let finish, launches = 0;
  const hud = new NativeVoiceHUD({}, { prepareImpl: () => new Promise(resolve => { finish = resolve; }),
    spawnImpl: () => { launches++; throw new Error('late spawn'); } });
  const pending = hud.show(snapshot());
  const rejection = assert.rejects(pending, /取消/);
  await hud.close(); await rejection; finish('/test/hud'); await tick();
  assert.equal(launches, 0);
});

test('HUD can reopen after an abnormal helper exit and ignores duplicate failure events', async () => {
  const first = fixture(); await first.show();
  first.child.emit('error', new Error('exit')); first.child.emit('exit', 1);
  assert.equal(first.errors.length, 1);
  const second = fixture();
  first.hud.options.spawnImpl = (...args) => second.child;
  const pending = first.hud.show(snapshot()); await tick();
  second.emit({ type: 'ready' }); await pending;
  assert.equal(first.hud.ready, true); await first.hud.close();
});

test('HUD readiness timeout and abnormal exit are observable and release the helper', async () => {
  const f = fixture(); await assert.rejects(f.hud.show(snapshot()), /超时/);
  assert.equal(f.child.exitCode, 0);
  const g = fixture(); await g.show(); g.child.exitCode = 1; g.child.emit('exit', 1);
  assert.equal(g.errors.length, 1); await g.hud.close();
});
