import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startVoiceServer, speechSummary } from '../src/server.mjs';

const fakeKey = 'sk-test-step-voice-no-real-provider';
const final = (itemId, text = '检查项目结构', contentIndex = 0) => ({ type: 'input.transcript.final', source: 'user_audio', itemId, contentIndex, text });

test('bad finals and transcription failures never execute, and failed early inputs release the queue', async (t) => {
  const { client, providers, agent } = await fixture(t);
  const peer = await client(); peer.send({ type: 'voice.start' });
  await peer.wait(event => event.type === 'voice.state' && event.state === 'ready');
  const emit = providers[0].hooks.onEvent;
  emit({ type: 'speech.start', itemId: 'failed' });
  emit(final('good'));
  emit({ type: 'input.transcript.failed', itemId: 'failed', contentIndex: 0, message: 'provider failure' });
  emit(final('empty', '  '));
  emit(final('long', 'x'.repeat(12001)));
  emit({ ...final('index'), contentIndex: undefined });
  emit({ ...final('source'), source: 'typed_text' });
  emit({ ...final('partial'), type: 'input.transcript.delta' });
  emit(final('failed', 'late corrected final'));
  assert.equal(agent.calls.length, 1);
  assert.equal(agent.calls[0].text, '检查项目结构');
  await peer.wait(event => event.code === 'transcription_error');
  emit(final(undefined));
  await peer.wait(event => event.type === 'voice.state' && event.state === 'error');
  assert.equal(providers[0].closed, true);
  assert.equal(agent.calls.length, 1);
});

test('a throwing host submission is visible and is never replayed', async (t) => {
  const { client, providers, agent } = await fixture(t);
  let attempts = 0;
  agent.submit = () => { attempts++; throw new Error('host dispatch failed'); };
  const peer = await client(); peer.send({ type: 'voice.start' });
  await peer.wait(event => event.type === 'voice.state' && event.state === 'ready');
  providers[0].hooks.onEvent(final('one'));
  providers[0].hooks.onEvent(final('one'));
  const error = await peer.wait(event => event.code === 'transcription_error');
  assert.match(error.message, /结果不确定.*未自动重试/);
  assert.equal(attempts, 1);
});

test('old provider callbacks cannot submit after restart, even with a reused item ID', async (t) => {
  const { client, providers, agent } = await fixture(t);
  const peer = await client(); peer.send({ type: 'voice.start', voiceSessionId: 'one' });
  await peer.wait(event => event.state === 'ready' && event.voiceSessionId === 'one');
  providers[0].hooks.onEvent({ type: 'speech.start', itemId: 'same' });
  peer.send({ type: 'voice.start', voiceSessionId: 'two' });
  await peer.wait(event => event.state === 'ready' && event.voiceSessionId === 'two');
  providers[0].hooks.onEvent(final('same', 'old'));
  providers[1].hooks.onEvent(final('same', 'new'));
  assert.deepEqual(agent.calls.map(call => call.text), ['new']);
});

test('pending and deduplication bounds stop the session rather than evicting replay protection', async (t) => {
  const { client, providers, agent } = await fixture(t, { maxTranscriptionItems: 2, maxPendingTranscriptions: 2 });
  const peer = await client(); peer.send({ type: 'voice.start' });
  await peer.wait(event => event.state === 'ready');
  providers[0].hooks.onEvent({ type: 'speech.start', itemId: 'one' });
  providers[0].hooks.onEvent({ type: 'speech.start', itemId: 'two' });
  providers[0].hooks.onEvent(final('three'));
  const error = await peer.wait(event => event.code === 'transcription_error');
  assert.match(error.message, /积压或会话过长/);
  providers[0].hooks.onEvent(final('one'));
  assert.equal(agent.calls.length, 0);
  assert.equal(providers[0].closed, true);
});

