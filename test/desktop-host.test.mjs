import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

// Optional installed-host integration, explicitly enabled in desktop QA.
// Unlike a direct import of index.ts, this covers settings -> resource discovery
// -> actual AgentSession.prompt -> real RPC SelectionBroker. No model API/mic.
const hostRoot = process.env.STEP_CODE_HOST;
const hostTest = hostRoot ? test : test.skip;

hostTest('real desktop host dispatches /voice into an in-app dialog menu without browser or model turn', async t => {
  const coding = pathToFileURL(join(hostRoot, 'coding-agent/dist/index.js')).href;
  const { SelectionBroker, selectionSelect } = await import(pathToFileURL(join(hostRoot, 'web/dist/selection.js')).href);
  const h = await import(coding);
  const dir = await mkdtemp(join(tmpdir(), 'step-voice-real-host-'));
  const oldVoiceHome = process.env.STEP_VOICE_HOME, oldApiKey = process.env.STEP_API_KEY;
  process.env.STEP_VOICE_HOME = dir;
  delete process.env.STEP_API_KEY;
  t.after(async () => {
    if (oldVoiceHome === undefined) delete process.env.STEP_VOICE_HOME; else process.env.STEP_VOICE_HOME = oldVoiceHome;
    if (oldApiKey === undefined) delete process.env.STEP_API_KEY; else process.env.STEP_API_KEY = oldApiKey;
    await rm(dir, { recursive: true, force: true });
  });
  const cwd = resolve(process.env.STEP_VOICE_PACKAGE || fileURLToPath(new URL('..', import.meta.url)));
  const settings = h.SettingsManager.inMemory({ packages: [cwd], compaction: { enabled: false } });
  const loader = new h.DefaultResourceLoader({ cwd, agentDir: join(dir, 'agent'), settingsManager: settings,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.ok(loader.getExtensions().extensions.some(e => e.commands.has('voice')));
  const modelRuntime = await h.ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
    modelsStorePath: join(dir, 'models-store.json'), includeDefaultBuiltins: false, refreshOnCreate: false });
  const model = { provider: 'test', id: 'test', name: 'Test only', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1',
    reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
  const manager = h.SessionManager.inMemory(cwd);
  const { session } = await h.createAgentSession({ cwd, agentDir: join(dir, 'agent'), resourceLoader: loader,
    settingsManager: settings, modelRuntime, model, sessionManager: manager, noTools: 'all' });
  let selected;
  const broker = new SelectionBroker(() => manager.getSessionId(), event => {
    if (event.type === 'selection_required') selected = event.selection;
  });
  t.after(async () => {
    broker.clear();
    await session._extensionRunner.emit({ type: 'session_shutdown', reason: 'test' });
    session.dispose();
  });
  await session.bindExtensions({ mode: 'rpc', uiContext: { select: selectionSelect(broker),
    notify() { assert.fail('real RPC flow must not depend on notify'); } } });
  const countBefore = manager.getEntries().filter(e => e.type === 'message').length;
  for (const command of ['/voice', '/voice panel']) {
    selected = undefined;
    const open = session.prompt(command, { source: 'rpc' });
    for (let i = 0; i < 100 && !selected; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(selected, `AgentSession must dispatch ${command} into the real selection broker`);
    assert.match(selected.title, /Step Voice · 当前桌面会话/);
    assert.ok(selected.options.includes('配置接入（未配置 Key）'), 'menu shows setup without Key');
    assert.ok(selected.options.includes('关闭（结束通话）'));
    assert.ok(selected.options.includes('接入设置'));
    assert.doesNotMatch(selected.title + selected.options.join(), /http:\/\/|浏览器/);
    assert.equal(broker.pendingRequests().length, 1);
    broker.respond(selected.id, '关闭（结束通话）');
    await open;
    assert.equal(manager.getEntries().filter(e => e.type === 'message').length, countBefore);
    assert.equal(broker.pendingRequests().length, 0);
  }
});

hostTest('installed desktop slash-menu reproduces bare /voice skill collision; argument form bypasses it', async () => {
  const publicDir = join(hostRoot, 'web/dist/public');
  const html = await readFile(join(publicDir, 'index.html'), 'utf8');
  const asset = html.match(/src="\/([^"\s]+\.js)"/)[1];
  const bundle = await readFile(join(publicDir, asset), 'utf8');
  // Scope to the actual shipped slash matching functions, not a rewritten mock.
  const start = bundle.indexOf('function Iu(e,t){let n=e.toLowerCase()');
  const end = bundle.indexOf('var Gu=`prompt-file`', start);
  assert.ok(start >= 0 && end > start, 'host bundle changed; re-evaluate the verified 0.2.0 slash-menu contract');
  const runtime = await readFile(join(hostRoot, 'web/dist/runtime.js'), 'utf8');
  assert.match(runtime, /return webPromptCommands\(this\.session\.promptTemplates,/,
    'the desktop endpoint lists prompt templates, not registered extension commands');
  const context = vm.createContext({});
  vm.runInContext(bundle.slice(start, end), context);
  const candidates = vm.runInContext('Uu("voice",[{name:"voice-of-customer-miner",description:"review research"}],x=>x,[])', context);
  assert.equal(candidates.commands.length, 0);
  assert.equal(candidates.prompts.length, 0);
  assert.equal(candidates.skills[0].key, 'voice-of-customer-miner');
  assert.equal(vm.runInContext('Bu("/voice panel")', context), null);
  assert.equal(vm.runInContext('Bu("/voice setup")', context), null);
  assert.equal(vm.runInContext('Vu("/voice panel",12)', context), null);
  assert.match(bundle, /e===`Enter`\|\|e===`Tab`\?\(r\(c\[p\]\),!0\)/,
    'Enter selects a candidate before the editor submits its text');
});
