import './offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { hostEntryURL } from './host-artifacts.mjs';

const source = process.env.STEP_CODE_VOICE_SOURCE;
const hostTest = source ? test : test.skip;
const guard = fileURLToPath(new URL('./offline-network.mjs', import.meta.url));

hostTest('built CLI RPC carries voice controls, real input admission, faux output and graceful shutdown', { timeout: 25_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'step-voice-rpc-'));
  mkdirSync(join(dir, 'home'));
  const fixture = join(dir, 'fixture.mjs');
  writeFileSync(fixture, `
const { registerFauxProvider, fauxAssistantMessage } = await import(${JSON.stringify(hostEntryURL(source, 'providers', './compat'))});
export default function (pi) {
  const faux = registerFauxProvider({ provider: 'voice-test', api: 'voice-test-api', models: [{ id: 'voice-test-model' }] });
  const model = faux.getModel();
  faux.setResponses([fauxAssistantMessage('RPC voice task completed')]);
  pi.registerProvider(model.provider, { baseUrl: model.baseUrl, apiKey: 'faux-key', api: faux.api, models: faux.models });
  pi.on('session_start', (_event, ctx) => ctx.voice.registerProvider({
    id: 'offline', label: 'Offline RPC voice', createSession(context) { return {
      async start() {}, async close() {},
      appendAudio() { context.emit({ type: 'input.transcript.final', itemId: 'rpc-input', contentIndex: 0, source: 'user_audio', text: 'Run an offline voice task' }); },
      async speak(text, output) { if (text !== 'RPC voice task completed') throw new Error('Wrong host result'); output.emit({ type: 'output.audio.delta', responseId: 'reply', audio: 'AAAAAA==', sampleRate: 24000 }); }
    }; }
  }));
  pi.on('session_shutdown', () => faux.unregister());
}
`);
  const child = spawn(process.execPath, ['--import', guard, resolve(source, 'apps/cli/dist/main.js'),
    '--mode', 'rpc', '--include-live-events', '--no-tools', '--no-extensions', '-e', fixture,
    '--provider', 'voice-test', '--model', 'voice-test-model', '--api-key', 'faux-key'], {
    cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: join(dir, 'home'),
      TMPDIR: tmpdir(), LANG: 'en_US.UTF-8', STEP_NO_LOCAL_LLM: '1', AWS_EC2_METADATA_DISABLED: 'true' },
  });
  const exited = once(child, 'close');
  const records = [], malformed = [], waiters = new Set();
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-3000); });
  const decoder = new StringDecoder('utf8');
  let pendingText = '';
  const consumeLine = line => {
    let record;
    try { record = JSON.parse(line); } catch { malformed.push(line); return; }
    records.push(record);
    for (const waiter of [...waiters]) if (waiter.match(record)) waiter.finish(record);
  };
  const consume = data => {
    pendingText += decoder.write(data);
    let end;
    while ((end = pendingText.indexOf('\n')) >= 0) {
      const line = pendingText.slice(0, end).replace(/\r$/, '');
      pendingText = pendingText.slice(end + 1);
      if (line) consumeLine(line);
    }
  };
  child.stdout.on('data', consume);
  child.stdout.on('end', () => { pendingText += decoder.end(); if (pendingText) consumeLine(pendingText); });
  const waitFor = match => {
    const found = records.find(match); if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`RPC event timeout: ${stderr}`)); }, 15_000);
      const waiter = { match, finish(record) { clearTimeout(timer); waiters.delete(waiter); resolve(record); },
        cancel() { clearTimeout(timer); waiters.delete(waiter); reject(new Error(`RPC exited: ${stderr}`)); } };
      waiters.add(waiter);
    });
  };
  child.on('exit', () => { for (const waiter of [...waiters]) waiter.cancel(); });
  t.after(async () => {
    for (const waiter of [...waiters]) waiter.cancel();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 1500);
    try { await exited; } finally { clearTimeout(force); child.stdout.off('data', consume); rmSync(dir, { recursive: true }); }
  });
  const request = async (id, command) => {
    child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    const response = await waitFor(record => record.type === 'response' && record.id === id);
    assert.equal(response.success, true, JSON.stringify(response));
    return response.data;
  };
  const state = await request('state', { type: 'voice_get_state' });
  assert.ok(state.providers.some(provider => provider.id === 'offline'));
  await request('start', { type: 'voice_start', providerId: 'offline', voiceSessionId: 'rpc-call' });
  await request('audio', { type: 'voice_audio', voiceSessionId: 'rpc-call', audio: { data: 'AAABAA==', sampleRate: 24000, numChannels: 1 } });
  await waitFor(record => record.type === 'voice_event' && record.event.type === 'output.audio.delta');
  const messages = await request('messages', { type: 'get_messages' });
  assert.equal(messages.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(records.filter(record => record.type === 'voice_event' && record.event.type === 'task.accepted').length, 1);
  await request('stop', { type: 'voice_stop', voiceSessionId: 'rpc-call' });
  child.stdin.end();
  const [code] = await exited;
  assert.equal(code, 0, stderr);
  assert.deepEqual(malformed, [], 'RPC stdout must remain JSONL');
});
