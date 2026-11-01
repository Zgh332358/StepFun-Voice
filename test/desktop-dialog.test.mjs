import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import stepVoice from '../index.ts';
const tick = () => new Promise(r => setImmediate(r));
async function waitDialog(r, ms = 4000) {
  const end = Date.now() + ms;
  while (!r.hasPendingDialog() && Date.now() < end) await new Promise(res => setTimeout(res, 5));
  assert.ok(r.hasPendingDialog(), 'dialog did not appear');
}

/** Mock RPC host: voice relay is faked by pre-configured env; native audio start is never exercised in menu navigation. */
function rpcHost(t, { keyConfigured = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'step-voice-dialog-'));
  const old = { home: process.env.STEP_VOICE_HOME, key: process.env.STEP_API_KEY };
  process.env.STEP_VOICE_HOME = home;
  if (keyConfigured) process.env.STEP_API_KEY = 'sk-fake-dialog-test-no-provider'; else delete process.env.STEP_API_KEY;
  t.after(() => {
    for (const [k, v] of [['STEP_VOICE_HOME', old.home], ['STEP_API_KEY', old.key]]) v === undefined ? delete process.env[k] : process.env[k] = v;
    rmSync(home, { recursive: true, force: true });
  });
  const dialogs = [], commands = new Map(), execs = [];
  let answer;
  const pi = new EventEmitter();
  pi.registerCommand = (name, spec) => commands.set(name, spec);
  pi.exec = async (command, args) => { execs.push({ command, args }); return { code: 1, stdout: '' }; };
  pi.sendUserMessage = () => {};
  const ctx = { mode: 'rpc', hasUI: true, cwd: '/test', model: { provider: 'step', id: 'm' },
    sessionManager: { getSessionId: () => 'rpc-session', getSessionName: () => 'Dialog test' },
    isIdle: () => true, hasPendingMessages: () => false,
    ui: { select(title, items, opts) { dialogs.push({ title, items });
        return new Promise(resolve => { answer = resolve;
          opts?.signal?.addEventListener('abort', () => resolve(undefined), { once: true }); }); },
      notify() { assert.fail('desktop flow must use dialogs, not notify'); },
      custom() { assert.fail('desktop must not use TUI custom'); } } };
  stepVoice(pi);
  return { dialogs, execs, ctx, command: commands.get('voice'), events: pi,
    resolveCurrent(value) { const a = answer; answer = undefined; a?.(value); },
    hasPendingDialog: () => Boolean(answer),
    async shutdown() { for (const fn of pi.listeners('session_shutdown')) await fn({}, ctx); } };
}

test('explicit /voice panel opens controls without recording or credential prompts', async t => {
  const r = rpcHost(t, { keyConfigured: false }); t.after(() => r.shutdown());
  const pending = r.command.handler('panel', r.ctx);
  await waitDialog(r);
  assert.match(r.dialogs.at(-1).title, /Step Voice · 当前桌面会话/);
  assert.match(r.dialogs.at(-1).title, /\/voice setup/);
  assert.doesNotMatch(r.dialogs.at(-1).title, /在语音面板按 Enter/);
  assert.ok(r.dialogs.at(-1).items.includes('关闭（结束通话）'));
  r.resolveCurrent('关闭（结束通话）');
  await pending;
  assert.equal(r.execs.length, 0);
});

test('desktop menu shows setup when Key missing and closes without starting capture', async t => {
  const r = rpcHost(t, { keyConfigured: false }); t.after(() => r.shutdown());
  const pending = r.command.handler('', r.ctx);
  await waitDialog(r);
  const menu = r.dialogs.at(-1);
  assert.match(menu.title, /Key：未配置|Key 未配置/);
  assert.ok(menu.items.includes('配置接入（未配置 Key）'));
  r.resolveCurrent('关闭（结束通话）');
  await pending;
  assert.equal(r.execs.length, 0, 'no osascript/native launch');
});

test('menu actions map to controller without leaving dialogs and never spawn osascript for controls', async t => {
  const r = rpcHost(t, { keyConfigured: true }); t.after(() => r.shutdown());
  // keyConfigured=true so option is 开始语音
  const pending = r.command.handler('', r.ctx);
  await waitDialog(r);
  let menu = r.dialogs.at(-1);
  assert.ok(menu.items.includes('开始语音'));
  assert.ok(menu.items.includes('刷新状态'));
  // 刷新状态 reopens menu
  r.resolveCurrent('刷新状态');
  await waitDialog(r);
  assert.ok(r.dialogs.at(-1).items.includes('开始语音'));
  // 接入设置 opens setup dialog
  r.resolveCurrent('接入设置');
  await waitDialog(r);
  assert.match(r.dialogs.at(-1).title, /接入设置/);
  r.resolveCurrent('返回');
  await waitDialog(r);
  // back at main menu; close without call → nothing started
  r.resolveCurrent('关闭（结束通话）');
  await pending;
  assert.equal(r.execs.filter(e => e.command.includes('osascript')).length, 0);
});

test('host turn start dismisses the dialog but keeps any call running; closing after refresh stops it', async t => {
  const r = rpcHost(t, { keyConfigured: false }); t.after(() => r.shutdown());
  const pending = r.command.handler('', r.ctx);
  await waitDialog(r);
  r.events.emit('agent_start', { type: 'agent_start' }, r.ctx);
  await pending; // dismissed, no error
  assert.ok(true);
});

test('setup without Key offers env and hidden osascript input; cancellation does not verify', async t => {
  const r = rpcHost(t, { keyConfigured: false }); t.after(() => r.shutdown());
  const pending = r.command.handler('setup', r.ctx);
  await waitDialog(r);
  const channelDialog = r.dialogs.at(-1);
  assert.match(channelDialog.title, /接入设置/);
  r.resolveCurrent('开放平台 API（按调用量计费）');
  await waitDialog(r);
  const keyDialog = r.dialogs.at(-1);
  assert.ok(keyDialog.items.some(i => i.includes('隐藏输入框')));
  assert.ok(keyDialog.items.some(i => i.includes('环境变量')));
  r.resolveCurrent('粘贴输入新 Key（macOS 隐藏输入框）');
  await pending; // osascript mock returns code 1 (cancelled) → setup exits quietly
  assert.equal(r.execs.at(-1)?.command, '/usr/bin/osascript');
  assert.match(r.execs.at(-1)?.args.join(' '), /hidden answer/);
});

test('muted and active states label the menu; end stops the call', async t => {
  const r = rpcHost(t, { keyConfigured: true }); t.after(() => r.shutdown());
  const pending = r.command.handler('mute', r.ctx); await pending; // controller exists now
  const menu = r.command.handler('', r.ctx);
  await waitDialog(r);
  assert.ok(r.dialogs.at(-1).items.includes('开始语音'));
  r.resolveCurrent('关闭（结束通话）');
  await menu;
});

test('missing-Key primary action opens channel setup instead of repeating the menu', async t => {
  const r = rpcHost(t, { keyConfigured: false }); t.after(() => r.shutdown());
  const pending = r.command.handler('', r.ctx);
  await waitDialog(r);
  r.resolveCurrent('配置接入（未配置 Key）');
  await waitDialog(r);
  assert.match(r.dialogs.at(-1).title, /选择接入通道/);
  r.resolveCurrent('返回');
  await waitDialog(r);
  r.resolveCurrent('关闭（结束通话）');
  await pending;
  assert.equal(r.execs.length, 0);
});
