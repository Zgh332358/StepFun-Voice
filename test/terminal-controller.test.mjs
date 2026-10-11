import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createTerminalVoiceController } from "../src/terminal-controller.ts";

const URL = `http://127.0.0.1:9999/#${"a".repeat(43)}`;
const PCM = Buffer.from([0, 0, 0, 64, 0, 128]).toString("base64");
const tick = () => new Promise((resolve) => setImmediate(resolve));

function runtime({ keyConfigured = true, agentConnected = true, start = async () => {} } = {}) {
	const sockets = [];
	const engines = [];
	class Socket extends EventEmitter {
		readyState = 1;
		messages = [];
		constructor(url, protocols, options) { super(); this.url = url; this.protocols = protocols; this.options = options; sockets.push(this); }
		send(data) { this.messages.push(JSON.parse(data)); }
		close() { this.readyState = 3; this.emit("close"); }
	}
	const controller = createTerminalVoiceController({
		url: URL, WebSocketImpl: Socket,
		audioFactory: (hooks) => {
			const engine = { hooks, starts: 0, stops: 0, clears: 0, played: [], muted: [],
				async start() { this.starts++; await start(); },
				play(audio, sampleRate) { this.played.push({ audio, sampleRate }); hooks.onPlayback(true); },
				clear() { this.clears++; hooks.onPlayback(false); },
				setMuted(value) { this.muted.push(value); },
				async stop() { this.stops++; hooks.onClosed(); },
			};
			engines.push(engine); return engine;
		},
	});
	const emit = (event) => sockets[0].emit("message", Buffer.from(JSON.stringify(event)));
	const ready = async () => {
		const connected = controller.connect();
		emit({ type: "server.ready", config: { keyConfigured, realtimeModel: "stepaudio-3-realtime-preview", ttsModel: "stepaudio-3-tts", voice: "linjiajiejie" }, agentConnected,
			agent: { sessionId: "task-session", cwd: "/example", busy: false, pending: false, waitingForApproval: false, status: "等待任务", lastResponse: "" } });
		await connected;
	};
	const startReady = async () => { await ready(); await controller.start(); emit({ type: "voice.state", state: "ready" }); };
	return { controller, sockets, engines, emit, ready, startReady, get messages() { return sockets[0].messages; } };
}

test("local connection authenticates with token subprotocol and correct Origin without opening microphone", async () => {
	const r = runtime(); await r.ready();
	assert.equal(r.sockets[0].url, "ws://127.0.0.1:9999/ws");
	assert.deepEqual(r.sockets[0].protocols, ["step-voice", "a".repeat(43)]);
	assert.equal(r.sockets[0].options.headers.Origin, "http://127.0.0.1:9999");
	assert.equal(r.engines.length, 0); assert.equal(r.controller.snapshot().voice, "stopped");
	await r.controller.dispose();
});

test("missing environment Key displays exact setup instruction and never starts native capture", async () => {
	const r = runtime({ keyConfigured: false }); await r.ready(); await r.controller.start();
	assert.equal(r.engines.length, 0);
	assert.match(r.controller.snapshot().notice.text, /STEP_API_KEY.*STEPFUN_API_KEY.*重新启动/);
	assert.equal(r.messages.some((message) => message.type === "voice.start"), false);
	await r.controller.dispose();
});

test("explicit start captures mono PCM frames only while upstream ready and microphone unmuted", async () => {
	const r = runtime(); await r.ready(); await r.controller.start();
	assert.equal(r.engines[0].starts, 1);
	r.engines[0].hooks.onAudio(PCM);
	assert.equal(r.messages.some((message) => message.type === "audio.append"), false);
	r.emit({ type: "voice.state", state: "ready" });
	r.engines[0].hooks.onAudio(PCM);
	assert.deepEqual(r.messages.at(-1), { type: "audio.append", audio: PCM });
	r.controller.mute(); r.engines[0].hooks.onAudio(PCM); r.engines[0].hooks.onLevel(.8);
	assert.equal(r.messages.filter((message) => message.type === "audio.append").length, 1);
	assert.equal(r.controller.snapshot().micLevel, 0); assert.equal(r.controller.snapshot().muted, true);
	r.controller.setMuted(false); r.engines[0].hooks.onAudio(PCM);
	assert.equal(r.messages.filter((message) => message.type === "audio.append").length, 2);
	await r.controller.dispose(); assert.ok(r.engines[0].stops >= 1);
});

