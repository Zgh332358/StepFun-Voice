import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Server } from 'node:net';
import stepVoice from '../index.ts';
import { getComposerVoiceHost, COMPOSER_PROTOCOL } from '../src/composer-contract.ts';
import { NativeAudioEngine } from '../src/native-audio.mjs';
import { NativeVoiceHUD } from '../src/native-hud.mjs';

function host(t, voiceComposer) {
  t.mock.method(NativeAudioEngine.prototype, 'start', () => assert.fail('desktop must not use Swift audio'));
  t.mock.method(NativeVoiceHUD.prototype, 'show', () => assert.fail('desktop must not fall back to HUD'));
  t.mock.method(Server.prototype, 'listen', () => assert.fail('desktop must not start a local relay'));
  const pi = new EventEmitter(), commands = new Map(), notices = [];
  pi.registerCommand = (name, command) => commands.set(name, command);
  pi.exec = () => assert.fail('desktop must not launch OS helpers');
  pi.sendUserMessage = () => assert.fail('transcripts must not auto-submit through the legacy bridge');
  const ctx = { mode: 'rpc', hasUI: true, cwd: '/test', voiceComposer,
    sessionManager: { getSessionId: () => 'session-1', getSessionName: () => 'fixture' },
    isIdle: () => true, hasPendingMessages: () => false,
    ui: { select: () => assert.fail('no modal fallback'), custom: () => assert.fail('no TUI fallback'),
      notify: (message, kind) => notices.push({ message, kind }) } };
  stepVoice(pi);
  const emit = async name => { for (const handler of pi.listeners(name)) await handler({}, ctx); };
  t.after(() => emit('session_shutdown'));
  return { commands, ctx, notices, emit, run: action => commands.get('stepvoice').handler(action, ctx) };
}
function composer() {
  const registrations = [], actions = []; let closes = 0;
  const capability = { protocol: COMPOSER_PROTOCOL, surface: 'composer', registerProvider(provider, configuration) {
    registrations.push({ provider, configuration });
    return { async command(action) { actions.push(action); }, async dispose() { closes++; } };
  } };
  return { capability, registrations, actions, get closes() { return closes; } };
}

test('released desktop without composer capability only explains the blocker for every voice action', async t => {
  const h = host(t); await h.emit('session_start');
  assert.equal(h.notices.length, 0);
  for (const action of ['', 'panel', 'start', 'mute', 'interrupt', 'end', 'setup', 'status']) {
    await h.run(action);
    assert.match(h.notices.at(-1).message, /未提供输入栏语音插件接口/);
  }
  await h.run('stop');
  assert.equal(h.notices.length, 8);
});

test('legacy Voice v1 is not mistaken for an implemented composer contract', async t => {
  const h = host(t);
  h.ctx.voice = { protocolVersion: 1, registerProvider: () => assert.fail('must not install transcript provider in desktop mode') };
  await h.emit('session_start'); await h.run('');
  assert.match(h.notices[0].message, /stepvoice.composer\/1/);
});

test('capability detection rejects wrong protocol, surface and missing methods', () => {
  for (const candidate of [undefined, {}, { voiceComposer: {} }, { voiceComposer: { protocol: 'v1' } },
    { voiceComposer: { protocol: COMPOSER_PROTOCOL, surface: 'overlay', registerProvider() {} } }]) {
    assert.equal(getComposerVoiceHost(candidate), undefined);
  }
  const c = composer(); assert.equal(getComposerVoiceHost({ voiceComposer: c.capability }), c.capability);
});

test('supported composer registers once, opens without capture, and keeps every command in host UI', async t => {
  const c = composer(), h = host(t, c.capability); await h.emit('session_start');
  assert.equal(c.registrations.length, 1); assert.equal(c.actions.length, 0);
  assert.equal(c.registrations[0].provider.capabilities.inputMode, 'handoff');
  assert.equal(typeof c.registrations[0].provider.speak, 'function');
  assert.deepEqual(Object.keys(c.registrations[0].configuration).sort(), ['clear', 'save', 'snapshot']);
  for (const action of ['', 'panel', 'start', 'mute', 'interrupt', 'end', 'setup', 'status']) await h.run(action);
  assert.deepEqual(c.actions, ['open', 'open', 'start', 'mute', 'interrupt', 'end', 'setup', 'status']);
  assert.equal(c.registrations.length, 1); assert.equal(h.notices.length, 0);
  await h.emit('agent_start'); assert.equal(c.closes, 0, 'host work must not hide composer controls');
});

test('stop unregisters, a later open registers anew, shutdown retires provider', async t => {
  const c = composer(), h = host(t, c.capability); await h.run('');
  const first = c.registrations[0].provider;
  await h.run('stop'); assert.equal(c.closes, 1);
  assert.throws(() => first.createSession({}), /已关闭/);
  await h.run(''); assert.equal(c.registrations.length, 2);
  await h.emit('session_shutdown'); assert.equal(c.closes, 2);
  await h.run('start'); assert.equal(c.actions.filter(a => a === 'start').length, 0);
});

test('session identity changes cannot reuse the old composer registration', async t => {
  const c = composer(), h = host(t, c.capability); await h.run('');
  h.ctx.sessionManager.getSessionId = () => 'different-session';
  await h.run('start');
  assert.match(h.notices.at(-1).message, /旧会话/); assert.deepEqual(c.actions, ['open']);
});

test('malformed host registration fails visibly instead of falling back', async t => {
  const h = host(t, { protocol: COMPOSER_PROTOCOL, surface: 'composer', registerProvider: () => ({}) });
  await h.run(''); assert.match(h.notices[0].message, /无效注册/);
});

test('command discovery preserves existing names and help does not start services', async t => {
  const h = host(t); assert.deepEqual([...h.commands.keys()], ['stepvoice']);
  assert.deepEqual(h.commands.get('stepvoice').getArgumentCompletions('').map(item => item.value),
    ['panel', 'setup', 'start', 'mute', 'interrupt', 'end', 'stop', 'status', 'config']);
  await h.run('config'); assert.match(h.notices[0].message, /输入栏扩展协议/);
  await h.run('unknown'); assert.match(h.notices[1].message, /用法/);
});