test('typed input shares direct submission, defaults followUp and retains explicit steer', async (t) => {
  const { client, providers, agent } = await fixture(t);
  const peer = await client();
  peer.send({ type: 'input.text', text: 'typed first' });
  peer.send({ type: 'agent.submit', text: 'typed second', delivery: 'steer' });
  await peer.wait(event => event.type === 'task.accepted' && event.instruction === 'typed second');
  assert.deepEqual(agent.calls.map(({ text, delivery }) => ({ text, delivery })), [
    { text: 'typed first', delivery: 'followUp' }, { text: 'typed second', delivery: 'steer' },
  ]);
  assert.equal(peer.messages.filter(event => event.type === 'task.accepted').every(event => event.source === 'typed_text'), true);
  assert.equal(providers.length, 0, 'typing never needs microphone or Realtime');
});
const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeAgent() {
  const listeners = new Set();
  const calls = [];
  let canceled = 0;
  const snapshot = { sessionId: 'test-session', cwd: '/test-project', busy: false, pending: false, waitingForApproval: false, status: 'ready', lastResponse: '' };
  return {
    calls, listeners, snapshot: () => ({ ...snapshot }),
    setBusy(value) { snapshot.busy = value; snapshot.pending = value; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    submit(text, delivery) { const result = { requestId: `request-${calls.length + 1}`, queued: snapshot.busy }; calls.push({ text, delivery, ...result }); return result; },
    cancel() { canceled++; },
    get canceled() { return canceled; },
    emit(event) { for (const listener of listeners) listener({ snapshot: { ...snapshot }, ...event }); },
  };
}

async function fixture(t, options = {}) {
  const agent = fakeAgent();
  const providers = [];
  const providerFactory = (config, hooks) => {
    const provider = {
      config, hooks, calls: [], closed: false,
      async connect() { hooks.onEvent({ type: 'ready', sampleRate: 24000 }); },
      close() { this.closed = true; this.calls.push(['close']); },
      appendAudio(audio) { this.calls.push(['audio', audio]); },
      cancelResponse() { this.calls.push(['cancel']); return true; },
      sendText(text) { this.calls.push(['text', text]); },
      sendContext(text, settings) { this.calls.push(['context', text, settings]); },
    };
    providers.push(provider);
    return provider;
  };
  const home = mkdtemp(joinPath(tmp(), 'step-voice-server-'));
  const env = { STEP_VOICE_HOME: home, ...(options.env ?? { STEP_API_KEY: fakeKey }) };
  const handle = await startVoiceServer({ cwd: '/test-project', agent, providerFactory, ...options, env });
  t.after(() => handle.close());
  const url = new URL(handle.url);
  const clients = [];
  async function client() {
    const messages = [];
    const ws = new WebSocket(`ws://${url.host}/ws`, ['step-voice', url.hash.slice(1)], { origin: url.origin });
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await once(ws, 'open');
    clients.push(ws);
    return {
      ws, messages, send(message) { ws.send(JSON.stringify(message)); },
      async wait(predicate) {
        const deadline = Date.now() + 2500;
        while (Date.now() < deadline) {
          const found = messages.find(predicate);
          if (found) return found;
          await pause(5);
        }
        assert.fail(`Timed out waiting for message: ${JSON.stringify(messages)}`);
      },
    };
  }
  return { handle, url, agent, providers, client };
}

test('localhost exposes only relay health and terminal guidance and never exposes an environment key', async (t) => {
  const { url, client } = await fixture(t);
  const page = await fetch(url.origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Step Voice/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(`${url.origin}/src/server.mjs`)).status, 404);
  assert.equal((await fetch(`${url.origin}/healthz`, { method: 'POST' })).status, 405);
  const peer = await client();
  const ready = await peer.wait((event) => event.type === 'server.ready');
  assert.equal(ready.config.keyConfigured, true);
  assert.equal(ready.agentConnected, true);
  assert.ok(!JSON.stringify(ready).includes(fakeKey));
  assert.equal(ready.config.apiKey, undefined);
});

