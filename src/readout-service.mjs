import { randomUUID } from 'node:crypto';
import { sanitizeProviderError, summarizeForSpeech, synthesizeSpeech } from './stepfun.mjs';

export function boundedText(value, limit = 12000) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`文本须为 1 到 ${limit} 字符。`);
  return value;
}
export function validateMediaContext(context) {
  for (const key of ['sessionId', 'voiceSessionId']) boundedText(context?.[key], 160);
  if (!Number.isSafeInteger(context.generation) || context.generation < 1 ||
    typeof context.emit !== 'function' || typeof context.signal?.addEventListener !== 'function') throw new Error('语音会话上下文无效。');
  context.signal.throwIfAborted();
}
export function redactText(text, key) {
  return (key ? String(text).split(key).join('[redacted]') : String(text)).replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [redacted]');
}
export function abortable(run, signal) {
  signal.throwIfAborted();
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(new Error('语音操作已取消。'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return run(); }), cancelled])
    .finally(() => signal.removeEventListener('abort', onAbort));
}
export function validatePCM(frame) {
  if (frame?.sampleRate !== 24000 || frame?.numChannels !== 1 || typeof frame.data !== 'string' ||
    !frame.data.length || frame.data.length > 128000 || frame.data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.data)) {
    throw new Error('音频必须为有界的 24 kHz 单声道 PCM16 Base64。');
  }
  const bytes = Buffer.from(frame.data, 'base64');
  if (!bytes.length || bytes.length % 2) throw new Error('PCM16 音频长度无效。');
}

/** Output-only service: construction and configuration never open audio or a realtime session. */
export function createReadoutService({ getConfig, summarize = summarizeForSpeech, synthesize = synthesizeSpeech, summarizeEnabled = true }) {
  let active, disposed = false, epoch = 0;
  function interrupt() {
    const current = active;
    active = undefined;
    if (!current) return;
    current.abort.abort();
    if (!current.context.signal.aborted) current.context.emit({ type: 'output.clear', source: 'readout', ...current.identity,
      responseId: current.responseId, outputEpoch: current.epoch });
  }
  return {
    get active() { return Boolean(active); },
    interrupt,
    async speak(text, context) {
      if (disposed) throw new Error('朗读服务已关闭。');
      validateMediaContext(context); boundedText(text);
      const config = { ...getConfig() };
      if (!config.apiKey) throw new Error('请先配置 StepFun 语音接入。');
      interrupt();
      const current = { abort: new AbortController(), context, responseId: randomUUID(), epoch: ++epoch,
        identity: { sessionId: context.sessionId, voiceSessionId: context.voiceSessionId, generation: context.generation } };
      active = current;
      const signal = AbortSignal.any([context.signal, current.abort.signal]);
      const emit = event => {
        if (active === current && !signal.aborted) context.emit({ ...event, ...current.identity, source: 'readout',
          responseId: current.responseId, outputEpoch: current.epoch });
      };
      let audioBytes = 0;
      try {
        const raw = redactText(text, config.apiKey), chars = Array.from(raw);
        let spoken = chars.length > 100 ? '……' + chars.slice(-100).join('') : raw;
        if (summarizeEnabled) {
          try { spoken = boundedText(await abortable(() => summarize(config, raw, { signal }), signal), 1000); }
          catch (error) {
            signal.throwIfAborted();
            emit({ type: 'notice', message: '摘要不可用，本次朗读结果末尾。' });
          }
        }
        spoken = redactText(spoken, config.apiKey);
        const speed = Math.min(2, Math.max(1, Array.from(spoken).length / 80));
        emit({ type: 'output.subtitle.start', text: spoken });
        await abortable(() => synthesize(config, spoken, { signal, speed, onAudio: chunk => {
          if (signal.aborted || active !== current) return;
          const bytes = Buffer.from(chunk);
          if (!bytes.length || bytes.length % 2 || bytes.length > 262144) throw new Error('TTS 返回了无效 PCM16。');
          audioBytes += bytes.length;
          if (audioBytes > 24000 * 2 * 120) throw new Error('TTS 音频超过两分钟上限。');
          emit({ type: 'output.audio.delta', audio: bytes.toString('base64'), sampleRate: 24000, numChannels: 1 });
        } }), signal);
        if (!audioBytes) throw new Error('TTS 未返回可播放音频。');
        emit({ type: 'output.subtitle.end' });
      } catch (error) {
        emit({ type: 'output.clear' });
        throw new Error(sanitizeProviderError(signal.aborted ? '语音操作已取消。' : error, config.apiKey));
      } finally { if (active === current) active = undefined; }
    },
    async dispose() { disposed = true; interrupt(); },
  };
}