test("mute continues speaker playback; interrupt clears native queue and rejects late response audio", async () => {
	const r = runtime(); await r.startReady();
	r.emit({ type: "response.started", responseId: "first" });
	r.controller.setMuted(true);
	r.emit({ type: "output.audio.delta", responseId: "first", audio: PCM, sampleRate: 48000 });
	assert.deepEqual(r.engines[0].played, [{ audio: PCM, sampleRate: 48000 }]);
	r.controller.interrupt();
	assert.equal(r.messages.at(-1).type, "voice.interrupt");
	assert.equal(r.controller.snapshot().speaking, false);
	r.emit({ type: "output.audio.delta", responseId: "first", audio: PCM, sampleRate: 24000 });
	r.emit({ type: "output.audio.delta", audio: PCM, sampleRate: 24000 });
	assert.equal(r.engines[0].played.length, 1);
	r.emit({ type: "response.started", responseId: "second" });
	r.emit({ type: "output.audio.delta", responseId: "second", audio: PCM, sampleRate: 24000 });
	assert.equal(r.engines[0].played.length, 2);
	assert.ok(r.engines[0].clears >= 1);
	await r.controller.dispose();
});

test("automatic speech barge-in clears playback without cancelling the background task", async () => {
	const r = runtime(); await r.startReady();
	r.emit({ type: "response.started", responseId: "first" });
	r.emit({ type: "output.audio.delta", responseId: "first", audio: PCM });
	r.emit({ type: "speech.start" });
	assert.equal(r.controller.snapshot().speaking, false);
	assert.equal(r.messages.some((message) => message.type === "agent.cancel"), false);
	await r.controller.dispose();
});

test("text is echoed once by server; streamed subtitles settle and TTS starts a fresh response", async () => {
	const r = runtime(); await r.startReady(); r.controller.sendText("你好");
	assert.equal(r.controller.snapshot().transcripts.length, 0);
	r.emit({ type: "input.transcript.final", text: "你好" });
	r.emit({ type: "response.started", responseId: "r1" });
	r.emit({ type: "output.transcript.delta", itemId: "i1", responseId: "r1", text: "你好，" });
	r.emit({ type: "output.transcript.delta", itemId: "i1", responseId: "r1", text: "我在听。" });
	r.emit({ type: "output.transcript.final", itemId: "i1", responseId: "r1", text: "你好，我在听。" });
	r.emit({ type: "response.done", responseId: "r1" });
	assert.deepEqual(r.controller.snapshot().transcripts.map((entry) => entry.text), ["你好", "你好，我在听。"]);
	r.emit({ type: "audio.clear" });
	r.emit({ type: "response.started", responseId: "task-1", source: "tts" });
	r.emit({ type: "output.transcript.final", responseId: "task-1", itemId: "task-1", text: "任务已完成", source: "tts" });
	r.emit({ type: "output.audio.delta", responseId: "task-1", audio: PCM, source: "tts" });
	assert.equal(r.controller.snapshot().transcripts.at(-1).source, "tts");
	assert.equal(r.engines[0].played.length, 1);
	await r.controller.dispose();
});

test("background tasks preserve delivery and expose host permission state and cumulative output", async () => {
	const r = runtime(); await r.ready();
	r.controller.submitTask("检查插件", "followUp");
	assert.deepEqual(r.messages.at(-1), { type: "agent.submit", text: "检查插件", delivery: "followUp" });
	r.emit({ type: "task.accepted", requestId: "task-1", queued: true });
	r.emit({ type: "agent.status", snapshot: { sessionId: "task-session", cwd: "/example", busy: true, pending: true, waitingForApproval: true, status: "请在终端确认", lastResponse: "" } });
	assert.equal(r.controller.snapshot().agent.waitingForApproval, true);
	r.emit({ type: "agent.text", text: "正在检查", snapshot: { busy: true, waitingForApproval: false, lastResponse: "正在检查" } });
	r.emit({ type: "agent.text", text: "正在检查，发现问题", snapshot: { busy: true, lastResponse: "正在检查，发现问题" } });
	assert.equal(r.controller.snapshot().lastAgentText, "正在检查，发现问题");
	r.controller.cancelTask(); assert.equal(r.messages.at(-1).type, "agent.cancel");
	r.emit({ type: "agent.complete", text: "当前任务已停止。", isError: true, snapshot: { busy: false, lastResponse: "" } });
	assert.equal(r.controller.snapshot().activity.at(-1).kind, "error");
	await r.controller.dispose();
});

