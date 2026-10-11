import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, mkdir, lstat, access, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const execFileAsync = promisify(execFile);
const swiftSource = join(dirname(fileURLToPath(import.meta.url)), '../native/VoiceAudio.swift');
const infoPlist = join(dirname(swiftSource), 'Info.plist');
let compilation;

/** Compile the bundled source locally. This does not request microphone permission. */
export async function prepareNativeAudio() {
  if (process.platform !== 'darwin') throw new Error('当前版本的终端音频支持 macOS；Windows/Linux 原生音频适配尚未实现。');
  if (compilation) return compilation;
  compilation = (async () => {
    const [source, metadata] = await Promise.all([readFile(swiftSource), readFile(infoPlist)]);
    const digest = createHash('sha256').update(source).update(metadata).digest('hex').slice(0, 20);
    const directory = join(tmpdir(), `step-voice-native-${process.getuid()}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('原生音频缓存目录权限不安全。');
    const executable = join(directory, `audio-${process.arch}-${digest}`);
    try { await access(executable, constants.X_OK); return executable; } catch { /* First use compiles the source. */ }
    const temporary = `${executable}.${process.pid}.${randomBytes(4).toString('hex')}`;
    try {
      await execFileAsync('xcrun', ['swiftc', '-swift-version', '5', '-O', swiftSource, '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', infoPlist, '-o', temporary], { timeout: 60000, maxBuffer: 1024 * 1024 });
      await rename(temporary, executable);
      return executable;
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw new Error(`无法编译 macOS 音频助手。请安装 Xcode Command Line Tools（xcode-select --install）。${String(error.stderr || error.message).slice(0, 500)}`);
    }
  })();
  try { return await compilation; } catch (error) { compilation = undefined; throw error; }
}

/** JSONL IPC with the native audio process. API keys are not inherited by it. */
export class NativeAudioEngine {
  constructor(hooks = {}, options = {}) {
    this.hooks = hooks;
    this.options = options;
    this.epoch = 0;
    this.muted = false;
  }

  start() {
    if (this.pendingStart) return this.pendingStart.promise;
    if (this.child) return Promise.resolve();
    const epoch = ++this.epoch;
    const pending = {};
    const cancelled = new Promise((_, reject) => { pending.cancel = () => reject(new Error('音频启动已取消。')); });
    pending.promise = Promise.race([this.startForEpoch(epoch), cancelled]).finally(() => {
      if (this.pendingStart === pending) this.pendingStart = undefined;
    });
    this.pendingStart = pending;
    return pending.promise;
  }

  async startForEpoch(epoch) {
    this.hooks.onStatus?.('preparing');
    const binary = this.options.binaryPath ?? await (this.options.prepareImpl ?? prepareNativeAudio)();
    if (epoch !== this.epoch) return;
    this.hooks.onStatus?.('permission');
    const spawnImpl = this.options.spawnImpl ?? spawn;
    const child = spawnImpl(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR ?? tmpdir(), LANG: process.env.LANG ?? 'en_US.UTF-8' } });
    this.child = child;
    let diagnostics = '';
    child.stderr.on('data', (data) => { diagnostics = (diagnostics + String(data)).slice(-1500); });
    child.stdin.on('error', (error) => { if (this.child === child) this.hooks.onError?.(error); });
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    await new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error) => {
        if (finished) return;
        finished = true; clearTimeout(timeout);
        this.rejectStart = undefined;
        if (error) reject(error); else resolve();
      };
      this.rejectStart = (error) => finish(error);
      const timeout = setTimeout(() => { finish(new Error('等待麦克风权限超时。请在 macOS 系统设置中允许当前终端应用使用麦克风，再重新开始。')); void this.stop(); }, this.options.readyTimeoutMs ?? 60000);
      this.lines.on('line', (line) => {
        if (this.child !== child || epoch !== this.epoch || line.length > 400000) return;
        let event;
        try { event = JSON.parse(line); } catch { this.hooks.onError?.(new Error('音频助手返回了无效事件。')); return; }
        switch (event.type) {
          case 'ready': this.hooks.onStatus?.('ready'); finish(); this.setMuted(this.muted); break;
          case 'audio': if (!this.muted) this.hooks.onAudio?.(event.audio); break;
          case 'level': this.hooks.onLevel?.(this.muted ? 0 : event.value); break;
          case 'playback': this.hooks.onPlayback?.(Boolean(event.active)); break;
          case 'error': { const error = new Error(event.message); finish(error); this.hooks.onError?.(error); break; }
          case 'notice': this.hooks.onNotice?.(event.message); break;
        }
      });
      child.once('error', (error) => { finish(error); if (this.child === child) this.hooks.onError?.(error); });
      child.once('exit', (code) => {
        const isCurrent = this.child === child;
        if (isCurrent) { this.child = undefined; this.lines?.close(); this.lines = undefined; }
        finish(new Error(`音频助手已退出 (${code})。${diagnostics}`));
        if (isCurrent) this.hooks.onClosed?.();
      });
    });
  }

  write(message) {
    if (!this.child || !this.child.stdin.writable) return;
    if (this.child.stdin.writableLength > 2 * 1024 * 1024) throw new Error('本地播放队列过长，请先打断回复。');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  play(audio, sampleRate = 24000) {
    if (sampleRate !== 24000 || typeof audio !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio) || audio.length % 4 || Buffer.from(audio, 'base64').length % 2) throw new Error('播放音频必须是 24 kHz 单声道 PCM16。');
    this.write({ type: 'play', audio, sampleRate });
  }
  clear() { this.write({ type: 'clear' }); this.hooks.onPlayback?.(false); }
  setMuted(muted) { this.muted = Boolean(muted); this.write({ type: 'mute', muted: this.muted }); if (this.muted) this.hooks.onLevel?.(0); }
  async stop() {
    this.epoch++;
    this.pendingStart?.cancel();
    this.pendingStart = undefined;
    this.rejectStart?.(new Error('音频启动已取消。'));
    const child = this.child;
    this.child = undefined;
    this.lines?.close(); this.lines = undefined;
    this.hooks.onLevel?.(0); this.hooks.onPlayback?.(false);
    if (!child || child.exitCode !== null) return;
    await new Promise((resolve) => {
      let force;
      const timeout = setTimeout(() => { child.kill('SIGTERM'); force = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 500); force.unref?.(); }, 500);
      timeout.unref?.();
      child.once('exit', () => { clearTimeout(timeout); clearTimeout(force); resolve(); });
      child.stdin.end(`${JSON.stringify({ type: 'stop' })}\n`);
    });
  }
}
