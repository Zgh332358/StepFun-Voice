import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { assertOfficialBaseUrl, loadStepFunConfig, REALTIME_SAMPLE_RATE, StepFunRealtimeClient, summarizeForSpeech, synthesizeSpeech, verifyChannelAccess } from './stepfun.mjs';
import { TranscriptionQueue } from './transcription-queue.mjs';
import { CHANNELS, clearCredentials, credentialsFile, isChannel, keyHint, saveCredentials, validKeyShape } from './credentials.mjs';

function publicConfig(config) {
  const { baseUrl, realtimeModel, ttsModel, asrModel, voice, channel, keySource, setupDone, envKeyHint } = config;
  return { baseUrl, realtimeModel, ttsModel, asrModel, voice, channel: channel ?? 'api', keySource: keySource ?? (config.apiKey ? 'env' : ''), setupDone: Boolean(setupDone), envKeyHint: envKeyHint ?? '', keyHint: keyHint(config.apiKey), keyConfigured: Boolean(config.apiKey) };
}

function redact(text, config) {
  let value = String(text ?? '未知错误');
  if (config.apiKey) value = value.split(config.apiKey).join('[已隐藏]');
  return value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]').slice(0, 700);
}

function redactEvent(value, config) {
  // Preserve normal transcript lengths while removing keys from all outbound data.
  if (typeof value === 'string') {
    const text = config.apiKey ? value.split(config.apiKey).join('[已隐藏]') : value;
    return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]');
  }
  if (Array.isArray(value)) return value.map((item) => redactEvent(item, config));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactEvent(item, config)]));
  return value;
}

function equalToken(a, b) {
  if (typeof a !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(a) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function configUpdate(config, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return config;
  const updated = { ...config };
  for (const field of ['baseUrl', 'realtimeModel', 'ttsModel', 'asrModel', 'voice']) {
    if (input[field] === undefined) continue;
    if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > 250) {
      throw new Error(`配置项 ${field} 无效`);
    }
    updated[field] = input[field].trim();
    if (field.endsWith('Model') && !/^step[a-z0-9._-]+$/i.test(updated[field])) throw new Error('仅接受 StepFun 模型名称');
  }
  if (input.apiKey !== undefined && input.apiKey !== '') {
    if (typeof input.apiKey !== 'string' || input.apiKey.length > 2048 || /[\r\n]/.test(input.apiKey)) {
      throw new Error('API Key 格式无效');
    }
    updated.apiKey = input.apiKey.trim();
  }
  updated.baseUrl = assertOfficialBaseUrl(updated.baseUrl);
  return updated;
}

function instructionText(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 12000) throw new Error('请输入 1–12000 字的内容');
  return text;
}

