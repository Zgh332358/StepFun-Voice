import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const application = resolve(process.env.STEP_CODE_APP || '/Applications/StepCode.app');
const hostModules = join(application, 'Contents/Resources/server/node_modules');
const playwrightModule = resolve(process.env.STEP_PLAYWRIGHT_MODULE || join(hostModules, 'playwright-core/index.mjs'));
if (!existsSync(playwrightModule)) throw new Error('Desktop QA needs playwright-core. Set STEP_PLAYWRIGHT_MODULE to its installed index.mjs; the voice plugin itself does not need it.');
const { _electron } = await import(pathToFileURL(playwrightModule).href);
const plugin = resolve(process.env.STEP_VOICE_PACKAGE || JSON.parse(readFileSync(join(root, `.cache/releases/step-voice-${version}-manifest.json`), 'utf8')).directory);
mkdirSync(join(root, '.cache/releases'), { recursive: true });
const profile = mkdtempSync(join(root, '.cache/formal-ui-'));
const home = join(profile, 'home'), workspace = join(profile, 'workspace');
for (const path of [home, workspace, join(home, '.stepcode/agent'), join(profile, 'tmp')]) mkdirSync(path, { recursive: true });
const skill = join(home, '.stepcode/agent/skills/voice-of-customer-miner');
mkdirSync(skill, { recursive: true });
writeFileSync(join(skill, 'SKILL.md'), '---\nname: voice-of-customer-miner\ndescription: Offline autocomplete collision fixture\n---\nThis skill is only listed during UI testing; it is never executed.\n');
const wrapper = join(profile, 'offline-server.mjs');
// The desktop launcher checks public/index.html beside its configured server entry.
symlinkSync(join(hostModules, '@step-harness/web/dist/public'), join(profile, 'public'));
writeFileSync(wrapper, `await import(${JSON.stringify(pathToFileURL(join(root, 'test/offline-network.mjs')).href)});\nawait import(${JSON.stringify(pathToFileURL(join(hostModules, '@step-harness/web/dist/server.js')).href)});\n`);
writeFileSync(join(home, '.stepcode/models.json'), JSON.stringify({ providers: { 'offline-ui': {
  api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'offline-placeholder',
  models: [{ id: 'offline', name: '离线界面验证（不发请求）' }],
} } }));
const env = { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: join(profile, 'tmp'),
  STEP_CODING_AGENT_DIR: join(home, '.stepcode/agent'), STEPCODE_STORAGE_ROOT_DIR: join(home, '.stepcode'),
  STEP_VOICE_HOME: join(home, '.stepcode/step-voice'), STEPCODE_DESKTOP_USER_DATA_DIR: join(profile, 'electron'),
  STEPCODE_DESKTOP_SHELL_ENV: '0', STEPCODE_WEB_CWD: workspace, STEPCODE_DESKTOP_SERVER_ENTRY: wrapper,
  STEPCODE_DESKTOP_UPDATE_URL: 'disabled-for-offline-ui-test', STEP_NO_LOCAL_LLM: '1', AWS_EC2_METADATA_DISABLED: 'true' };
const cli = process.env.STEP_CODE_CLI || join(homedir(), '.stepcode/bin/step');
execFileSync(cli, ['install', plugin], { cwd: workspace, env, stdio: 'pipe' });
const app = await _electron.launch({ executablePath: join(application, 'Contents/MacOS/StepCode'), cwd: workspace, env, timeout: 30000 });
const result = { plugin, hostVersion: await app.evaluate(({ app }) => app.getVersion()), checks: [], errors: [] };
try {
  await app.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, done) => {
      done({ cancel: !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(details.url).hostname) });
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  });
  const page = await app.firstWindow();
  page.on('pageerror', error => result.errors.push(error.message));
  await page.waitForSelector('#prompt', { timeout: 30000 });
  // Every run creates a fresh profile; wait for its asynchronous first-use guide.
  await page.getByRole('button', { name: '跳过引导', exact: true }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: '跳过引导', exact: true }).click();
  await page.locator('#migrationModal').waitFor({ state: 'hidden' });
  await page.getByText('离线界面验证（不发请求）', { exact: false }).waitFor();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#sendButton')?.disabled === false);
  await page.locator('#prompt').fill('/voice');
  await page.getByRole('option').filter({ hasText: 'Voice Of Customer Miner' }).waitFor({ timeout: 15000 });
  await page.locator('#prompt').fill('/stepvoice');
  await page.locator('.slash-item').waitFor({ state: 'hidden' });
  await page.locator('#prompt').press('Enter');
  await page.waitForFunction(() => { const prompt = document.querySelector('#prompt'); return (prompt?.value ?? prompt?.textContent) === ''; });
  await page.waitForFunction(() => document.querySelector('#sendButton')?.disabled === false);
  await page.getByText('当前 StepCode 未提供输入栏语音插件接口', { exact: false }).first().waitFor({ timeout: 15000 });
  const snapshot = await page.locator('body').ariaSnapshot();
  assert.ok(!snapshot.includes('Step Voice · 当前桌面会话'), 'default entry must not open the old blocking menu');
  await page.locator('#prompt').fill('中文打字仍在原输入框');
  assert.equal(await page.locator('#prompt').evaluate(element => element.value ?? element.textContent), '中文打字仍在原输入框');
  assert.equal(app.windows().length, 1, 'unsupported host must not open any extra window');
  assert.equal(result.errors.length, 0);
  await page.screenshot({ path: join(root, '.cache/releases/formal-desktop-plugin.png') });
  await page.locator('#prompt').fill('/stepvoice setup');
  await page.locator('#prompt').press('Enter');
  await page.waitForFunction(() => { const prompt = document.querySelector('#prompt'); return (prompt?.value ?? prompt?.textContent) === ''; });
  const setup = await page.locator('body').ariaSnapshot();
  assert.ok(setup.includes('未提供输入栏语音插件接口'));
  assert.ok(!setup.includes('开放平台 API（按调用量计费）'));
  result.checks.push('unmodified official desktop executable', 'isolated profile package discovery', 'bare /stepvoice excludes Voice Of Customer Miner', 'missing composer capability is visible without a modal', 'Chinese draft stays in original editor', 'unsupported setup does not ask for credentials', 'one Electron window and no renderer error');
  writeFileSync(join(profile, 'nonmodal-snapshot.txt'), snapshot);
  writeFileSync(join(profile, 'setup-snapshot.txt'), setup);
} catch (error) {
  result.failure = error.message;
  const page = app.windows()[0];
  if (page) {
    result.page = (await page.locator('body').innerText()).slice(0, 4000).replace(/#token=[\w-]+/g, '#token=<redacted>');
    await page.screenshot({ path: join(root, '.cache/releases/formal-desktop-plugin-error.png') });
  }
  throw error;
}
finally {
  writeFileSync(join(root, '.cache/releases/formal-ui-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await app.close();
}
