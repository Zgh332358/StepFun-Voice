import test from 'node:test';
import assert from 'node:assert/strict';
import { HarnessVoiceTransport } from '../src/harness-transport.mjs';
import { createTerminalVoiceController } from '../src/terminal-controller.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, nativeStart = async () => {}) {
  const listeners = new Set(), calls = [], engines = [], tasks = [];
  let state = { sessionId: 'agent', state: 'stopped', muted: false };
  const emit = event => { for (const listener of listeners) listener({ event, sessionId: 'agent', voiceSessionId: state.voiceSessionId }); };
  const voice = { protocolVersion: 1, snapshot: () => ({ ...state }),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async start(options) { calls.push(['start', options]); state = { ...state, voiceSessionId: options.voiceSessionId, state: 'ready', muted: options.muted ?? false }; emit({ type: 'voice.state', state: 'ready', muted: state.muted }); return state; },
    appendAudio(id, audio) { calls.push(['audio', id, audio]); },
    setMuted(id, muted) { assert.equal(id, state.voiceSessionId); state.muted = muted; emit({ type: 'voice.state', state: state.state, muted }); },
    interrupt(id) { calls.push(['interrupt', id]); emit({ type: 'audio.clear' }); },
    async stop(id) { calls.push(['stop', id]); state.state = 'stopped'; emit({ type: 'voice.state', state: 'stopped', muted: false }); },
  };
  const agent = { snapshot: () => ({ sessionId: 'agent', status: 'idle', lastResponse: '' }), subscribe: () => () => {},
    submit(text, delivery) { tasks.push({ text, delivery }); return { requestId: 'typed', queued: false }; }, cancel() { tasks.push('cancel'); } };
  const runtime = { provider: { id: 'fixture' }, publicConfig: () => ({ keyConfigured: true, setupDone: true }),
    settings: {}, sanitizeEvent: value => value, cancelSetup() {},
  };
  const transport = new HarnessVoiceTransport({ voice, runtime, agent });
  const controller = createTerminalVoiceController({ transport, audioFactory: hooks => {
    const engine = { hooks, muted: [], stops: 0, async start() { await nativeStart(); },
      setMuted(value) { this.muted.push(value); }, play() {}, clear() {}, async stop() { this.stops++; } };
    engines.push(engine); return engine;
  } });
  t.after(async () => { await controller.dispose(); await transport.dispose(); });
  return { controller, transport, voice, emit, calls, engines, tasks, listeners };
}

test('the existing controller uses the in-process host without a localhost server or early microphone start', async t => {
  const f = fixture(t);
  await f.controller.connect();
  assert.equal(f.controller.snapshot().connection, 'connected');
  assert.equal(f.engines.length, 0);
  await f.controller.start(); await tick();
  assert.equal(f.controller.snapshot().voice, 'ready');
  assert.equal(f.calls[0][0], 'start');
  f.engines[0].hooks.onAudio('AAABAA=='); await tick();
  assert.equal(f.calls.find(call => call[0] === 'audio')[2].data, 'AAABAA==');
  f.emit({ type: 'input.transcript.final', source: 'user_audio', itemId: 'one', contentIndex: 0, text: 'Already routed by the host' });
  assert.equal(f.tasks.length, 0, 'UI does not resubmit final transcripts');
  assert.equal(f.controller.snapshot().transcripts.at(-1).text, 'Already routed by the host');
  await f.controller.stop(); await tick();
  assert.equal(f.engines[0].stops, 1);
  assert.equal(f.tasks.includes('cancel'), false);
});

test('a mute choice during native startup is preserved and host-originated mute updates local capture', async t => {
  let release;
  const f = fixture(t, () => new Promise(resolve => { release = resolve; }));
  await f.controller.connect();
  const starting = f.controller.start(); await tick();
  f.controller.setMuted(true);
  release(); await starting; await tick();
  assert.equal(f.calls.find(call => call[0] === 'start')[1].muted, true);
  assert.equal(f.controller.snapshot().muted, true);
  f.engines[0].hooks.onAudio('AAABAA==');
  assert.equal(f.calls.some(call => call[0] === 'audio'), false);
  f.voice.setMuted(f.voice.snapshot().voiceSessionId, false);
  assert.equal(f.controller.snapshot().muted, false);
  f.controller.submitTask('typed input', 'steer'); await tick();
  assert.deepEqual(f.tasks, [{ text: 'typed input', delivery: 'steer' }]);
});
