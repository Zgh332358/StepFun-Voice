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

hostTest('real desktop host reports the missing composer capability without a dialog or model turn', async t => {
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
  assert.ok(loader.getExtensions().extensions.some(e => e.commands.has('stepvoice')));
  assert.ok(loader.getExtensions().extensions.every(e => !e.commands.has('voice')));
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
  const notices = [];
  await session.bindExtensions({ mode: 'rpc', uiContext: { select: selectionSelect(broker),
    notify(message) { notices.push(message); } } });
  const countBefore = manager.getEntries().filter(e => e.type === 'message').length;
  for (const command of ['/stepvoice', '/stepvoice panel', '/stepvoice setup', '/stepvoice start']) {
    selected = undefined;
    await session.prompt(command, { source: 'rpc' });
    assert.equal(selected, undefined, `${command} must not open a blocking host dialog`);
    assert.equal(manager.getEntries().filter(e => e.type === 'message').length, countBefore);
    assert.equal(broker.pendingRequests().length, 0);
    assert.match(notices.at(-1), /未提供输入栏语音插件接口/);
  }
  await session.prompt('/stepvoice stop', { source: 'rpc' });
});

hostTest('bare /stepvoice avoids the old voice skill collision in the installed desktop menu', async () => {
  const publicDir = join(hostRoot, 'web/dist/public');
  const html = await readFile(join(publicDir, 'index.html'), 'utf8');
  const asset = html.match(/src="\/([^"\s]+\.js)"/)[1];
  const bundle = await readFile(join(publicDir, asset), 'utf8');
  // Scope to the actual shipped slash matching functions, not a rewritten mock.
  const start = bundle.search(/function [\w$]+\(e,t\)\{let n=e\.toLowerCase\(\),r=t\.toLowerCase\(\)/);
  const boundary = start < 0 ? -1 : bundle.slice(start).search(/var [\w$]+=`prompt-file`/);
  assert.ok(start >= 0 && boundary > 0, 'host slash-menu structure changed; inspect its current contract');
  const section = bundle.slice(start, start + boundary);
  const candidatesName = /function ([\w$]+)\(e,t,n,r=\[\]\)/.exec(section)?.[1];
  const queryName = /function ([\w$]+)\(e\)\{let t=[^;]+;return t\?t\[1\]:null\}/.exec(section)?.[1];
  const caretName = /function ([\w$]+)\(e,t\)\{if\(t<0\|\|t>e\.length\)return null/.exec(section)?.[1];
  assert.ok(candidatesName && queryName && caretName, 'expected the shipped candidate and query functions');
  const runtime = await readFile(join(hostRoot, 'web/dist/runtime.js'), 'utf8');
  assert.match(runtime, /return webPromptCommands\(this\.session\.promptTemplates,/,
    'the desktop endpoint lists prompt templates, not registered extension commands');
  const context = vm.createContext({});
  vm.runInContext(section, context, { timeout: 1000 });
  const candidatesFor = query => vm.runInContext(`${candidatesName}(${JSON.stringify(query)},[{name:"voice-of-customer-miner",description:"review research"}],x=>x,[])`, context, { timeout: 1000 });
  const call = (name, ...args) => vm.runInContext(`${name}(...${JSON.stringify(args)})`, context, { timeout: 1000 });
  const candidates = candidatesFor('voice');
  assert.equal(candidates.commands.length, 0);
  assert.equal(candidates.prompts.length, 0);
  assert.equal(candidates.skills[0].key, 'voice-of-customer-miner');
  const renamed = candidatesFor('stepvoice');
  assert.equal(renamed.commands.length + renamed.prompts.length + renamed.skills.length, 0,
    'bare /stepvoice must not select Voice Of Customer Miner');
  assert.equal(call(queryName, '/stepvoice'), 'stepvoice');
  assert.equal(call(queryName, '/stepvoice panel'), null);
  assert.equal(call(queryName, '/stepvoice setup'), null);
  assert.equal(call(caretName, '/stepvoice panel', 16), null);
  assert.match(bundle, /e===`Enter`\|\|e===`Tab`\?\([\w$]+\([\w$]+\[[\w$]+\]\),!0\)/,
    'Enter selects a candidate before the editor submits its text');
});
