import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, mkdir, access, rename, unlink } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const execFileAsync = promisify(execFile);
const csSource = join(dirname(fileURLToPath(import.meta.url)), '../native/VoiceAudio.cs');
let compilation;

/** Locate the .NET Framework compiler shipped with Windows 10/11. */
export function findCsc(env = process.env, exists = existsSync) {
  const roots = [env.WINDIR, env.SystemRoot, 'C:\\Windows'].filter(Boolean);
  for (const root of roots) {
    for (const architecture of ['Framework64', 'Framework']) {
      const candidate = join(root, 'Microsoft.NET', architecture, 'v4.0.30319', 'csc.exe');
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Compile the bundled C# helper locally. The executable is cached under
 * %LOCALAPPDATA%\StepVoice\native and rebuilt when the source changes.
 * This does not request microphone permission.
 */
export async function prepareNativeAudio() {
  if (process.platform !== 'win32') throw new Error(`这是 Windows 版 Step Voice，只能在 Windows 上运行（当前平台：${process.platform}）。`);
  if (compilation) return compilation;
  compilation = (async () => {
    const source = await readFile(csSource);
    const digest = createHash('sha256').update(source).digest('hex').slice(0, 20);
    const directory = join(process.env.LOCALAPPDATA ?? tmpdir(), 'StepVoice', 'native');
    await mkdir(directory, { recursive: true });
    const executable = join(directory, `VoiceAudio-${digest}.exe`);
    try {
      await access(executable, constants.F_OK);
      // The cache directory is per-user (%LOCALAPPDATA%), but the cached exe
      // itself is verified against the source digest so a replaced file is
      // recompiled instead of executed (parity with the macOS uid/mode check).
      const cached = createHash('sha256').update(await readFile(executable)).digest('hex').slice(0, 20);
      if (cached === digest) return executable;
      await unlink(executable).catch(() => {});
    } catch { /* First use compiles the source. */ }
    const compiler = findCsc();
    if (!compiler) throw new Error('未找到 .NET Framework 编译器 csc.exe。Windows 10/11 自带 .NET Framework 4.x；若缺失请先安装 .NET Framework 4.8。');
    const temporary = join(directory, `VoiceAudio-${process.pid}-${randomBytes(4).toString('hex')}.exe`);
    try {
      await execFileAsync(compiler, [
        '/nologo', '/target:exe', '/optimize+', '/codepage:65001', `/out:${temporary}`, csSource,
      ], { timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true });
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw new Error(`无法编译 Windows 音频助手。${String(error.stderr || error.message).slice(0, 500)}`);
    }
    try {
      await rename(temporary, executable);
    } catch (error) {
      // Two Step Code sessions may compile the same digest at once; the loser
      // reuses the winner's executable instead of failing startup.
      await unlink(temporary).catch(() => {});
      try { await access(executable, constants.F_OK); } catch { throw error; }
    }
    return executable;
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
    const args = process.env.STEP_VOICE_ECHO_CANCEL === '1' ? ['--echo-cancel'] : [];
    const child = spawnImpl(binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
        TEMP: process.env.TEMP ?? tmpdir(),
        TMP: process.env.TMP ?? tmpdir(),
      },
    });
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
      const timeout = setTimeout(() => { finish(new Error('等待麦克风权限超时。请在 Windows 设置 → 隐私和安全性 → 麦克风 中允许桌面应用访问麦克风，再重新开始。')); void this.stop(); }, this.options.readyTimeoutMs ?? 60000);
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
