import './offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostEntryURL } from './host-artifacts.mjs';
import { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarnessVoiceRuntime } from '../src/harness-provider.mjs';
import { HarnessVoiceTransport } from '../src/harness-transport.mjs';
import { StepFunRealtimeClient } from '../src/stepfun.mjs';
import { createTerminalVoiceController } from '../src/terminal-controller.ts';
import { NativeAudioEngine } from '../src/native-audio.mjs';

// Explicit artifact integration: this must point to the patched, locally built source checkout.
const source = process.env.STEP_CODE_VOICE_SOURCE;
const hostTest = source ? test : test.skip;
const plugin = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function host(t, loadPlugin = false) {
  const sdk = await import(hostEntryURL(source, 'coding-agent'));
  const providers = await import(hostEntryURL(source, 'providers', './compat'));
  const dir = mkdtempSync(join(tmpdir(), 'step-voice-host-'));
  const previous = Object.fromEntries(['STEP_VOICE_HOME', 'STEP_API_KEY', 'STEPFUN_API_KEY'].map(key => [key, process.env[key]]));
  let session, faux;
  t.after(async () => {
    try {
      await session?.shutdownVoice();
      await session?.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    } finally {
      session?.dispose(); faux?.unregister();
      for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
      rmSync(dir, { recursive: true });
    }
  });
  process.env.STEP_VOICE_HOME = dir;
  process.env.STEP_API_KEY = 'fake-only-key-for-host-integration';
  delete process.env.STEPFUN_API_KEY;
  faux = providers.registerFauxProvider();
  const model = faux.getModel();
  const authPath = join(dir, 'auth.json');
  writeFileSync(authPath, JSON.stringify({ [model.provider]: { type: 'api_key', key: 'faux-key' } }), { mode: 0o600 });
  const modelRuntime = await sdk.ModelRuntime.create({ authPath, modelsPath: null, includeDefaultBuiltins: false, refreshOnCreate: false });
  modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, apiKey: 'faux-key', api: faux.api, models: faux.models });
  const settings = sdk.SettingsManager.inMemory({ packages: loadPlugin ? [plugin] : [], compaction: { enabled: false } });
  const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager: settings,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await sdk.createAgentSession({ cwd: dir, agentDir: join(dir, 'agent'), model, modelRuntime,
    resourceLoader: loader, settingsManager: settings, sessionManager: sdk.SessionManager.inMemory(dir), noTools: 'all' }));
  assert.equal(session.voice?.protocolVersion, 1, 'Build the patched host before running this integration');
  return { sdk, providers, session, faux, dir };
}

hostTest('real extension loader registers the host provider and /stepvoice uses no legacy relay or microphone', async t => {
  t.mock.method(NativeAudioEngine.prototype, 'start', () => { throw new Error('Menus must not open a microphone'); });
  t.mock.method(Server.prototype, 'listen', () => { throw new Error('The new host must not start the legacy relay'); });
  const h = await host(t, true);
  const dialogs = [];
  await h.session.bindExtensions({ mode: 'rpc', uiContext: {
    async select(title, options) { dialogs.push({ title, options }); return options.includes('关闭（结束通话）') ? '关闭（结束通话）' : undefined; },
    notify() { assert.fail('RPC voice controls should use the existing dialog adapter'); },
  } });
  assert.ok(h.session.voice.snapshot().providers.some(provider => provider.id === 'stepfun'));
  await h.session.prompt('/stepvoice', { source: 'rpc' });
  assert.match(dialogs[0]?.title ?? '', /Step Voice · 当前桌面会话/);
  assert.equal(h.session.voice.snapshot().state, 'stopped');
  assert.equal(h.faux.state.callCount, 0);
  assert.equal(h.session.messages.filter(message => message.role === 'user').length, 0);
});

