/** Orders native final transcripts by audio item arrival, not ASR completion.
 * Keep tombstones for the session: evicting one would permit replay execution.
 */
export class TranscriptionQueue {
  constructor({ submit, fail, display, stop, timeoutMs = 15000, speechTimeoutMs = 120000, maxItems = 2048, maxPending = 32 }) {
    Object.assign(this, { submit, fail, display, stop, timeoutMs, speechTimeoutMs, maxItems, maxPending });
    this.items = new Map();
    this.pending = [];
    this.closed = false;
  }

  fatal(message) {
    this.fail(message);
    this.close();
    this.stop();
  }

  arm(item, timeout) {
    clearTimeout(item.timer);
    item.timer = setTimeout(() => {
      if (this.closed || item.done || item.ready) return;
      item.ready = true;
      this.fail('语音转写超时，本段未提交。请检查网络；确认主终端无此任务后再重说。');
      this.flush();
    }, timeout);
    item.timer.unref?.();
  }

  receive(event) {
    if (this.closed) return;
    if (typeof event.itemId !== 'string' || !event.itemId || event.itemId.length > 200) {
      this.fatal('语音事件缺少有效输入项 ID，未提交。已停止语音，请重新开始。');
      return;
    }
    let item = this.items.get(event.itemId);
    if (!item) {
      if (this.items.size >= this.maxItems || this.pending.length >= this.maxPending) {
        this.fatal('语音转写积压或会话过长，未提交的音频已丢弃。请重新开始语音。');
        return;
      }
      item = { id: event.itemId, ready: false, done: false };
      this.items.set(item.id, item);
      this.pending.push(item);
      this.arm(item, event.type === 'speech.start' ? this.speechTimeoutMs : this.timeoutMs);
    }
    if (item.done || item.ready) return;
    if (event.type === 'speech.end' || event.type === 'input.committed') {
      // Duplicate end/commit events must not postpone the deadline indefinitely.
      if (!item.ended) { item.ended = true; this.arm(item, this.timeoutMs); }
      return;
    }
    if (event.type === 'speech.start') return;
    item.ready = true;
    clearTimeout(item.timer);
    if (event.type === 'input.transcript.failed') {
      this.fail(`语音转写失败，本段未提交：${event.message || '请检查语音服务。'}`);
    } else if (event.source !== 'user_audio' || !Number.isInteger(event.contentIndex) || event.contentIndex < 0 || event.contentIndex > 1024) {
      this.fail('语音转写缺少有效内容索引或来源，本段未提交。');
    } else if (typeof event.text !== 'string' || !event.text.trim() || event.text.length > 12000) {
      this.fail('语音转写为空或超过 12000 字，本段未提交。');
    } else {
      // A server_vad item represents one committed audio segment. Its first
      // terminal result seals that item (including its content index).
      item.event = event;
      this.display(event);
    }
    this.flush();
  }

  flush() {
    while (!this.closed && this.pending[0]?.ready) {
      const item = this.pending.shift();
      item.done = true;
      clearTimeout(item.timer);
      const event = item.event;
      delete item.event;
      if (!event) continue;
      // Mark done BEFORE calling the host; a throwing dispatch may already have
      // accepted work, so neither a replay nor a reconnect can retry this item.
      try { this.submit(event); }
      catch (error) { this.fail(`提交 Step Code 失败或结果不确定，未自动重试：${error?.message || error}。请先核对主终端。`); }
    }
  }

  close() {
    this.closed = true;
    for (const item of this.pending) clearTimeout(item.timer);
    this.pending.length = 0;
    this.items.clear();
  }
}