test('WebSocket requires the capability and exact local Origin', async (t) => {
  const { url } = await fixture(t);
  async function denied(protocols, origin) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${url.host}/ws`, protocols, { origin });
      ws.on('unexpected-response', (_, response) => { const status = response.statusCode; response.destroy(); resolve(status); });
      ws.on('error', () => {});
      ws.on('open', () => { ws.terminate(); reject(new Error('Unauthorized socket opened')); });
    });
  }
  assert.equal(await denied(['step-voice', 'a'.repeat(43)], url.origin), 403);
  assert.equal(await denied(['step-voice', url.hash.slice(1)], 'https://untrusted.example'), 403);
  const status = await new Promise((resolve, reject) => {
    const request = http.request(`${url.origin}/ws`, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', Origin: url.origin, 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Protocol': 'é'.repeat(43) } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(status, 403);
  assert.equal((await fetch(`${url.origin}/healthz`)).status, 200);
});

test('missing key prompts configuration without opening upstream', async (t) => {
  const { client, providers } = await fixture(t, { env: {} });
  const peer = await client();
  peer.send({ type: 'voice.start' });
  const error = await peer.wait((event) => event.type === 'error');
  assert.match(error.message, /STEP_API_KEY/);
  assert.equal(providers.length, 0);
});

test('voice events carry session identity and a delayed old stop cannot stop the restarted session', async (t) => {
  const { client, providers } = await fixture(t);
  const peer = await client();
  peer.send({ type: 'voice.start', voiceSessionId: 'first' });
  await peer.wait(event => event.type === 'voice.state' && event.state === 'ready' && event.voiceSessionId === 'first');
  peer.send({ type: 'voice.stop', voiceSessionId: 'first' });
  await peer.wait(event => event.type === 'voice.state' && event.state === 'stopped' && event.voiceSessionId === 'first');
  peer.send({ type: 'voice.start', voiceSessionId: 'second' });
  await peer.wait(event => event.type === 'voice.state' && event.state === 'ready' && event.voiceSessionId === 'second');
  peer.send({ type: 'voice.stop', voiceSessionId: 'first' });
  providers[1].hooks.onEvent(final('second-input'));
  const transcript = await peer.wait(event => event.type === 'input.transcript.final');
  assert.equal(transcript.voiceSessionId, 'second');
  await pause();
  assert.equal(providers[1].closed, false);
  assert.equal(peer.messages.some(event => event.type === 'voice.state' && event.state === 'stopped' && event.voiceSessionId === 'second'), false);
  peer.send({ type: 'voice.stop', voiceSessionId: 'second' });
  await peer.wait(event => event.type === 'voice.state' && event.state === 'stopped' && event.voiceSessionId === 'second');
  assert.equal(providers[1].closed, true);
});

test('relay teardown closes an unfinished HTTP transport rather than leaving reload pending', async (t) => {
  const { handle, url } = await fixture(t);
  const socket = net.connect({ host: '127.0.0.1', port: Number(url.port) });
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.write(`GET /healthz HTTP/1.1\r\nHost: ${url.host}\r\n`);
  const closed = once(socket, 'close');
  await pause(10);
  await handle.close();
  await closed;
  assert.equal(socket.destroyed, true);
  assert.equal((await fetch(`${url.origin}/healthz`).catch(() => null)), null);
});

test('malformed HTTP request targets return 400 and leave the relay healthy', async (t) => {
  const { url } = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: url.port, path: 'http://[', headers: { Host: url.host } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(status, 400);
  assert.equal((await fetch(`${url.origin}/healthz`)).status, 200);
});

test('configuration rejects other providers and keeps a temporary key out of replies', async (t) => {
  const { client, providers } = await fixture(t, { env: {} });
  const peer = await client();
  peer.send({ type: 'config.update', config: { baseUrl: 'https://evil.example/v1', apiKey: fakeKey } });
  await peer.wait((event) => event.type === 'error');
  peer.send({ type: 'config.update', config: { apiKey: fakeKey, baseUrl: 'https://api.stepfun.com/v1' } });
  const saved = await peer.wait((event) => event.type === 'config.saved');
  assert.equal(saved.config.keyConfigured, true);
  assert.ok(!JSON.stringify(peer.messages).includes(fakeKey));
  peer.send({ type: 'voice.start' });
  await peer.wait((event) => event.type === 'voice.state' && event.state === 'ready');
  assert.equal(providers[0].config.apiKey, fakeKey);
});

test('PCM input validates frames and voice interruption leaves the coding task running', async (t) => {
  const { client, providers, agent } = await fixture(t);
  const peer = await client();
  peer.send({ type: 'voice.start' });
  await peer.wait((event) => event.type === 'voice.state' && event.state === 'ready');
  peer.send({ type: 'audio.append', audio: 'AAABAA==' });
  peer.send({ type: 'audio.append', audio: 'AA==' });
  await peer.wait((event) => event.code === 'invalid_message');
  assert.deepEqual(providers[0].calls[0], ['audio', 'AAABAA==']);
  peer.send({ type: 'voice.interrupt' });
  await peer.wait((event) => event.type === 'audio.clear');
  assert.equal(agent.canceled, 0);
  assert.equal(providers[0].calls.some(([type]) => type === 'cancel'), false);
  peer.send({ type: 'agent.cancel' });
  await pause();
  assert.equal(agent.canceled, 1);
});

test('native final submits raw text once without a tool; unexpected tools cannot run', async (t) => {
  const { client, providers, agent } = await fixture(t);
  const peer = await client(); peer.send({ type: 'voice.start' });
  await peer.wait((event) => event.type === 'voice.state' && event.state === 'ready');
  const hooks = providers[0].hooks;
  assert.equal(hooks.delegate, false);
  assert.equal(hooks.autoBargeIn, false);
  const input = final('input-1', '  检查项目结构  ');
  hooks.onEvent(input); hooks.onEvent(input);
  const accepted = await peer.wait(event => event.type === 'task.accepted');
  assert.equal(accepted.source, 'user_audio');
  assert.deepEqual(agent.calls[0], { text: input.text, delivery: 'followUp', requestId: 'request-1', queued: false });
  for (const name of ['stepcode_task', 'stepcode_status', 'stepcode_cancel']) {
    assert.deepEqual(await hooks.onToolCall({ name, arguments: { instruction: '不要执行' } }), { error: 'voice_delegation_disabled' });
  }
  assert.equal(agent.calls.length, 1);
  assert.equal(agent.canceled, 0);
});

test('real host output is forwarded; model voice replies relay without TTS or tool execution', async (t) => {
  const ttsCalls = [];
  const { client, providers, agent } = await fixture(t, { env: { STEP_API_KEY: fakeKey, STEP_VOICE_SPEAK_TASKS: '0' }, synthesizeSpeech: async (...args) => ttsCalls.push(args) });
  const peer = await client(); peer.send({ type: 'voice.start' });
  const ready = await peer.wait(event => event.type === 'server.ready');
  assert.equal(ready.settings.speakTasks, false, 'STEP_VOICE_SPEAK_TASKS=0 disables the readout');
  await peer.wait((event) => event.type === 'voice.state' && event.state === 'ready');
  providers[0].hooks.onEvent(final('first'));
  for (const type of ['response.started', 'response.done', 'tool.call']) {
    providers[0].hooks.onEvent({ type, text: '模型代答', audio: 'AAA=' });
  }
  providers[0].hooks.onEvent({ type: 'output.audio.delta', responseId: 'r1', audio: 'AAA=', sampleRate: 24000 });
  providers[0].hooks.onEvent({ type: 'output.transcript.final', responseId: 'r1', text: '模型语音说明' });
  agent.emit({ type: 'agent.text', text: '真实公开输出' });
  agent.emit({ type: 'agent.complete', requestId: 'request-1', requestIds: ['request-1'], text: '任务完成。' });
  await peer.wait((event) => event.type === 'agent.complete');
  assert.equal(peer.messages.find(event => event.type === 'agent.text').text, '真实公开输出');
  assert.deepEqual(peer.messages.filter(event => event.type === 'output.audio.delta').map(event => event.audio), ['AAA=']);
  assert.equal(peer.messages.find(event => event.type === 'output.transcript.final').text, '模型语音说明');
  assert.deepEqual(ttsCalls, []);
  assert.equal(providers[0].calls.length, 0);
  assert.equal(peer.messages.some(event => /^(response|tool)\./.test(event.type)), false);
});

test('speakTasks summarizes the host result, adapts speech speed and falls back on failure', async (t) => {
  const tts = [];
  const summarizeCalls = [];
  const { client, providers, agent } = await fixture(t, {
    synthesizeSpeech: async (config, text, { onAudio, speed } = {}) => {
      tts.push({ text, speed });
      onAudio(Buffer.from([0, 0, 0, 64, 0, 128]));
      return { audio: Buffer.alloc(6), format: 'pcm16', sampleRate: 24000 };
    },
    summarize: async (config, text) => {
      summarizeCalls.push(text);
      if (summarizeCalls.length === 3) throw new Error('summary service down');
      return text.length > 80 ? '长'.repeat(160) : '摘要完成';
    },
  });
  const peer = await client(); peer.send({ type: 'voice.start' });
  await peer.wait((event) => event.type === 'voice.state' && event.state === 'ready');
  providers[0].hooks.onEvent(final('first'));
  agent.emit({ type: 'agent.complete', requestId: 'request-1', requestIds: ['request-1'], text: '任务已完成，共修改两个文件。' });
  const frame = await peer.wait((event) => event.type === 'output.audio.delta' && String(event.responseId || '').startsWith('tts-'));
  assert.equal(frame.sampleRate, 24000);
  assert.equal(frame.audio, Buffer.from([0, 0, 0, 64, 0, 128]).toString('base64'));
  assert.deepEqual(tts[0], { text: '摘要完成', speed: 1 });
  agent.emit({ type: 'agent.complete', requestId: 'request-2', requestIds: ['request-2'], text: 'x'.repeat(1000) });
  await peer.wait((event) => event.type === 'output.audio.delta' && String(event.responseId || '').startsWith('tts-') && tts.length === 2);
  assert.equal(tts[1].text, '长'.repeat(160));
  assert.equal(tts[1].speed, 2, '超标准长度的摘要自动加速');
  agent.emit({ type: 'agent.complete', requestId: 'request-3', requestIds: ['request-3'], text: 'y'.repeat(1000) });
  await peer.wait((event) => event.type === 'output.audio.delta' && String(event.responseId || '').startsWith('tts-') && tts.length === 3);
  assert.equal(tts[2].text, '……' + 'y'.repeat(100));
  assert.equal(tts[2].speed, 1.275, '回退尾 102 字自适应提速回标准时长');
  assert.equal(peer.messages.find(event => event.type === 'notice').message.includes('自动总结不可用'), true);
  agent.emit({ type: 'agent.complete', requestId: 'request-4', isError: true, text: '失败详情' });
  assert.equal(tts.length, 3, 'isError 完成不触发朗读');
});

test('TTS readout emits subtitle.start before synthesis and subtitle.end after, mirroring the spoken text and speed', async (t) => {
  const spoken = [];
  let peer;
  const { client, agent } = await fixture(t, {
    summarize: async (config, text) => (text.length > 80 ? '长'.repeat(160) : '摘要完成'),
    synthesizeSpeech: async (config, text, { onAudio, speed } = {}) => {
      spoken.push({ text, speed });
      // subtitle.start must precede the first synthesized audio frame.
      const start = peer.messages.find((event) => event.type === 'output.subtitle.start');
      assert.ok(start, 'subtitle.start arrives before synthesis audio');
      assert.equal(start.text, text, 'subtitle mirrors the exact spoken text');
      assert.equal(start.charsPerSecond, 4.5 * speed, 'subtitle clock matches the adaptive speech speed');
      onAudio(Buffer.alloc(4800));
      return { audio: Buffer.alloc(4800), format: 'pcm16', sampleRate: 24000 };
    },
  });
  peer = await client(); peer.send({ type: 'voice.start' });
  await peer.wait((event) => event.type === 'voice.state' && event.state === 'ready');
  agent.emit({ type: 'agent.complete', requestId: 'request-1', requestIds: ['request-1'], text: '任务已完成。' });
  const end = await peer.wait((event) => event.type === 'output.subtitle.end');
  assert.equal(end.responseId, 'tts-1');
  assert.equal(peer.messages.find((event) => event.type === 'output.subtitle.start').text, '摘要完成');
  assert.equal(spoken.length, 1);
});

test('subtitle still mirrors the fallback tail when summarization fails', async (t) => {
  let peer;
  const { client, agent } = await fixture(t, {
    summarize: async () => { throw new Error('summary down'); },
    synthesizeSpeech: async (config, text, { onAudio } = {}) => {
      const start = peer.messages.find((event) => event.type === 'output.subtitle.start');
      assert.equal(start.text, text, 'subtitle mirrors the fallback text exactly');
      assert.match(start.text, /^……y{100}$/);
      onAudio(Buffer.alloc(4800));
      return { audio: Buffer.alloc(4800), format: 'pcm16', sampleRate: 24000 };
    },
  });
  peer = await client(); peer.send({ type: 'voice.start' });
  await peer.wait((event) => event.type === 'voice.state' && event.state === 'ready');
  agent.emit({ type: 'agent.complete', requestId: 'request-1', requestIds: ['request-1'], text: 'y'.repeat(1000) });
  await peer.wait((event) => event.type === 'output.subtitle.end');
});

test('ending the call while summarization is in flight never emits subtitle events for the stale session', async (t) => {
  let resolveSummary;
  const { client, agent } = await fixture(t, {
    summarize: () => new Promise((resolve) => { resolveSummary = resolve; }),
    synthesizeSpeech: async () => { throw new Error('a stale session must not synthesize'); },
  });
  const peer = await client(); peer.send({ type: 'voice.start' });
  await peer.wait((event) => event.type === 'voice.state' && event.state === 'ready');
  agent.emit({ type: 'agent.complete', requestId: 'request-1', requestIds: ['request-1'], text: '任务完成' });
  await pause(30);
  peer.send({ type: 'voice.stop' });
  await peer.wait((event) => event.type === 'voice.state' && event.state === 'stopped');
  resolveSummary('迟到');
  await pause(50);
  assert.equal(peer.messages.some((event) => event.type.startsWith('output.subtitle')), false, 'no subtitle events for a stopped session');
});

test('speech order wins over final arrival order and identical separate inputs both submit', async (t) => {
  const { client, providers, agent } = await fixture(t);
  const peer = await client(); peer.send({ type: 'voice.start' });
  await peer.wait(event => event.type === 'voice.state' && event.state === 'ready');
  const emit = providers[0].hooks.onEvent;
  for (const itemId of ['first', 'second']) {
    emit({ type: 'speech.start', itemId });
    emit({ type: 'speech.end', itemId });
    emit({ type: 'input.committed', itemId });
  }
  emit(final('second', '重复一句'));
  assert.equal(agent.calls.length, 0);
  emit(final('first', '重复一句'));
  emit(final('first', '重复一句'));
  await peer.wait(event => event.type === 'task.accepted' && event.itemId === 'second');
  assert.deepEqual(agent.calls.map(call => call.text), ['重复一句', '重复一句']);
  assert.deepEqual(peer.messages.filter(event => event.type === 'task.accepted').map(event => event.itemId), ['first', 'second']);
  assert.equal(providers[0].calls.length, 0, 'never cancel provider responses (ASR may still be pending)');
});

test('host errors redact keys and remain visible without sending result context upstream', async (t) => {
  const { client, providers, agent } = await fixture(t);
  const peer = await client(); peer.send({ type: 'voice.start' });
  await peer.wait((event) => event.type === 'voice.state' && event.state === 'ready');
  providers[0].hooks.onEvent(final('first'));
  agent.emit({ type: 'agent.error', text: `error ${fakeKey} Bearer another-secret` });
  agent.emit({ type: 'agent.complete', requestId: 'request-1', isError: true, text: `请求失败 ${fakeKey}` });
  await peer.wait((event) => event.type === 'agent.complete');
  assert.ok(!JSON.stringify(peer.messages).includes(fakeKey));
  assert.ok(!JSON.stringify(peer.messages).includes('another-secret'));
  assert.match(peer.messages.find(event => event.type === 'agent.error').text, /已隐藏/);
  assert.equal(providers[0].calls.length, 0);
});

test('stop invalidates queued starts and disconnect prevents orphan upstream connections', async (t) => {
  const providers = [];
  const { client } = await fixture(t, {
    providerFactory: (_, hooks) => {
      let finish;
      const provider = { closed: false, connect() { return new Promise((resolve) => { finish = resolve; }); }, close() { this.closed = true; finish?.(); }, cancelResponse() {} };
      providers.push(provider); return provider;
    },
  });
  const peer = await client();
  peer.send({ type: 'voice.start' }); peer.send({ type: 'voice.start' });
  await peer.wait((event) => event.type === 'voice.state' && event.state === 'connecting');
  peer.send({ type: 'voice.stop' });
  await peer.wait((event) => event.type === 'voice.state' && event.state === 'stopped');
  await pause(); assert.equal(providers.length, 1); assert.equal(providers[0].closed, true);
  peer.send({ type: 'voice.start' }); peer.send({ type: 'voice.start' });
  await pause(); peer.ws.close(); await once(peer.ws, 'close'); await pause();
  assert.equal(providers.length, 2); assert.equal(providers[1].closed, true);
});

test('provider factory failure resets state so another start is possible', async (t) => {
  let attempts = 0;
  const { client } = await fixture(t, { providerFactory: () => { attempts++; throw new Error('factory failed'); } });
  const peer = await client(); peer.send({ type: 'voice.start' });
  await peer.wait((event) => event.type === 'error');
  peer.send({ type: 'voice.start' }); await pause();
  assert.equal(attempts, 2);
});

test('missing final after speech end reports an error and releases later input without retry', async (t) => {
  const { client, providers, agent } = await fixture(t, { transcriptionTimeoutMs: 25 });
  const peer = await client(); peer.send({ type: 'voice.start' });
  await peer.wait((event) => event.type === 'voice.state' && event.state === 'ready');
  const emit = providers[0].hooks.onEvent;
  emit({ type: 'speech.start', itemId: 'missing' });
  emit({ type: 'speech.end', itemId: 'missing' });
  emit(final('later', '后续任务'));
  assert.equal(agent.calls.length, 0);
  const event = await peer.wait((event) => event.code === 'transcription_error');
  assert.match(event.message, /超时.*未提交/);
  await peer.wait(event => event.type === 'task.accepted');
  emit(final('missing', '不应迟到后执行'));
  assert.deepEqual(agent.calls.map(call => call.text), ['后续任务']);
});

test('a second panel cannot take over an active voice session', async (t) => {
  const { client, providers } = await fixture(t);
  const first = await client(); const second = await client();
  first.send({ type: 'voice.start' }); await first.wait((event) => event.type === 'voice.state' && event.state === 'ready');
  second.send({ type: 'voice.start' });
  assert.match((await second.wait((event) => event.type === 'error')).message, /已有一个/);
  assert.equal(providers.length, 1);
});

test('listen failure releases the host subscription', async (t) => {
  const { url } = await fixture(t);
  const agent = fakeAgent();
  await assert.rejects(startVoiceServer({ agent, env: { STEP_VOICE_HOME: mkdtemp(joinPath(tmp(), 'step-voice-listen-')) }, port: Number(url.port) }), /EADDRINUSE/);
  assert.equal(agent.listeners.size, 0);
});

test('spoken summaries remove code and cap input to the TTS limit', () => {
  assert.equal(speechSummary('# 结果\n```js\nsecret()\n```\n[文档](https://example.com)'), '结果\n代码已展示在任务面板。\n文档');
  assert.equal(speechSummary('a'.repeat(1200)).length, 850);
});

import { mkdtempSync as mkdtemp, statSync as statOf, readFileSync as readText, existsSync as exists } from 'node:fs';
import { tmpdir as tmp } from 'node:os';
import { join as joinPath } from 'node:path';

test('credentials.save verifies the Key on the chosen channel before saving it privately', async (t) => {
  const home = mkdtemp(joinPath(tmp(), 'step-voice-server-'));
  const checked = [];
  const verifyAccess = async (config) => { checked.push({ channel: config.channel, baseUrl: config.baseUrl, model: config.realtimeModel, key: config.apiKey }); return config.apiKey.startsWith('good') ? { ok: true } : { ok: false, reason: 'key', message: `不认这个 Key（401）：${config.apiKey}` }; };
  const { client } = await fixture(t, { env: { STEP_VOICE_HOME: home }, verifyAccess });
  const c = await client();
  const ready = await c.wait((m) => m.type === 'server.ready');
  assert.equal(ready.config.keyConfigured, false); assert.equal(ready.config.setupDone, false);

  c.send({ type: 'credentials.save', channel: 'step_plan', apiKey: 'bad-key-000000000000' });
  const invalid = await c.wait((m) => m.type === 'credentials.invalid');
  assert.match(invalid.message, /401/);
  assert.doesNotMatch(invalid.message, /bad-key-000000000000/, 'the Key is redacted from errors');
  assert.equal(exists(joinPath(home, 'credentials.json')), false);

  c.send({ type: 'credentials.save', channel: 'step_plan', apiKey: 'good-key-1111111111abcd' });
  const saved = await c.wait((m) => m.type === 'credentials.saved');
  assert.deepEqual(checked.at(-1), { channel: 'step_plan', baseUrl: 'https://api.stepfun.com/step_plan/v1', model: 'stepaudio-2.5-realtime', key: 'good-key-1111111111abcd' });
  assert.equal(saved.config.channel, 'step_plan'); assert.equal(saved.config.keySource, 'saved'); assert.equal(saved.config.keyHint, '…abcd');
  assert.equal(JSON.stringify(saved).includes('good-key-1111111111abcd'), false, 'the Key never goes back to the panel');
  const file = joinPath(home, 'credentials.json');
  assert.equal(statOf(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readText(file, 'utf8')).channel, 'step_plan');

  c.send({ type: 'credentials.clear' });
  const cleared = await c.wait((m) => m.type === 'credentials.saved' && m.cleared);
  assert.equal(cleared.config.keyConfigured, false); assert.equal(exists(file), false);
});

test('credentials.save can keep the environment Key without writing it to disk', async (t) => {
  const home = mkdtemp(joinPath(tmp(), 'step-voice-server-'));
  const { client } = await fixture(t, { env: { STEP_VOICE_HOME: home, STEP_API_KEY: 'good-env-key-22222222' }, verifyAccess: async () => ({ ok: true }) });
  const c = await client();
  await c.wait((m) => m.type === 'server.ready');
  c.send({ type: 'credentials.save', channel: 'api', apiKey: '', useEnvKey: true });
  const saved = await c.wait((m) => m.type === 'credentials.saved');
  assert.equal(saved.config.keySource, 'env'); assert.equal(saved.config.setupDone, true);
  assert.equal(JSON.parse(readText(joinPath(home, 'credentials.json'), 'utf8')).apiKey, '');
});