export function speechSummary(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, '代码已展示在任务面板。')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '链接')
    .replace(/^[\s#>*-]+/gm, '')
    .replace(/`/g, '')
    .trim().slice(0, 850);
}

function unattachedAgent(cwd) {
  const snapshot = () => ({ sessionId: '', cwd, busy: false, pending: false, waitingForApproval: false, status: '未连接 Step Code；从 Step Code 的 /voice 命令启动可执行任务', lastResponse: '' });
  return { snapshot, subscribe: () => () => {}, submit: () => { throw new Error('当前是独立语音面板。请在 Step Code 中使用 /voice 连接当前编码任务。'); }, cancel: () => { throw new Error('未连接 Step Code Agent'); } };
}

/** Local-only relay. The upstream key never leaves this process. */
export async function startVoiceServer(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const agentConnected = Boolean(options.agent);
  const agent = options.agent ?? unattachedAgent(cwd);
  const env = options.env ?? process.env;
  let config = configUpdate(loadStepFunConfig(env), {});
  const verifyAccess = options.verifyAccess ?? ((value) => verifyChannelAccess(value, { WebSocketImpl: WebSocket }));
  /** Apply a channel's defaults while keeping explicit model variables. */
  function channelConfig(base, channel, apiKey) {
    const defaults = CHANNELS[channel];
    const pick = (name, field) => env[name]?.trim() || defaults[field];
    return { ...base, channel, apiKey, baseUrl: defaults.baseUrl, realtimeModel: pick('STEP_VOICE_REALTIME_MODEL', 'realtimeModel'), ttsModel: pick('STEP_VOICE_TTS_MODEL', 'ttsModel'), asrModel: pick('STEP_VOICE_ASR_MODEL', 'asrModel') };
  }
  const settings = { speakTasks: env.STEP_VOICE_SPEAK_TASKS !== '0', speakSummarize: env.STEP_VOICE_SUMMARY !== '0' };
  const capability = randomBytes(32).toString('base64url');
  let address;
  let active;
  let disposed = false;
  const clients = new Set();
  const providerFactory = options.providerFactory ?? ((value, hooks) => new StepFunRealtimeClient(value, { ...hooks, WebSocketImpl: WebSocket }));
  const synthesize = options.synthesizeSpeech ?? synthesizeSpeech;
  const summarize = options.summarize ?? summarizeForSpeech;

  function send(client, event) {
    if (client.readyState !== WebSocket.OPEN) return;
    // A stalled renderer must not grow an unbounded audio queue.
    if (client.bufferedAmount > 2 * 1024 * 1024) {
      client.close(1013, '客户端音频消费过慢');
      return;
    }
    client.send(JSON.stringify(redactEvent(event, config)));
  }
  function sendVoice(session, event) { send(session.client, { ...event, voiceSessionId: session.voiceSessionId }); }
  function broadcast(event) { for (const client of clients) send(client, event); }
  function failure(client, error, code = 'voice_error', voiceSessionId) { send(client, { type: 'error', code, voiceSessionId, message: redact(error?.message ?? error, config) }); }

  function stopSession(client, state = 'stopped', expectedId) {
    if (!active || (client && active.client !== client) || (expectedId && active.voiceSessionId !== expectedId)) return;
    const session = active;
    active = undefined;
    session.ttsAbort?.abort();
    session.transcripts.close();
    sendVoice(session, { type: 'audio.clear' });
    session.provider?.close();
    sendVoice(session, { type: 'voice.state', state });
  }

  function submitInput(text, delivery = 'followUp', source = 'typed_text', identity = {}) {
    const instruction = instructionText(text);
    const result = agent.submit(instruction, delivery);
    broadcast({ type: 'task.accepted', ...result, instruction, source, ...identity });
    return result;
  }

  let ttsSequence = 0;
  const unsubscribe = agent.subscribe((event) => {
    broadcast(event);
    if (event.type === 'agent.complete' && settings.speakTasks) speakCompletion(event);
  });

  /** Codex-style readout: summarize the host's real output and speak it within a standard ~20s budget. */
  async function speakCompletion(event) {
    const session = active;
    if (!session?.ready || session.client.readyState !== 1) return;
    if (event.isError) return;
    const raw = redact(event.text, config).trim();
    if (!raw) return;
    session.ttsAbort?.abort();
    const signal = (session.ttsAbort = new AbortController()).signal;
    const responseId = `tts-${++ttsSequence}`;
    try {
      const chars = Array.from(raw);
      // 安全底线：结尾 100 字（约 25 秒），总结成功才替换。
      let spoken = chars.length > 100 ? '……' + chars.slice(-100).join('') : chars.join('');
      let speed = 1;
      if (settings.speakSummarize) {
        const summary = await summarize(config, raw, { signal }).catch((error) => {
          if (!session.summaryNoticeShown) {
            session.summaryNoticeShown = true;
            sendVoice(session, { type: 'notice', message: `自动总结不可用（${String(error?.message || error).slice(0, 120)}），本次改读结尾原文。请检查 STEP_VOICE_SUMMARY_MODEL 是否为账号可用模型。` });
          }
          return '';
        });
        if (summary) spoken = summary;
      }
      if (Array.from(spoken).length > 80) speed = Math.min(2, Array.from(spoken).length / 80);
      // Subtitles start before synthesis so the panel shows the exact text being
      // read as early as possible; a stale session must not resurrect a subtitle.
      if (active !== session || !session.ready) return;
      const charsPerSecond = 4.5 * speed;
      sendVoice(session, { type: 'output.subtitle.start', responseId, text: spoken, charsPerSecond });
      await synthesize(config, spoken, {
        signal, speed,
        onAudio: (chunk) => sendVoice(session, { type: 'output.audio.delta', responseId, audio: chunk.toString('base64'), sampleRate: REALTIME_SAMPLE_RATE }),
      });
    } catch { /* 播放失败不打断面板；Step Code 主终端仍是权威输出。 */ }
    finally { if (active === session) sendVoice(session, { type: 'output.subtitle.end', responseId }); }
  }

  async function startSession(client, message) {
    if (disposed || !clients.has(client) || client.readyState !== WebSocket.OPEN) return;
    if (active) {
      if (active.client !== client) throw new Error('已有一个语音面板正在通话，请先结束该通话。');
      stopSession(client);
    }
    if (message.voiceSessionId !== undefined && (typeof message.voiceSessionId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(message.voiceSessionId))) throw new Error('语音会话标识无效。');
    config = configUpdate(config, message.config);
    if (!config.apiKey) {
      send(client, { type: 'voice.state', state: 'error', voiceSessionId: message.voiceSessionId });
      throw new Error('尚未配置 StepFun Key。请在启动 Step Code 的终端设置 STEP_API_KEY 或 STEPFUN_API_KEY，再重新启动。');
    }
    const session = { client, voiceSessionId: message.voiceSessionId, provider: undefined, ready: false };
    session.transcripts = new TranscriptionQueue({
      timeoutMs: options.transcriptionTimeoutMs,
      speechTimeoutMs: options.speechTimeoutMs,
      maxItems: options.maxTranscriptionItems,
      maxPending: options.maxPendingTranscriptions,
      submit: (event) => submitInput(event.text, 'followUp', 'user_audio', { itemId: event.itemId, contentIndex: event.contentIndex, voiceSessionId: session.voiceSessionId }),
      display: (event) => sendVoice(session, event),
      fail: (message) => failure(client, message, 'transcription_error', session.voiceSessionId),
      stop: () => stopSession(client, 'error'),
    });
    active = session;
    sendVoice(session, { type: 'voice.state', state: 'connecting' });
    // Defense in depth: even an unexpected provider callback cannot execute tools.
    const onToolCall = async () => ({ error: 'voice_delegation_disabled' });
    const onEvent = (event) => {
      if (active !== session) return;
      if (['speech.start', 'speech.end', 'input.committed', 'input.transcript.final', 'input.transcript.failed'].includes(event.type)) {
        session.transcripts.receive(event);
        if (active === session && !event.type.startsWith('input.transcript.')) sendVoice(session, event);
        return;
      }
      if (event.type.startsWith('response.') || event.type.startsWith('tool.')) return;
      // Model voice replies and their transcripts play/display locally; tools stay disabled.
      if (['output.audio.delta', 'output.audio.done', 'output.transcript.delta', 'output.transcript.final'].includes(event.type)) {
        sendVoice(session, event);
        return;
      }
      if (event.type.startsWith('output.')) return;
      if (event.type === 'ready') {
        session.ready = true;
        sendVoice(session, { type: 'voice.state', state: 'ready' });
      }
      if (event.type === 'closed') {
        stopSession(client);
        return;
      }
      if (event.type === 'error') {
        sendVoice(session, { ...event, message: redact(event.message, config) });
        if (!session.ready) stopSession(client, 'error');
        return;
      }
      sendVoice(session, event);
    };
    try {
      session.provider = providerFactory(config, { delegate: false, autoBargeIn: false, onEvent, onToolCall });
      await session.provider.connect();
    }
    catch (error) { if (active === session) { stopSession(client, 'error'); throw error; } }
  }

  const connections = new Set();
  const server = http.createServer(async (request, response) => {
    const host = request.headers.host;
    if (!address || host !== `127.0.0.1:${address.port}`) { response.writeHead(403).end('Invalid Host'); return; }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (request.method !== 'GET') { response.writeHead(405).end('Method not allowed'); return; }
    let pathname;
    try { pathname = new URL(request.url, 'http://localhost').pathname; }
    catch { response.writeHead(400).end('Invalid request URL'); return; }
    if (pathname === '/healthz') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ok: true, agentConnected })); return; }
    if (pathname === '/') { response.setHeader('Content-Type', 'text/plain; charset=utf-8'); response.end('Step Voice terminal relay. Open /voice inside Step Code.'); return; }
    response.writeHead(404).end('Not found');
  });
  // Upgraded sockets can outlive ws.close() in a Bun-compiled host. Own the
  // transport sockets so /voice stop and extension reload also close HTTP.
  server.on('connection', (socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 192 * 1024, handleProtocols: (protocols) => protocols.has('step-voice') ? 'step-voice' : false });
  server.on('upgrade', (request, socket, head) => {
    const expectedHost = `127.0.0.1:${address.port}`;
    const protocols = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim());
    const origin = request.headers.origin;
    const allowed = request.url === '/ws' && request.headers.host === expectedHost && origin === `http://${expectedHost}` && protocols.some((p) => equalToken(p, capability));
    if (!allowed) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
  });

  wss.on('connection', (client) => {
    clients.add(client);
    send(client, { type: 'server.ready', config: publicConfig(config), settings, agent: agent.snapshot(), agentConnected });
    let controlQueue = Promise.resolve();
    let generation = 0;
    let rateStarted = Date.now();
    let rateCount = 0;
    async function handle(message) {
      if (disposed || !clients.has(client) || client.readyState !== WebSocket.OPEN) return;
      switch (message.type) {
        case 'voice.start': await startSession(client, message); break;
        case 'voice.stop': stopSession(client, 'stopped', message.voiceSessionId); break;
        case 'voice.interrupt':
          if (active?.client === client) {
            active.ttsAbort?.abort();
            sendVoice(active, { type: 'audio.clear' });
          }
          break;
        case 'config.update':
          if (active) throw new Error('请先结束语音通话再修改配置。');
          config = configUpdate(config, message.config);
          send(client, { type: 'config.saved', config: publicConfig(config), settings });
          break;
        case 'credentials.save': {
          // First-run setup and later changes from the panel. The Key is checked live before saving.
          if (active) throw new Error('请先结束语音通话再修改接入设置。');
          if (!isChannel(message.channel)) throw new Error('接入通道无效');
          const envKey = String(env.STEP_API_KEY || env.STEPFUN_API_KEY || '').trim();
          const typed = typeof message.apiKey === 'string' ? message.apiKey.trim() : '';
          const apiKey = typed || (message.useEnvKey ? envKey : '');
          if (!apiKey) { send(client, { type: 'credentials.invalid', reason: 'empty', message: '请输入 API Key。' }); break; }
          if (!validKeyShape(apiKey)) { send(client, { type: 'credentials.invalid', reason: 'shape', message: 'API Key 格式不对：应为一整串不含空格的字符，请重新复制。' }); break; }
          const candidate = channelConfig(config, message.channel, apiKey);
          send(client, { type: 'credentials.checking' });
          const result = await verifyAccess(candidate);
          if (!result?.ok) { send(client, { type: 'credentials.invalid', reason: result?.reason ?? 'unknown', message: redact(result?.message ?? '验证失败', candidate) }); break; }
          // A Key that only came from the environment is not copied to disk.
          const file = saveCredentials({ channel: message.channel, apiKey: typed ? apiKey : '' }, env);
          config = { ...candidate, keySource: typed ? 'saved' : 'env', setupDone: true };
          send(client, { type: 'credentials.saved', config: publicConfig(config), file });
          break;
        }
        case 'credentials.clear': {
          if (active) throw new Error('请先结束语音通话再修改接入设置。');
          clearCredentials(env);
          config = configUpdate(loadStepFunConfig(env, { saved: undefined }), {});
          send(client, { type: 'credentials.saved', config: publicConfig(config), file: credentialsFile(env), cleared: true });
          break;
        }
        case 'input.text':
        case 'agent.submit': {
          submitInput(message.text, message.delivery === 'steer' ? 'steer' : 'followUp');
          break;
        }
        case 'agent.cancel': agent.cancel(); break;
        case 'ping': send(client, { type: 'pong' }); break;
        default: throw new Error('不支持的消息类型');
      }
    }
    client.on('message', (data, isBinary) => {
      if (Date.now() - rateStarted > 1000) { rateStarted = Date.now(); rateCount = 0; }
      if (++rateCount > 100) { failure(client, new Error('发送频率过高'), 'rate_limit'); client.close(1008, 'Rate limit'); return; }
      try {
        if (isBinary) throw new Error('音频必须按 PCM16 事件发送');
        const message = JSON.parse(data.toString());
        if (!message || typeof message !== 'object') throw new Error('消息格式无效');
        if (message.type === 'audio.append') {
          if (active?.client !== client || !active.ready) return;
          if (typeof message.audio !== 'string' || message.audio.length > 128000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(message.audio) || message.audio.length % 4 || Buffer.from(message.audio, 'base64').length % 2) throw new Error('音频帧格式无效');
          active.provider.appendAudio(message.audio);
          return;
        }
        // Stop and barge-in must not wait for an upstream connection attempt.
        if (['voice.stop', 'voice.interrupt', 'agent.cancel'].includes(message.type)) {
          if (message.type === 'voice.stop') generation++;
          void handle(message).catch((error) => failure(client, error, 'voice_error', message.voiceSessionId)); return;
        }
        const submittedGeneration = generation;
        controlQueue = controlQueue.then(() => {
          if (message.type !== 'voice.start' || submittedGeneration === generation) return handle(message);
        }).catch((error) => failure(client, error));
      } catch (error) { failure(client, error, 'invalid_message'); }
    });
    client.on('close', () => { generation++; clients.delete(client); stopSession(client); });
    client.on('error', () => { generation++; clients.delete(client); stopSession(client); });
  });

  try {
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', accept); });
  } catch (error) {
    disposed = true;
    unsubscribe();
    wss.close();
    throw error;
  }
  address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/#${capability}`,
    async close() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      stopSession();
      for (const client of clients) client.terminate();
      for (const socket of connections) socket.destroy();
      server.closeAllConnections?.();
      await new Promise((done) => wss.close(done));
      await new Promise((done) => server.close(done));
    },
  };
}
