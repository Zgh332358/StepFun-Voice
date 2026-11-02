import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationProvider } from '../src/conversation-provider.mjs';
import { StepFunRealtimeClient } from '../src/stepfun.mjs';
import { EventEmitter } from 'node:events';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, options = {}) {
  const clients = [], events = [], tasks = [], key = 'test-conversation-private-key';
  const abort = new AbortController();
  const provider = createConversationProvider({ getConfig: () => ({ apiKey: key }),
    clientFactory(config, hooks) {
      const client = { config, hooks, responseActive: false, socket: { readyState: 3 }, contexts: [], frames: [], cancels: 0,
        async connect() { hooks.onEvent({ type: 'ready' }); }, close() { hooks.onEvent({ type: 'closed' }); },
        cancelResponse() { this.cancels++; this.responseActive = false; }, clearAudio() {},
        appendAudio(data) { this.frames.push(data); },
        sendContext(text, opts) { this.contexts.push({ text, ...opts }); } };
      clients.push(client); return client;
    }, ...options });
  const ctx = { sessionId: 'session', voiceSessionId: 'voice', generation: 1, signal: abort.signal, emit: e => events.push(e),
    requestTask: async request => { tasks.push(request); return { status: 'submitted', taskId: 'task-1' }; },
    getTaskStatus: () => ({ busy: true, status: '执行中', key }) };
  t.after(() => provider.dispose());
  return { provider, ctx, clients, events, tasks, abort, key,
    call: (callId = 'call-1', args = { instruction: '检查测试' }) => clients[0].hooks.onToolCall({ type: 'tool.call', callId, name: 'stepcode_task', arguments: args }) };
}

test('conversation construction is side-effect free; only a handoff can submit a task', async t => {
  const f = fixture(t); const s = f.provider.createSession(f.ctx);
  assert.equal(f.clients.length, 0);
  await s.start(); const client = f.clients[0];
  assert.equal(client.hooks.delegate, true);
  assert.equal(client.hooks.tools.some(t => t.function.name === 'stepcode_cancel'), false);
  client.hooks.onEvent({ type: 'input.transcript.final', text: '检查测试', itemId: 'input-1', source: 'user_audio' });
  assert.equal(f.tasks.length, 0); assert.equal(f.events.at(-1).type, 'input.transcript.final');
  const [a, b] = await Promise.all([f.call(), f.call()]);
  assert.equal(a.status, 'submitted'); assert.deepEqual(a, b); assert.equal(f.tasks.length, 1);
  assert.equal(f.tasks[0].delivery, 'followUp');
  assert.equal(f.tasks[0].sessionId, 'session');
  await s.close(); await f.call('late'); assert.equal(f.tasks.length, 1);
});

test('invalid tasks, cancel tools and extra fields never cross the host boundary', async t => {
  const f = fixture(t); await f.provider.createSession(f.ctx).start();
  assert.equal((await f.call('bad', { instruction: 'x', approval: true })).status, 'rejected');
  assert.equal((await f.clients[0].hooks.onToolCall({ callId: 'cancel', name: 'stepcode_cancel', arguments: {} })).status, 'rejected');
  assert.equal(f.tasks.length, 0);
  const status = await f.clients[0].hooks.onToolCall({ callId: 'status', name: 'stepcode_status', arguments: {} });
  assert.equal(status.busy, true); assert.doesNotMatch(JSON.stringify(status), /private-key/);
});

test('task receipts and updates are correlated, ordered, bounded and terminal', async t => {
  const f = fixture(t); const s = f.provider.createSession(f.ctx); await s.start(); await f.call();
  assert.equal(s.updateTask({ taskId: 'unknown', sequence: 1, kind: 'progress', text: 'unknown' }), false);
  s.updateTask({ taskId: 'task-1', sequence: 1, kind: 'progress', text: `正在测试 ${f.key}` });
  assert.equal(s.updateTask({ taskId: 'task-1', sequence: 1, kind: 'progress', text: 'duplicate' }), false);
  assert.equal(f.clients[0].contexts[0].respond, false);
  s.updateTask({ taskId: 'task-1', sequence: 2, kind: 'settled', text: '测试通过' });
  assert.equal(f.clients[0].contexts.at(-1).respond, true);
  assert.equal(f.clients[0].contexts.at(-1).role, 'user');
  assert.equal(s.updateTask({ taskId: 'task-1', sequence: 3, kind: 'progress', text: 'late' }), false);
  assert.doesNotMatch(JSON.stringify(f.clients[0].contexts), /test-conversation-private-key/);
});

