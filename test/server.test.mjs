import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startVoiceServer, speechSummary } from '../src/server.mjs';

const fakeKey = 'sk-test-step-voice-no-real-provider';
const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeAgent() {
  const listeners = new Set();
  const calls = [];
  let canceled = 0;
  const snapshot = { sessionId: 'test-session', cwd: '/test-project', busy: false, pending: false, waitingForApproval: false, status: 'ready', lastResponse: '' };
  return {
    calls, listeners, snapshot: () => ({ ...snapshot }),
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
  const handle = await startVoiceServer({ cwd: '/test-project', agent, env: { STEP_API_KEY: fakeKey }, providerFactory, ...options });
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
  providers[1].hooks.onEvent({ type: 'output.audio.delta', audio: 'AAA=', responseId: 'second-response' });
  const audio = await peer.wait(event => event.type === 'output.audio.delta');
  assert.equal(audio.voiceSessionId, 'second');
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
  assert.ok(providers[0].calls.some(([type]) => type === 'cancel'));
  peer.send({ type: 'agent.cancel' });
  await pause();
  assert.equal(agent.canceled, 1);
});

test('native voice tools submit to the host, retain delivery and report cancellation honestly', async (t) => {
  const { client, providers, agent } = await fixture(t);
  const peer = await client(); peer.send({ type: 'voice.start' });
  await peer.wait((event) => event.type === 'voice.state' && event.state === 'ready');
  const hooks = providers[0].hooks;
  const result = await hooks.onToolCall({ name: 'stepcode_task', arguments: { instruction: '检查项目结构', delivery: 'followUp' } });
  assert.equal(result.status, 'submitted');
  assert.deepEqual(agent.calls[0], { text: '检查项目结构', delivery: 'followUp', requestId: 'request-1', queued: false });
  assert.equal((await hooks.onToolCall({ name: 'stepcode_status' })).sessionId, 'test-session');
  assert.equal((await hooks.onToolCall({ name: 'stepcode_cancel' })).status, 'cancellation_requested');
  assert.equal(agent.canceled, 1);
});

test('settled queued instructions create one TTS result and clear every correlation', async (t) => {
  const ttsCalls = [];
  const { client, providers, agent } = await fixture(t, {
    synthesizeSpeech: async (_, text, options) => { ttsCalls.push(text); options.onAudio(Buffer.from([0, 0, 1, 0]), { sampleRate: 24000 }); },
  });
  const peer = await client(); peer.send({ type: 'voice.start' });
  await peer.wait((event) => event.type === 'voice.state' && event.state === 'ready');
  await providers[0].hooks.onToolCall({ name: 'stepcode_task', arguments: { instruction: 'first' } });
  await providers[0].hooks.onToolCall({ name: 'stepcode_task', arguments: { instruction: 'second' } });
  agent.emit({ type: 'agent.complete', requestId: 'request-2', requestIds: ['request-1', 'request-2'], text: '任务完成。' });
  await peer.wait((event) => event.type === 'output.audio.done');
  agent.emit({ type: 'agent.complete', requestId: 'request-1', text: '重复结果' });
  await pause();
  assert.deepEqual(ttsCalls, ['任务完成。']);
  assert.equal(providers[0].calls.filter(([type]) => type === 'context').length, 1);
});

test('speech onset aborts task TTS and discards late chunks without canceling the task', async (t) => {
  let ttsOptions;
  const { client, providers, agent } = await fixture(t, {
    synthesizeSpeech: async (_, text, options) => { ttsOptions = options; await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true })); },
  });
  const peer = await client(); peer.send({ type: 'voice.start' });
  await peer.wait((event) => event.type === 'voice.state' && event.state === 'ready');
  await providers[0].hooks.onToolCall({ name: 'stepcode_task', arguments: { instruction: 'task' } });
  agent.emit({ type: 'agent.complete', requestId: 'request-1', text: '完成了。' });
  await peer.wait((event) => event.source === 'tts');
  providers[0].hooks.onEvent({ type: 'speech.start' });
  assert.equal(ttsOptions.signal.aborted, true);
  ttsOptions.onAudio(Buffer.from([0, 0]), { sampleRate: 24000 });
  await pause();
  assert.equal(peer.messages.filter((event) => event.type === 'output.audio.delta').length, 0);
  assert.equal(agent.canceled, 0);
});

test('host errors and task speech redact keys and preserve failure context', async (t) => {
  let spoken;
  const { client, providers, agent } = await fixture(t, { synthesizeSpeech: async (_, text) => { spoken = text; } });
  const peer = await client(); peer.send({ type: 'voice.start' });
  await peer.wait((event) => event.type === 'voice.state' && event.state === 'ready');
  await providers[0].hooks.onToolCall({ name: 'stepcode_task', arguments: { instruction: 'task' } });
  agent.emit({ type: 'agent.error', text: `error ${fakeKey} Bearer another-secret` });
  agent.emit({ type: 'agent.complete', requestId: 'request-1', isError: true, text: `请求失败 ${fakeKey}` });
  await peer.wait((event) => event.type === 'output.audio.done');
  assert.ok(!JSON.stringify(peer.messages).includes(fakeKey));
  assert.ok(!JSON.stringify(peer.messages).includes('another-secret'));
  assert.match(spoken, /已隐藏/);
  assert.ok(providers[0].calls.some(([type, text]) => type === 'context' && text.includes('任务未成功完成或已停止')));
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

test('a task that never starts reports the terminal login or permission boundary', async (t) => {
  const { client, providers } = await fixture(t, { taskStartTimeoutMs: 10 });
  const peer = await client(); peer.send({ type: 'voice.start' });
  await peer.wait((event) => event.type === 'voice.state' && event.state === 'ready');
  await providers[0].hooks.onToolCall({ name: 'stepcode_task', arguments: { instruction: 'task' } });
  const event = await peer.wait((event) => event.code === 'agent_not_started');
  assert.match(event.message, /终端/);
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
  await assert.rejects(startVoiceServer({ agent, env: {}, port: Number(url.port) }), /EADDRINUSE/);
  assert.equal(agent.listeners.size, 0);
});

test('spoken summaries remove code and cap input to the TTS limit', () => {
  assert.equal(speechSummary('# 结果\n```js\nsecret()\n```\n[文档](https://example.com)'), '结果\n代码已展示在任务面板。\n文档');
  assert.equal(speechSummary('a'.repeat(1200)).length, 850);
});
