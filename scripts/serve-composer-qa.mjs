// Isolated manual/browser QA of the shipped Web client, not the real user's session.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(join(root, '.cache'), { recursive: true });
const profile = mkdtempSync(join(root, '.cache/composer-web-qa-'));
const home = join(profile, 'home'), workspace = join(profile, 'workspace');
for (const dir of [home, workspace, join(home, '.stepcode/agent'), join(profile, 'tmp')]) mkdirSync(dir, { recursive: true });
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const env = { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: home, TMPDIR: join(profile, 'tmp'),
  STEP_CODING_AGENT_DIR: join(home, '.stepcode/agent'), STEPCODE_STORAGE_ROOT_DIR: join(home, '.stepcode'),
  STEP_VOICE_HOME: join(home, '.stepcode/step-voice'), STEPCODE_WEB_CWD: workspace, STEPCODE_WEB_PORT: String(port),
  STEPCODE_WEB_OPEN: '0', STEP_NO_LOCAL_LLM: '1', AWS_EC2_METADATA_DISABLED: 'true' };
writeFileSync(join(home, '.stepcode/models.json'), JSON.stringify({ providers: { 'offline-ui': {
  api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'offline-test-placeholder',
  models: [{ id: 'offline', name: '离线界面验证（不发请求）' }],
} } }));
execFileSync(process.env.STEP_CODE_CLI || join(homedir(), '.stepcode/bin/step'), ['install', root], { cwd: workspace, env, stdio: 'pipe' });
const server = process.env.STEP_CODE_WEB_ENTRY || '/Applications/StepCode.app/Contents/Resources/server/node_modules/@step-harness/web/dist/server.js';
const child = spawn(process.execPath, ['--import', pathToFileURL(join(root, 'test/offline-network.mjs')).href, server],
  { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
const launchFile = join(profile, 'launch.json');
let ready = false, output = '';
child.stdout.on('data', data => {
  output = (output + String(data)).slice(-8000);
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[\w-]+/)?.[0];
  if (url && !ready) {
    ready = true;
    writeFileSync(launchFile, JSON.stringify({ url }), { mode: 0o600 });
    console.log(JSON.stringify({ ready: true, profile, launchFile, port, pid: child.pid }));
  }
});
child.stderr.on('data', () => {}); // No raw child diagnostics or launch credentials in logs.
const timeout = setTimeout(() => { if (!ready) { console.error('QA server startup failed'); child.kill('SIGTERM'); } }, 30000);
const stop = () => child.kill('SIGTERM');
process.once('SIGTERM', stop); process.once('SIGINT', stop);
child.once('exit', code => {
  clearTimeout(timeout);
  try { unlinkSync(launchFile); } catch {}
  console.log(JSON.stringify({ stopped: true, exitCode: code }));
  process.exitCode = code ?? 0;
});