test('only the active response can publish output, and cancelled handoffs cannot dispatch', async t => {
  const f = fixture(t); const s = f.provider.createSession(f.ctx); await s.start();
  const emit = f.clients[0].hooks.onEvent;
  emit({ type: 'response.started', responseId: 'old' });
  s.interrupt();
  emit({ type: 'response.started', responseId: 'current' });
  emit({ type: 'output.audio.delta', responseId: 'unrelated', audio: 'AAA=', sampleRate: 24000 });
  assert.equal(f.events.filter(e => e.type === 'output.audio.delta').length, 0);
  const result = await f.clients[0].hooks.onToolCall({ callId: 'stale', responseId: 'old', name: 'stepcode_task', arguments: { instruction: 'stale task' } });
  assert.equal(result.status, 'rejected'); assert.equal(f.tasks.length, 0);
  emit({ type: 'output.audio.delta', responseId: 'current', audio: 'AAA=', sampleRate: 24000 });
  assert.equal(f.events.filter(e => e.type === 'output.audio.delta').length, 1);
});

test('barge-in clears output without cancelling a task; mute stops audio admission', async t => {
  const f = fixture(t); const s = f.provider.createSession(f.ctx); await s.start(); await f.call();
  f.clients[0].hooks.onEvent({ type: 'speech.start' });
  assert.equal(f.events.at(-1).type, 'speech.start');
  assert.ok(f.events.some(e => e.type === 'output.clear'));
  s.setMuted(true); s.appendAudio({ data: 'AAA=', sampleRate: 24000, numChannels: 1 });
  assert.equal(f.clients[0].frames.length, 0);
  s.setMuted(false); s.appendAudio({ data: 'AAA=', sampleRate: 24000, numChannels: 1 });
  assert.equal(f.clients[0].frames.length, 1);
  assert.throws(() => s.appendAudio({ data: 'AAA=', sampleRate: 48000, numChannels: 1 }));
  assert.equal(f.tasks.length, 1);
});

test('an uncertain handoff is sealed, never retried, and late receipts are ignored', async t => {
  let finish, calls = 0;
  const f = fixture(t, { admissionTimeoutMs: 15 });
  f.ctx.requestTask = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const s = f.provider.createSession(f.ctx); await s.start();
  assert.equal((await f.call()).status, 'unknown');
  assert.equal((await f.call()).status, 'unknown'); assert.equal(calls, 1);
  finish({ status: 'submitted', taskId: 'late-task' }); await tick();
  assert.equal(s.updateTask({ taskId: 'late-task', sequence: 1, kind: 'settled', text: 'late' }), false);
});

test('close before the handoff microtask prevents dispatch', async t => {
  const f = fixture(t); const s = f.provider.createSession(f.ctx); await s.start();
  const task = f.call(); await s.close(); assert.equal((await task).status, 'rejected');
  assert.equal(f.tasks.length, 0);
});

