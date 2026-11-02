import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, mkdir, lstat, access, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { credentialsDir } from './credentials.mjs';

const execFileAsync = promisify(execFile);
const source = join(dirname(fileURLToPath(import.meta.url)), '../native/VoiceHUD.swift');
const actions = new Set(['start', 'mute', 'interrupt', 'end', 'setup']);
let compilation;
export async function prepareNativeHUD() {
  if (process.platform !== 'darwin') throw new Error('原生语音浮窗仅支持 macOS。');
  if (!compilation) compilation = (async () => {
    const bytes = await readFile(source);
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 20);
    const directory = join(tmpdir(), `step-voice-native-${process.getuid()}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('原生浮窗缓存目录权限不安全。');
    const executable = join(directory, `hud-${process.arch}-${digest}`);
    try { await access(executable, constants.X_OK); return executable; } catch { /* First use compiles AppKit, without audio permissions. */ }
    const temporary = `${executable}.${process.pid}.${randomBytes(4).toString('hex')}`;
    try {
      await execFileAsync('xcrun', ['swiftc', '-swift-version', '5', '-O', source, '-o', temporary], { timeout: 60000, maxBuffer: 1024 * 1024 });
      await rename(temporary, executable);
      return executable;
    } catch {
      await unlink(temporary).catch(() => {});
      throw new Error('无法编译 macOS 语音浮窗，请确认已安装 Xcode Command Line Tools。');
    }
  })();
  try { return await compilation; } catch (error) { compilation = undefined; throw error; }
}

function text(value, limit) {
  return String(value ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[凭证已隐藏]').slice(-limit);
}
/** Only display data crosses IPC; no config, session IDs, raw tools or audio. */
export function hudState(state, agent = state.agent) {
  const active = state.voice === 'ready' || state.voice === 'connecting';
  let label = '准备开始', tone = 'neutral';
  if (state.voice === 'connecting') {
    label = ({ 'preparing-audio': '准备音频', 'opening-microphone': '等待麦克风', 'connecting-model': '连接语音' })[state.startupPhase] ?? '连接中';
    tone = 'blue';
  } else if (state.voice === 'error') { label = '语音出错'; tone = 'red'; }
  else if (state.voice === 'ready') {
    label = state.speaking ? '正在朗读' : state.muted ? '已静音' : '正在聆听';
    tone = state.speaking ? 'blue' : state.muted ? 'neutral' : 'green';
  }
  if (agent?.waitingForApproval) { label = '等待授权'; tone = 'amber'; }
  const latest = state.transcripts?.at(-1);
  const caption = state.subtitle?.active ? `朗读：${state.subtitle.text}` : latest ? `${latest.role === 'user' ? '你' : '语音'}：${latest.text}` : '';
  const denial = state.notice?.text || '';
  // macOS refuses to prompt for a hardened-runtime host without the audio-input
  // entitlement, so "allow it in System Settings" would send the user in circles.
  const hardenedDenial = /麦克风权限|microphone/i.test(denial) && /未开启|denied|not/i.test(denial);
  const detail = hardenedDenial
    ? '系统拒绝了 StepCode 的麦克风请求：宿主缺少 audio-input 权限，不会弹授权框。可改用终端运行 /stepvoice。'
    : agent?.waitingForApproval ? '请在 StepCode 主窗口处理权限确认。' : denial ||
      (!state.config?.keyConfigured ? '先配置语音接入；不会自动开启麦克风。' : agent?.status || '语音发送到当前 StepCode 会话');
  return { type: 'state', label, tone, active, muted: Boolean(state.muted), speaking: Boolean(state.speaking),
    micLevel: !state.muted && !state.speaking && state.voice === 'ready' && Number.isFinite(state.micLevel) ? Math.max(0, Math.min(1, state.micLevel)) : 0,
    caption: text(caption, 160), detail: text(detail, 240),
    primary: active ? (state.muted ? '恢复麦克风' : '静音麦克风') : state.config?.keyConfigured ? '开始语音' : '配置接入',
    primaryAction: active ? 'mute' : state.config?.keyConfigured ? 'start' : 'setup' };
}

export class NativeVoiceHUD {
  constructor(hooks = {}, options = {}) { this.hooks = hooks; this.options = options; this.epoch = 0; }
  update(snapshot, agent) {
    this.latest = hudState(snapshot, agent);
    if (!this.ready || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 100);
    this.timer.unref?.();
  }
  flush() {
    if (!this.ready || !this.child?.stdin.writable || this.child.stdin.writableLength > 65536) return;
    const payload = JSON.stringify(this.latest);
    if (payload !== this.lastPayload) { this.lastPayload = payload; this.child.stdin.write(`${payload}\n`); }
  }
  async show(snapshot, agent) {
    this.update(snapshot, agent);
    if (this.ready) { this.child.stdin.write('{"type":"show"}\n'); this.flush(); return; }
    if (this.pending) return this.pending.promise;
    const epoch = ++this.epoch;
    const pending = {};
    const cancelled = new Promise((_, reject) => { pending.cancel = () => reject(new Error('浮窗启动已取消。')); });
    pending.promise = Promise.race([this.launch(epoch), cancelled]);
    this.pending = pending;
    try { await pending.promise; }
    catch (error) { if (this.epoch === epoch) await this.close(); throw error; }
    finally { if (this.pending === pending) this.pending = undefined; }
  }
  async launch(epoch) {
    const binary = this.options.binaryPath ?? await (this.options.prepareImpl ?? prepareNativeHUD)();
    if (this.epoch !== epoch) return;
    const child = (this.options.spawnImpl ?? spawn)(binary, ['--position-file', this.options.positionFile ?? join(credentialsDir(), 'hud.json'), '--parent-pid', String(process.pid)], { stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR ?? tmpdir(), LANG: process.env.LANG ?? 'en_US.UTF-8' } });
    this.child = child;
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    child.stderr.resume();
    await new Promise((resolve, reject) => {
      let settled = false, failed = false;
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.rejectReady = undefined;
        error ? reject(error) : resolve();
      };
      this.rejectReady = error => finish(error);
      const timer = setTimeout(() => finish(new Error('等待原生浮窗启动超时。')), this.options.readyTimeoutMs ?? 5000);
      const fail = error => {
        if (failed || this.child !== child || this.epoch !== epoch) return;
        failed = true;
        if (!settled) finish(error);
        else this.hooks.onError?.(error);
      };
      child.stdin.on('drain', () => { if (this.child === child && this.epoch === epoch) this.flush(); });
      child.stdin.on('error', () => fail(new Error('原生浮窗通信中断。')));
      child.once('error', () => fail(new Error('无法启动原生语音浮窗。')));
      child.once('exit', () => {
        fail(new Error('语音浮窗已退出；通话已停止，请重新打开 /stepvoice。'));
        if (this.child === child) { this.child = undefined; this.ready = false; this.lines?.close(); }
      });
      this.lines.on('line', line => {
        if (this.child !== child || this.epoch !== epoch || line.length > 2048) return;
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.type === 'ready') { this.ready = true; finish(); this.flush(); }
        else if (this.ready && event.type === 'action' && actions.has(event.action)) this.hooks.onAction?.(event.action);
      });
    });
  }
  async close() {
    this.epoch++; this.ready = false; this.lastPayload = undefined;
    clearTimeout(this.timer); this.timer = undefined;
    this.pending?.cancel(); this.pending = undefined;
    this.rejectReady?.(new Error('浮窗启动已取消。'));
    const child = this.child; this.child = undefined;
    this.lines?.close(); this.lines = undefined;
    if (!child || child.exitCode !== null) return;
    await new Promise(resolve => {
      let force;
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        force = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 500);
        force.unref?.();
      }, 500);
      child.once('exit', () => { clearTimeout(timer); clearTimeout(force); resolve(); });
      child.stdin.end('{"type":"close"}\n');
    });
  }
}