function nextVoiceEvent(t, voice, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('Expected host voice event did not arrive')); }, 4000);
    const off = voice.subscribe(frame => {
      if (predicate(frame.event)) { clearTimeout(timer); off(); resolve(frame.event); }
    });
    t.after(() => { clearTimeout(timer); off(); });
  });
}

hostTest('real controller, StepFun protocol adapter, host routing, faux agent and readout execute exactly once', async t => {
  const h = await host(t);
  h.faux.setResponses([h.providers.fauxAssistantMessage('Offline task completed')]);
  const sockets = [], frames = [], readouts = [], voiceEvents = [];
  h.session.voice.subscribe(frame => voiceEvents.push(frame.event));
  class FakeWebSocket extends EventEmitter {
    readyState = 0;
    bufferedAmount = 0;
    sent = [];
    constructor() {
      super(); sockets.push(this);
      queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.emit('open'); } });
    }
    receive(event) { if (this.readyState === 1) this.emit('message', Buffer.from(JSON.stringify(event))); }
    send(data) {
      const event = JSON.parse(data); this.sent.push(event);
      if (event.type === 'session.update') queueMicrotask(() => this.receive({ type: 'session.updated', session: { id: 'upstream' } }));
      if (event.type === 'input_audio_buffer.append') {
        this.receive({ type: 'input_audio_buffer.speech_started', item_id: 'input-one' });
        const final = { type: 'conversation.item.input_audio_transcription.completed', item_id: 'input-one', content_index: 0, transcript: 'Inspect only; do not edit.' };
        this.receive(final); this.receive(final);
      }
    }
    close() { this.readyState = 3; this.emit('close', 1000); }
    terminate() { this.close(); }
  }
  const runtime = createHarnessVoiceRuntime({ env: { STEP_VOICE_HOME: h.dir, STEP_API_KEY: 'fake-provider-key-no-network' },
    clientFactory: (config, hooks) => new StepFunRealtimeClient(config, { ...hooks, WebSocketImpl: FakeWebSocket }),
    summarize: async (_config, text) => { readouts.push(text); return '任务已完成'; },
    synthesizeSpeech: async (_config, _text, { onAudio }) => onAudio(Buffer.from([0, 0, 0, 0])),
  });
  h.session.voice.registerProvider(runtime.provider);
  let capture;
  const transport = new HarnessVoiceTransport({ voice: h.session.voice, runtime, agent: {
    snapshot: () => ({ sessionId: h.session.sessionId, cwd: h.dir, status: 'test', lastResponse: '', busy: !h.session.isIdle, pending: false, waitingForApproval: false }),
    subscribe: () => () => {},
    submit() { assert.fail('Native finals must not be submitted a second time by the UI'); },
    cancel() { assert.fail('Ending voice must not cancel the coding task'); },
  } });
  const controller = createTerminalVoiceController({ transport, audioFactory: hooks => {
    capture = hooks;
    return { async start() {}, setMuted() {}, play(audio) { frames.push(audio); hooks.onPlayback(true); },
      clear() { hooks.onPlayback(false); }, async stop() { hooks.onPlayback(false); } };
  } });
  t.after(async () => { await controller.dispose(); await transport.dispose(); await runtime.dispose(); });
  await controller.connect();
  const ready = nextVoiceEvent(t, h.session.voice, event => event.type === 'voice.state' && event.state === 'ready');
  await controller.start(); await ready;
  const audio = nextVoiceEvent(t, h.session.voice, event => event.type === 'output.audio.delta');
  capture.onAudio('AAABAA==');
  await audio; await h.session.waitForIdle();
  assert.equal(h.session.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(voiceEvents.filter(event => event.type === 'task.accepted').length, 1);
  assert.equal(voiceEvents.filter(event => event.type === 'task.started').length, 1);
  assert.deepEqual(readouts, ['Offline task completed']);
  assert.equal(frames.length, 1);
  assert.deepEqual(sockets[0].sent[0].session.tools, []);
  await controller.stop();
  assert.equal(sockets[0].readyState, 3);
});
