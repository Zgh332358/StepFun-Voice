import { WebSocket } from 'ws';
import { createConversationProvider } from './conversation-provider.mjs';
import { CHANNELS, clearCredentials, isChannel, keyHint, saveCredentials, validKeyShape } from './credentials.mjs';
import { assertOfficialBaseUrl, loadStepFunConfig, sanitizeProviderError, StepFunRealtimeClient, summarizeForSpeech, synthesizeSpeech, verifyChannelAccess } from './stepfun.mjs';

/** Vendor/config adapter only. Session ownership, transcript ordering and task execution live in the host. */
export function createHarnessVoiceRuntime(options = {}) {
  const env = options.env ?? process.env;
  let config;
  let disposed = false;
  let checking;
  const sessions = new Set();
  const currentConfig = () => config ??= loadStepFunConfig(env);
  const verify = options.verifyAccess ?? ((candidate, { signal }) => verifyChannelAccess(candidate, { WebSocketImpl: WebSocket, signal }));
  const summarize = options.summarize ?? summarizeForSpeech;
  const synthesize = options.synthesizeSpeech ?? synthesizeSpeech;
  const clientFactory = options.clientFactory ?? ((candidate, hooks) => new StepFunRealtimeClient(candidate, { ...hooks, WebSocketImpl: WebSocket }));
  const settings = { speakTasks: env.STEP_VOICE_SPEAK_TASKS !== '0', speakSummarize: env.STEP_VOICE_SUMMARY !== '0' };
  const conversationProvider = createConversationProvider({ getConfig: () => {
    assertActive();
    if (checking) throw new Error('正在验证接入设置，请稍候。');
    return currentConfig();
  }, clientFactory, summarize, synthesize, summarizeEnabled: settings.speakSummarize });
  const assertActive = () => { if (disposed) throw new Error('语音适配器已随旧会话关闭。'); };

  function sanitizeEvent(value, apiKey = config?.apiKey) {
    if (typeof value === 'string') return (apiKey ? value.split(apiKey).join('[已隐藏]') : value).replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]');
    if (Array.isArray(value)) return value.map(item => sanitizeEvent(item, apiKey));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeEvent(item, apiKey)]));
    return value;
  }

  function publicConfig() {
    assertActive();
    const value = currentConfig();
    return { baseUrl: value.baseUrl, realtimeModel: value.realtimeModel, ttsModel: value.ttsModel,
      voice: value.voice, channel: value.channel, keySource: value.keySource, setupDone: value.setupDone,
      keyConfigured: Boolean(value.apiKey), keyHint: keyHint(value.apiKey), envKeyHint: value.envKeyHint };
  }

  function updateConfig(input) {
    assertActive();
    if (conversationProvider.active) throw new Error('请先结束实时语音或朗读，再修改接入设置。');
    if (checking) throw new Error('正在验证接入设置，请稍候。');
    const next = { ...currentConfig() };
    for (const name of ['baseUrl', 'realtimeModel', 'ttsModel', 'asrModel', 'voice']) {
      if (input?.[name] === undefined) continue;
      if (typeof input[name] !== 'string' || !input[name].trim() || input[name].length > 250) throw new Error('无效的语音配置');
      next[name] = input[name].trim();
      if (name.endsWith('Model') && !/^step[a-z0-9._-]+$/i.test(next[name])) throw new Error('仅接受 StepFun 模型名称');
    }
    next.baseUrl = assertOfficialBaseUrl(next.baseUrl);
    if (input?.apiKey) {
      if (typeof input.apiKey !== 'string' || input.apiKey.length > 2048 || /[\r\n]/.test(input.apiKey)) throw new Error('API Key 格式无效');
      next.apiKey = input.apiKey.trim();
      next.keySource = 'env';
      next.envKeyHint = keyHint(next.apiKey);
    }
    config = next;
  }

  async function save(channel, apiKey = '', useEnvKey = false) {
    assertActive();
    if (conversationProvider.active) throw new Error('请先结束实时语音或朗读，再修改接入设置。');
    if (checking) throw new Error('正在验证上一个 Key，请稍候。');
    if (!isChannel(channel)) throw new Error('接入通道无效');
    const typed = typeof apiKey === 'string' ? apiKey.trim() : '';
    const key = typed || (useEnvKey ? String(env.STEP_API_KEY || env.STEPFUN_API_KEY || '').trim() : '');
    if (!validKeyShape(key)) return { ok: false, message: '请输入完整、不含空格的 API Key。' };
    const previous = currentConfig();
    const defaults = CHANNELS[channel];
    const candidate = { ...previous, channel, apiKey: key,
      baseUrl: assertOfficialBaseUrl(`${new URL(previous.baseUrl).origin}${new URL(defaults.baseUrl).pathname}`),
      realtimeModel: env.STEP_VOICE_REALTIME_MODEL?.trim() || defaults.realtimeModel,
      ttsModel: env.STEP_VOICE_TTS_MODEL?.trim() || defaults.ttsModel,
      asrModel: env.STEP_VOICE_ASR_MODEL?.trim() || defaults.asrModel };
    const request = new AbortController();
    checking = request;
    try {
      const result = await verify(candidate, { signal: request.signal });
      if (disposed || request.signal.aborted) return { ok: false, message: '接入验证已取消，未保存。' };
      if (!result.ok) return { ok: false, message: sanitizeProviderError(result.message, key) };
      const file = saveCredentials({ channel, apiKey: typed ? key : '' }, env);
      config = { ...candidate, keySource: typed ? 'saved' : 'env', setupDone: true };
      return { ok: true, message: '验证通过，已保存。', file };
    } finally { if (checking === request) checking = undefined; }
  }

  function createSession(context) {
    assertActive();
    const selected = { ...currentConfig() };
    const aborted = new AbortController();
    let closing;
    let closed = false;
    let resolveSocketClosed;
    let sequence = 0;
    let summaryNoticeShown = false;
    const speechTasks = new Set();
    const socketClosed = new Promise(resolve => { resolveSocketClosed = resolve; });
    const client = clientFactory(selected, { delegate: false, autoBargeIn: false, onEvent(event) {
      if (event.type === 'closed') resolveSocketClosed();
      if (closed || context.signal.aborted) return;
      if (['speech.start', 'speech.end', 'input.committed', 'input.transcript.final', 'input.transcript.failed'].includes(event.type)) context.emit(sanitizeEvent(event, selected.apiKey));
      else if (event.type === 'error') context.emit({ type: 'error', message: sanitizeProviderError(event.message, selected.apiKey) });
      else if (event.type === 'closed') context.emit({ type: 'closed', message: 'StepFun 语音连接已关闭。' });
    } });
    const onAbort = () => { void session.close().catch(() => { /* The host awaits and reports the same close operation. */ }); };
    const session = {
      async start() {
        if (closed || context.signal.aborted) throw new Error('语音启动已取消。');
        await client.connect();
      },
      appendAudio(frame) {
        if (closed) throw new Error('语音连接已关闭。');
        if ((client.socket?.bufferedAmount ?? 0) > 2 * 1024 * 1024) throw new Error('上游音频消费过慢，已停止语音。');
        client.appendAudio(frame.data);
      },
      speak(text, output) {
        if (!settings.speakTasks || closed) return Promise.resolve();
        const signal = AbortSignal.any([output.signal, aborted.signal, context.signal]);
        const responseId = `tts-${++sequence}`;
        const emit = event => { if (!signal.aborted && !closed) output.emit(sanitizeEvent(event, selected.apiKey)); };
        const task = (async () => {
          signal.throwIfAborted();
          const raw = selected.apiKey ? String(text).split(selected.apiKey).join('[已隐藏]') : String(text);
          const chars = Array.from(raw);
          let spoken = chars.length > 100 ? '……' + chars.slice(-100).join('') : raw;
          if (settings.speakSummarize) {
            try { spoken = await summarize(selected, raw, { signal }) || spoken; }
            catch (error) {
              signal.throwIfAborted();
              if (!summaryNoticeShown) {
                summaryNoticeShown = true;
                emit({ type: 'notice', message: `自动总结不可用，本次改读结尾原文：${sanitizeProviderError(error, selected.apiKey)}` });
              }
            }
          }
          signal.throwIfAborted();
          spoken = sanitizeEvent(spoken, selected.apiKey);
          const speed = Math.min(2, Math.max(1, Array.from(spoken).length / 80));
          emit({ type: 'output.subtitle.start', responseId, text: spoken, charsPerSecond: 4.5 * speed });
          try {
            await synthesize(selected, spoken, { signal, speed, onAudio: chunk => emit({
              type: 'output.audio.delta', responseId, audio: Buffer.from(chunk).toString('base64'), sampleRate: 24000,
            }) });
          } finally { emit({ type: 'output.subtitle.end', responseId }); }
        })().catch(error => { throw new Error(sanitizeProviderError(error, selected.apiKey)); });
        speechTasks.add(task);
        void task.then(() => speechTasks.delete(task), () => speechTasks.delete(task));
        return task;
      },
      close() {
        if (closing) return closing;
        closed = true;
        aborted.abort();
        context.signal.removeEventListener('abort', onAbort);
        closing = (async () => {
          client.close();
          await waitForSocketClose(client.socket, socketClosed);
          await Promise.allSettled([...speechTasks]);
          sessions.delete(session);
        })();
        return closing;
      },
    };
    sessions.add(session);
    context.signal.addEventListener('abort', onAbort, { once: true });
    return session;
  }

  const provider = { id: 'stepfun', label: 'StepFun Realtime + TTS', createSession };
  return { provider, conversationProvider, publicConfig, settings, updateConfig, sanitizeEvent, saveCredentials: save,
    cancelSetup() { checking?.abort(); },
    clearCredentials() {
      assertActive();
      if (conversationProvider.active) throw new Error('请先结束实时语音或朗读，再修改接入设置。');
      if (checking) throw new Error('请等待接入验证结束。');
      clearCredentials(env);
      config = loadStepFunConfig(env, { saved: undefined });
    },
    async dispose() {
      disposed = true;
      checking?.abort();
      await Promise.all([conversationProvider.dispose(), ...[...sessions].map(session => session.close())]);
    },
  };
}

async function waitForSocketClose(socket, closed) {
  if (!socket || socket.readyState === 3) return;
  let terminate, timeout;
  try {
    await Promise.race([closed, new Promise((_, reject) => {
      terminate = setTimeout(() => socket.terminate?.(), 300);
      timeout = setTimeout(() => reject(new Error('上游语音连接关闭超时。')), 1500);
    })]);
  } finally { clearTimeout(terminate); clearTimeout(timeout); }
}
