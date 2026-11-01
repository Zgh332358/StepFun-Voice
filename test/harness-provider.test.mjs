import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessVoiceRuntime } from '../src/harness-provider.mjs';
import { credentialsFile } from '../src/credentials.mjs';
import { loadStepFunConfig, verifyChannelAccess } from '../src/stepfun.mjs';

function fixture(t, options = {}) {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request in an offline voice test'); });
  const home = mkdtempSync(join(tmpdir(), 'step-voice-provider-'));
  const env = { STEP_VOICE_HOME: home, STEP_API_KEY: 'fake-key-for-offline-provider-tests', ...options.env };
  const clients = [], events = [];
  const runtime = createHarnessVoiceRuntime({ ...options, env, clientFactory(config, hooks) {
    const client = { config, hooks, starts: 0, frames: [], closes: 0,
      async connect() { this.starts++; hooks.onEvent({ type: 'ready' }); },
      appendAudio(data) { this.frames.push(data); },
      close() { this.closes++; hooks.onEvent({ type: 'closed' }); },
    };
    clients.push(client);
    return client;
  } });
  const abort = new AbortController();
  t.after(async () => { try { await runtime.dispose(); } finally { rmSync(home, { recursive: true }); } });
  return { runtime, clients, events, abort, env,
    create() { return runtime.provider.createSession({ sessionId: 'agent', voiceSessionId: 'voice', signal: abort.signal, emit: event => events.push(event) }); },
  };
}

test('provider registration/configuration has no microphone or network effects and exposes no Key', async t => {
  const f = fixture(t);
  assert.equal(f.clients.length, 0);
  assert.equal(f.runtime.publicConfig().keyConfigured, true);
  assert.equal(JSON.stringify(f.runtime.publicConfig()).includes(f.env.STEP_API_KEY), false);
  const session = f.create();
  assert.equal(f.clients[0].starts, 0);
  await session.start();
  assert.equal(f.clients[0].starts, 1);
  assert.equal(f.clients[0].hooks.delegate, false, 'only host final-transcript routing can submit work');
  session.appendAudio({ data: 'AAABAA==', sampleRate: 24000, numChannels: 1 });
  assert.deepEqual(f.clients[0].frames, ['AAABAA==']);
  f.clients[0].hooks.onEvent({ type: 'input.transcript.final', itemId: 'i', contentIndex: 0, source: 'user_audio', text: '  exact instruction  ' });
  assert.equal(f.events.at(-1).text, '  exact instruction  ');
  f.clients[0].hooks.onEvent({ type: 'tool.call', name: 'stepcode_task' });
  assert.equal(f.events.length, 1);
  await session.close();
  f.clients[0].hooks.onEvent({ type: 'input.transcript.final', text: 'late' });
  assert.equal(f.events.length, 1);
});

test('readout uses the host result, emits subtitles, and exposes synthesis errors without reviving canceled output', async t => {
  const outputs = [], inputs = [];
  const f = fixture(t, { summarize: async (_config, text) => { inputs.push(text); return '真实结果摘要'; },
    synthesizeSpeech: async (_config, text, { onAudio }) => { assert.equal(text, '真实结果摘要'); onAudio(Buffer.from([0, 0])); },
  });
  const session = f.create(); await session.start();
  await session.speak('The actual host output', { signal: new AbortController().signal, emit: event => outputs.push(event) });
  assert.deepEqual(inputs, ['The actual host output']);
  assert.deepEqual(outputs.map(e => e.type), ['output.subtitle.start', 'output.audio.delta', 'output.subtitle.end']);
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(session.speak('not spoken', { signal: stopped.signal, emit: e => outputs.push(e) }));
  assert.equal(outputs.length, 3);
});

test('disposing during Key verification cancels the request and cannot save credentials afterward', async t => {
  let signal, finish;
  const f = fixture(t, { verifyAccess: (_config, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); } });
  const saving = f.runtime.saveCredentials('api', 'another-fake-key-for-offline-tests');
  await f.runtime.dispose();
  assert.equal(signal.aborted, true);
  finish({ ok: true });
  assert.equal((await saving).ok, false);
  assert.equal(existsSync(credentialsFile(f.env)), false);
});

test('changing a channel preserves the explicitly chosen region and an environment Key is not returned to UI', async t => {
  let verified;
  const f = fixture(t, { env: { STEP_VOICE_BASE_URL: 'https://api.stepfun.ai/v1' }, verifyAccess: async config => { verified = config; return { ok: true }; } });
  assert.equal((await f.runtime.saveCredentials('step_plan', '', true)).ok, true);
  assert.equal(verified.baseUrl, 'https://api.stepfun.ai/step_plan/v1');
  assert.equal(f.runtime.publicConfig().channel, 'step_plan');
  assert.equal(f.runtime.publicConfig().keySource, 'env');
  assert.equal(JSON.stringify(f.runtime.publicConfig()).includes(f.env.STEP_API_KEY), false);
});

test('a failed synthesizer rejects with credentials redacted instead of pretending the readout succeeded', async t => {
  const outputs = [];
  const f = fixture(t, { summarize: async () => 'A short summary', synthesizeSpeech: async config => { throw new Error(`denied ${config.apiKey}`); } });
  const session = f.create(); await session.start();
  await assert.rejects(session.speak('Real output', { signal: new AbortController().signal, emit: e => outputs.push(e) }),
    error => !error.message.includes(f.env.STEP_API_KEY) && error.message.includes('[redacted]'));
  assert.deepEqual(outputs.map(e => e.type), ['output.subtitle.start', 'output.subtitle.end']);
});

test('a pre-canceled access verification opens neither HTTP nor WebSocket', async () => {
  const abort = new AbortController(); abort.abort();
  let requests = 0;
  const result = await verifyChannelAccess(loadStepFunConfig({ STEP_API_KEY: 'fake-offline-verification-key' }), {
    signal: abort.signal, fetchImpl: async () => { requests++; throw new Error('must not fetch'); },
    WebSocketImpl: class { constructor() { requests++; throw new Error('must not connect'); } },
  });
  assert.equal(result.ok, false);
  assert.equal(requests, 0);
});