test('real StepFun protocol maps audio, transcripts and tool receipts through the conversation provider', async t => {
  let socket;
  class Socket extends EventEmitter {
    readyState = 0; sent = [];
    constructor() { super(); socket = this; }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.emit('close', 1000); }
    receive(event) { this.emit('message', Buffer.from(JSON.stringify(event))); }
  }
  const f = fixture(t, { getConfig: () => ({ apiKey: 'fake-key', baseUrl: 'https://api.stepfun.com/v1', realtimeModel: 'stepaudio-3-realtime-preview' }),
    clientFactory: (config, hooks) => new StepFunRealtimeClient(config, { WebSocketImpl: Socket, ...hooks }) });
  const session = f.provider.createSession(f.ctx); const pending = session.start(); await tick();
  socket.readyState = 1; socket.emit('open'); socket.receive({ type: 'session.updated' }); await pending;
  assert.deepEqual(socket.sent[0].session.tools.map(t => t.function.name), ['stepcode_task', 'stepcode_status']);
  socket.receive({ type: 'conversation.item.input_audio_transcription.completed', transcript: '检查测试', item_id: 'input' });
  socket.receive({ type: 'response.created', response: { id: 'response-1' } });
  const call = { type: 'response.function_call_arguments.done', response_id: 'response-1', call_id: 'call-1', name: 'stepcode_task', arguments: '{"instruction":"检查测试"}' };
  socket.receive(call); socket.receive(call); await tick();
  assert.equal(f.tasks.length, 1);
  assert.equal(socket.sent.filter(e => e.item?.type === 'function_call_output').length, 1);
  socket.receive({ type: 'response.audio.delta', response_id: 'response-1', delta: 'AAA=' });
  assert.ok(f.events.some(e => e.type === 'output.audio.delta'));
  socket.receive({ type: 'input_audio_buffer.speech_started', item_id: 'next-input' });
  const count = f.events.filter(e => e.type === 'output.audio.delta').length;
  socket.receive({ type: 'response.audio.delta', response_id: 'response-1', delta: 'AAA=' });
  assert.equal(f.events.filter(e => e.type === 'output.audio.delta').length, count);
  assert.ok(socket.sent.some(e => e.type === 'response.cancel'));
  await session.close(); assert.equal(socket.readyState, 3);
});

test('conversation identity is captured and close is safe when observers reenter cleanup', async t => {
  const f = fixture(t); const s = f.provider.createSession(f.ctx);
  f.ctx.sessionId = 'new-session'; f.ctx.voiceSessionId = 'new-voice'; f.ctx.generation = 2;
  await s.start(); await f.call();
  assert.equal(f.tasks[0].sessionId, 'session'); assert.equal(s.snapshot().generation, 1);
  const emit = f.ctx.emit;
  f.ctx.emit = e => { emit(e); if (e.type === 'output.clear') void s.close(); };
  await s.close(); assert.equal(f.events.filter(e => e.type === 'output.clear').length, 1);
});

test('pending task receipt is discarded on close and accepted work is never cancelled', async t => {
  let finish;
  const f = fixture(t); f.ctx.requestTask = request => { f.tasks.push(request); return new Promise(r => { finish = r; }); };
  const s = f.provider.createSession(f.ctx); await s.start(); const call = f.call(); await tick();
  await s.close(); assert.equal((await call).status, 'unknown');
  const count = f.events.length; finish({ status: 'submitted', taskId: 'late' }); await tick();
  assert.equal(f.events.length, count); assert.equal(f.tasks.length, 1);
});

test('standalone readout does not construct a realtime client and excludes concurrent dialogue', async t => {
  const f = fixture(t, { summarize: async () => '结果', synthesize: async (_, __, { onAudio }) => onAudio(Buffer.from([0, 0])) });
  await f.provider.speak('结果', f.ctx); assert.equal(f.clients.length, 0);
  const s = f.provider.createSession(f.ctx);
  await assert.rejects(f.provider.speak('结果', f.ctx), /先结束实时对话/);
  await s.close(); await f.provider.speak('结果', f.ctx); assert.equal(f.clients.length, 0);
});

test('closing a pending startup is immediate and prevents late ready/output', async t => {
  let finish;
  const f = fixture(t, { clientFactory: (_, hooks) => ({ socket: { readyState: 3 }, close() {},
    connect() { return new Promise(resolve => { finish = () => { hooks.onEvent({ type: 'ready' }); resolve(); }; }); } }) });
  const s = f.provider.createSession(f.ctx); const start = s.start();
  const rejection = assert.rejects(start); await tick(); await s.close(); await rejection;
  const count = f.events.length; finish(); await tick(); assert.equal(f.events.length, count);
});
