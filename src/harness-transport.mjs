import { EventEmitter } from 'node:events';

/** In-process UI transport. It adapts existing controls, but never orders transcripts or starts an agent. */
export class HarnessVoiceTransport extends EventEmitter {
  constructor({ voice, runtime, agent }) {
    super();
    if (voice.protocolVersion !== 1) throw new Error('宿主语音协议版本不兼容。');
    this.voice = voice;
    this.runtime = runtime;
    this.agent = agent;
    this.readyState = 0;
    this.generation = 0;
    this.controlQueue = Promise.resolve();
    this.unsubscribers = [];
  }

  open() {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.unsubscribers.push(this.voice.subscribe(({ event, voiceSessionId }) => {
      if (event.type === 'task.rejected') {
        this.push({ type: 'error', code: 'voice_task_rejected', message: event.message, voiceSessionId });
      } else if (event.type === 'task.discarded') {
        this.push({ type: 'notice', message: event.message, voiceSessionId });
      } else if (event.type === 'voice.state') {
        this.push({ ...event, state: event.state === 'stopping' ? 'stopped' : event.state, voiceSessionId });
      } else {
        this.push({ ...event, voiceSessionId });
      }
    }));
    this.unsubscribers.push(this.agent.subscribe(event => this.push(event)));
    queueMicrotask(() => {
      if (this.readyState !== 1) return;
      try { this.push({ type: 'server.ready', config: this.runtime.publicConfig(), settings: this.runtime.settings,
        agent: this.agent.snapshot(), agentConnected: true }); }
      catch (error) { this.emit('error', error); }
    });
  }

  push(event) {
    if (this.readyState === 1) this.emit('message', Buffer.from(JSON.stringify(this.runtime.sanitizeEvent(event))));
  }

  report(error, voiceSessionId) {
    this.push({ type: 'error', code: 'voice_error', message: error instanceof Error ? error.message : '语音操作失败。', voiceSessionId });
  }

  send(data) {
    if (this.readyState !== 1) throw new Error('宿主语音连接已关闭。');
    const message = JSON.parse(data);
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('语音消息格式无效。');
    if (message.type === 'voice.stop') this.generation++;
    if (['voice.stop', 'voice.interrupt', 'voice.mute', 'agent.cancel', 'audio.append'].includes(message.type)) {
      void this.handle(message).catch(error => this.report(error, message.voiceSessionId));
      return;
    }
    const generation = this.generation;
    this.controlQueue = this.controlQueue.then(() => {
      if (this.readyState !== 1 || (message.type === 'voice.start' && generation !== this.generation)) return;
      return this.handle(message);
    }).catch(error => this.report(error, message.voiceSessionId));
  }

  assertSettingsAvailable() {
    if (['connecting', 'ready', 'stopping'].includes(this.voice.snapshot().state)) throw new Error('请先结束语音通话，再修改接入设置。');
  }

  async handle(message) {
    switch (message.type) {
      case 'voice.start':
        this.voiceSessionId = message.voiceSessionId;
        await this.voice.start({ providerId: this.runtime.provider.id, voiceSessionId: message.voiceSessionId, muted: message.muted });
        break;
      case 'voice.stop': {
        const id = message.voiceSessionId ?? this.voiceSessionId;
        if (id && this.voice.snapshot().voiceSessionId === id) await this.voice.stop(id);
        break;
      }
      case 'voice.interrupt':
        if (this.voiceSessionId && this.voice.snapshot().state === 'ready') this.voice.interrupt(this.voiceSessionId);
        break;
      case 'voice.mute':
        if (message.voiceSessionId === this.voice.snapshot().voiceSessionId && ['connecting', 'ready'].includes(this.voice.snapshot().state)) {
          this.voice.setMuted(message.voiceSessionId, message.muted);
        }
        break;
      case 'audio.append':
        this.voice.appendAudio(this.voiceSessionId, { data: message.audio, sampleRate: 24000, numChannels: 1 });
        break;
      case 'agent.cancel': this.agent.cancel(); break;
      case 'agent.submit':
      case 'input.text': {
        const result = this.agent.submit(message.text, message.delivery === 'steer' ? 'steer' : 'followUp');
        this.push({ type: 'task.accepted', ...result, instruction: message.text, source: 'typed_text' });
        break;
      }
      case 'config.update':
        this.assertSettingsAvailable();
        this.runtime.updateConfig(message.config);
        this.push({ type: 'config.saved', config: this.runtime.publicConfig(), settings: this.runtime.settings });
        break;
      case 'credentials.save': {
        this.assertSettingsAvailable();
        this.push({ type: 'credentials.checking' });
        const result = await this.runtime.saveCredentials(message.channel, message.apiKey, message.useEnvKey);
        this.push(result.ok ? { type: 'credentials.saved', config: this.runtime.publicConfig(), file: result.file }
          : { type: 'credentials.invalid', message: result.message });
        break;
      }
      case 'credentials.clear':
        this.assertSettingsAvailable();
        this.runtime.clearCredentials();
        this.push({ type: 'credentials.saved', config: this.runtime.publicConfig(), cleared: true });
        break;
      case 'ping': this.push({ type: 'pong' }); break;
      default: throw new Error('不支持的语音消息类型。');
    }
  }

  close() {
    void this.dispose().catch(() => { /* The plugin resource owner also awaits dispose() and reports failures. */ });
  }

  dispose() {
    if (this.closing) return this.closing;
    this.readyState = 3;
    this.generation++;
    this.runtime.cancelSetup();
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.closing = (async () => {
      try {
        if (this.voiceSessionId && this.voice.snapshot().voiceSessionId === this.voiceSessionId) {
          await this.voice.stop(this.voiceSessionId);
        }
      } finally {
        this.emit('close');
        this.removeAllListeners();
      }
    })();
    return this.closing;
  }
}