test("configuration reads supplied environment only; public state never contains credentials", async () => {
	const r = runtime({ keyConfigured: false }); await r.ready();
	r.controller.reloadConfigFromEnvironment({ STEP_API_KEY: "session-key", STEP_VOICE_TTS_MODEL: "stepaudio-3-tts" });
	assert.deepEqual(r.messages.at(-1), { type: "config.update", config: { apiKey: "session-key", ttsModel: "stepaudio-3-tts" } });
	r.emit({ type: "config.saved", config: { keyConfigured: true, apiKey: "must-not-leak", ttsModel: "stepaudio-3-tts" } });
	assert.equal(r.controller.snapshot().config.keyConfigured, true);
	assert.doesNotMatch(JSON.stringify(r.controller.snapshot()), /must-not-leak|session-key|apiKey/);
	await r.controller.start(); r.emit({ type: "voice.state", state: "ready" });
	assert.throws(() => r.controller.reloadConfigFromEnvironment({}), /结束/);
	await r.controller.dispose();
});

test("stop during pending native permission prevents a late voice.start and tears down capture", async () => {
	let resume;
	const r = runtime({ start: () => new Promise((resolve) => { resume = resolve; }) });
	await r.ready(); const starting = r.controller.start(); await tick();
	await r.controller.stop(); resume(); await starting;
	assert.equal(r.messages.some((message) => message.type === "voice.start"), false);
	assert.ok(r.engines[0].stops >= 1);
	assert.equal(r.controller.snapshot().voice, "stopped");
	await r.controller.dispose();
});

test("old native callbacks cannot contaminate a newly started session", async () => {
	const r = runtime(); await r.startReady(); const old = r.engines[0];
	await r.controller.stop(); await r.controller.start(); r.emit({ type: "voice.state", state: "ready" });
	const count = r.messages.length;
	old.hooks.onAudio(PCM); old.hooks.onLevel(1); old.hooks.onError(new Error("late error")); old.hooks.onClosed();
	assert.equal(r.messages.length, count); assert.equal(r.controller.snapshot().voice, "ready");
	assert.equal(r.controller.snapshot().micLevel, 0);
	await r.controller.dispose();
});

test("connection loss closes native audio and does not claim a live voice connection", async () => {
	const r = runtime(); await r.startReady(); r.sockets[0].close(); await tick();
	assert.equal(r.controller.snapshot().connection, "disconnected");
	assert.equal(r.controller.snapshot().voice, "stopped");
	assert.ok(r.engines[0].stops >= 1);
	assert.match(r.controller.snapshot().notice.text, /服务已关闭/);
	await r.controller.dispose();
});

test("invalid PCM packets are rejected before native playback", async () => {
	const r = runtime(); await r.startReady();
	r.emit({ type: "response.started", responseId: "r1" });
	r.emit({ type: "output.audio.delta", responseId: "r1", audio: Buffer.from([1]).toString("base64") });
	assert.equal(r.engines[0].played.length, 0); assert.match(r.controller.snapshot().notice.text, /PCM16/);
	await r.controller.dispose();
});

test("failed response termination exposes provider diagnosis without a separate error event", async () => {
	const r = runtime(); await r.startReady();
	r.emit({ type: "response.started", responseId: "r1" });
	r.emit({ type: "response.done", responseId: "r1", status: "failed", statusDetails: { error: { message: "Model access denied" } } });
	assert.equal(r.controller.snapshot().notice.kind, "error");
	assert.match(r.controller.snapshot().notice.text, /Model access denied/);
	assert.equal(r.controller.snapshot().voice, "ready");
	await r.controller.dispose();
});

test("late cancellation of an old response cannot split the new streaming transcript", async () => {
	const r = runtime(); await r.startReady();
	r.emit({ type: "response.started", responseId: "old" }); r.controller.interrupt();
	r.emit({ type: "response.started", responseId: "new" });
	r.emit({ type: "output.transcript.delta", responseId: "new", text: "新的" });
	r.emit({ type: "response.done", responseId: "old", status: "cancelled" });
	r.emit({ type: "output.transcript.delta", responseId: "new", text: "回复" });
	assert.equal(r.controller.snapshot().transcripts.length, 1);
	assert.equal(r.controller.snapshot().transcripts[0].text, "新的回复");
	assert.equal(r.controller.snapshot().transcripts[0].final, false);
	await r.controller.dispose();
});
