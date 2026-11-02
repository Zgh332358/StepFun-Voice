import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadoutService } from '../src/readout-service.mjs';
const key = 'test-readout-private-key';
const config = () => ({ apiKey: key });
const tick = () => new Promise(resolve => setImmediate(resolve));
const context = events => ({ sessionId: 'session', voiceSessionId: 'readout', generation: 1,
  signal: new AbortController().signal, emit: event => events.push(event) });

test('standalone readout emits PCM and subtitles without a realtime connection or microphone', async () => {
  const events = [], inputs = [];
  const speech = createReadoutService({ getConfig: config, summarize: async (_, text) => { inputs.push(text); return '真实任务结果'; },
    synthesize: async (_, text, { onAudio }) => { assert.equal(text, '真实任务结果'); onAudio(Buffer.from([0, 0])); } });
  assert.equal(inputs.length, 0); assert.equal(speech.active, false);
  await speech.speak(`结果 ${key}`, context(events));
  assert.doesNotMatch(inputs[0], /test-readout-private-key/);
  assert.deepEqual(events.map(e => e.type), ['output.subtitle.start', 'output.audio.delta', 'output.subtitle.end']);
  assert.equal(speech.active, false); await speech.dispose();
});

test('interruption resolves promptly even if synthesis ignores abort and fences late chunks', async () => {
  const events = []; let emitAudio;
  const speech = createReadoutService({ getConfig: config, summarize: async () => '结果',
    synthesize: (_, __, { onAudio }) => { emitAudio = onAudio; return new Promise(() => {}); } });
  const pending = speech.speak('结果', context(events));
  const rejected = assert.rejects(pending, /取消/);
  await tick(); speech.interrupt(); await rejected;
  const count = events.length; emitAudio(Buffer.from([0, 0]));
  assert.equal(events.length, count); assert.equal(events.at(-1).type, 'output.clear');
  await speech.dispose();
});

test('summary failure falls back, but synthesis failure is not reported as success', async () => {
  const events = [];
  const speech = createReadoutService({ getConfig: config, summarize: async () => { throw new Error(key); },
    synthesize: async () => { throw new Error(`failed ${key}`); } });
  await assert.rejects(speech.speak('真实结果', context(events)), error => error.message.includes('failed') && !error.message.includes(key));
  assert.equal(events[0].type, 'notice'); assert.ok(events.some(e => e.type === 'output.clear'));
  assert.doesNotMatch(JSON.stringify(events), /test-readout-private-key/);
  await speech.dispose();
});

test('pre-cancelled or empty readout never invokes the provider', async () => {
  const speech = createReadoutService({ getConfig: config, synthesize: () => assert.fail('must not synthesize') });
  const ctx = context([]); ctx.signal = AbortSignal.abort();
  await assert.rejects(speech.speak('text', ctx));
  await assert.rejects(speech.speak('', context([])));
  await speech.dispose();
});
