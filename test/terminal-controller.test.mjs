import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createTerminalVoiceController } from "../src/terminal-controller.ts";

const URL = `http://127.0.0.1:9999/#${"a".repeat(43)}`;
const PCM = Buffer.from([0, 0, 0, 64, 0, 128]).toString("base64");
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function settlesWithin(promise, timeoutMs = 250) {
	let timer;
	try {
		await Promise.race([promise, new Promise((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error("Operation did not settle after cancellation or timeout")), timeoutMs);
		})]);
	} finally { clearTimeout(timer); }
}

function runtime({ keyConfigured = true, agentConnected = true, start = async () => {}, factory, controllerOptions = {} } = {}) {
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
		url: URL, WebSocketImpl: Socket, ...controllerOptions,
		audioFactory: (hooks) => {
			const engine = { hooks, starts: 0, stops: 0, clears: 0, played: [], muted: [],
				async start() { this.starts++; await start(); },
				play(audio, sampleRate) { this.played.push({ audio, sampleRate }); hooks.onPlayback(true); },
				clear() { this.clears++; hooks.onPlayback(false); },
				setMuted(value) { this.muted.push(value); },
				async stop() { this.stops++; hooks.onClosed(); },
			};
			engines.push(engine); return factory ? factory(engine) : engine;
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
	assert.match(r.controller.snapshot().notice.text, /API Key.*引导.*通道.*STEP_API_KEY/);
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

test("realtime voice replies play back, duck the mic without AEC, and fence interrupted responses", async () => {
	const r = runtime(); await r.startReady();
	r.controller.setMuted(true);
	r.emit({ type: "output.audio.delta", responseId: "first", audio: PCM, sampleRate: 24000 });
	assert.deepEqual(r.engines[0].played, [{ audio: PCM, sampleRate: 24000 }]);
	assert.equal(r.controller.snapshot().speaking, true);
	assert.deepEqual(r.engines[0].muted, [true, true]);
	r.controller.interrupt();
	assert.equal(r.messages.at(-1).type, "voice.interrupt");
	assert.equal(r.controller.snapshot().speaking, false);
	r.emit({ type: "output.audio.delta", responseId: "first", audio: PCM });
	assert.equal(r.engines[0].played.length, 1);
	r.emit({ type: "output.audio.delta", responseId: "second", audio: PCM });
	assert.equal(r.engines[0].played.length, 2);
	await r.controller.dispose();
});

test("model speech transcript is display-only and echo-cancel mode keeps the mic open", async () => {
	process.env.STEP_VOICE_ECHO_CANCEL = "1";
	let r;
	try {
		r = runtime(); await r.startReady();
		r.emit({ type: "output.transcript.delta", responseId: "r1", text: "正在" });
		r.emit({ type: "output.transcript.final", responseId: "r1", text: "正在分析代码。" });
		r.emit({ type: "output.audio.delta", responseId: "r1", audio: PCM });
		const lines = r.controller.snapshot().transcripts.filter((entry) => entry.source === "model_audio");
		assert.equal(lines.length, 1);
		assert.equal(lines[0].role, "assistant");
		assert.equal(lines[0].text, "正在分析代码。");
		assert.equal(r.engines[0].played.length, 1);
		assert.equal(r.engines[0].muted.includes(true), false);
	} finally { delete process.env.STEP_VOICE_ECHO_CANCEL; }
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

test("native final is display-only, typed ack echoes once and generated replies stay isolated", async () => {
	const r = runtime(); await r.startReady(); r.controller.sendText("你好");
	assert.equal(r.controller.snapshot().transcripts.length, 0);
	r.emit({ type: "task.accepted", source: "typed_text", requestId: "typed-1", instruction: "你好" });
	r.emit({ type: "task.accepted", source: "typed_text", requestId: "typed-1", instruction: "你好" });
	const audioFinal = { type: "input.transcript.final", source: "user_audio", itemId: "audio-1", contentIndex: 0, text: "语音输入" };
	const sends = r.messages.length;
	r.emit(audioFinal); r.emit(audioFinal);
	assert.equal(r.messages.length, sends, 'controller must never submit native final');
	for (const type of ['response.started', 'output.transcript.delta', 'output.transcript.final', 'output.audio.delta', 'response.done']) {
		r.emit({ type, text: '模型代答', audio: PCM, responseId: 'r1' });
	}
	assert.deepEqual(r.controller.snapshot().transcripts.map(entry => entry.text), ['你好', '语音输入', '模型代答']);
	assert.deepEqual(r.controller.snapshot().transcripts.map(entry => entry.source), ['typed_text', 'user_audio', 'model_audio']);
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
	await r.controller.stop();
	// Cancellation must settle the caller before the original native readiness resolves.
	await settlesWithin(starting);
	resume(); await tick();
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
	assert.equal(r.engines[0].played.length, 0); assert.equal(r.controller.snapshot().notice, undefined);
	await r.controller.dispose();
});

test("Realtime response failures are isolated; native transcription errors remain visible", async () => {
	const r = runtime(); await r.startReady();
	r.emit({ type: "response.started", responseId: "r1" });
	r.emit({ type: "response.done", responseId: "r1", status: "failed", statusDetails: { error: { message: "Model access denied" } } });
	assert.equal(r.controller.snapshot().notice, undefined);
	r.emit({ type: 'error', code: 'transcription_error', message: '语音转写失败，本段未提交' });
	assert.equal(r.controller.snapshot().notice.kind, "error");
	assert.match(r.controller.snapshot().notice.text, /转写失败.*未提交/);
	assert.equal(r.controller.snapshot().voice, "ready");
	await r.controller.dispose();
});

test("new host snapshots clear old preview and failures survive a hidden panel", async () => {
	const r = runtime(); await r.ready();
	r.emit({ type: 'agent.text', text: 'previous result', snapshot: { lastResponse: 'previous result' } });
	r.emit({ type: 'agent.status', snapshot: { lastResponse: '', status: 'Step Code 正在思考' } });
	assert.equal(r.controller.snapshot().lastAgentText, '');
	r.emit({ type: 'agent.text', text: 'first chunk', snapshot: { lastResponse: 'first chunk' } });
	r.emit({ type: 'agent.text', text: 'first chunk, second', snapshot: { lastResponse: 'first chunk, second' } });
	assert.equal(r.controller.snapshot().lastAgentText, 'first chunk, second');
	r.emit({ type: 'agent.text', text: '', snapshot: { lastResponse: '' } });
	assert.equal(r.controller.snapshot().lastAgentText, '');
	r.emit({ type: 'agent.error', text: '未观察到执行，未自动重试', snapshot: { status: '提交失败', lastResponse: '' } });
	assert.match(r.controller.snapshot().notice.text, /未自动重试/);
	assert.equal(r.controller.snapshot().notice.kind, 'error');
	assert.equal(r.engines.length, 0, 'error display must not need microphone');
	await r.controller.dispose();
});

test("cancelled startup releases its caller and permits immediate retry even if native start never resolves", async () => {
	let attempts = 0;
	const r = runtime({ start: () => ++attempts === 1 ? new Promise(() => {}) : Promise.resolve() });
	await r.ready(); const first = r.controller.start(); await tick();
	await r.controller.stop(); await settlesWithin(first);
	assert.equal(r.controller.snapshot().voice, "stopped");
	await settlesWithin(r.controller.start()); r.emit({ type: "voice.state", state: "ready" });
	assert.equal(attempts, 2); assert.equal(r.controller.snapshot().voice, "ready");
	assert.equal(r.messages.filter((message) => message.type === "voice.start").length, 1);
	assert.equal(r.messages.some((message) => message.type === "agent.cancel"), false);
	await r.controller.dispose();
});

test("cancellation during delayed audio factory settles immediately and disposes the late adapter without starting it", async () => {
	let finishFactory;
	const r = runtime({ factory: (engine) => new Promise((resolve) => { finishFactory = () => resolve(engine); }) });
	await r.ready(); const starting = r.controller.start(); await tick();
	assert.equal(r.controller.snapshot().startupPhase, "preparing-audio");
	await r.controller.stop(); await settlesWithin(starting);
	finishFactory(); await tick(); await tick();
	assert.equal(r.engines[0].starts, 0); assert.ok(r.engines[0].stops >= 1);
	assert.equal(r.messages.some((message) => message.type === "voice.start"), false);
	await r.controller.dispose();
});

test("audio factory timeout ends startup and also disposes an adapter that arrives afterward", async () => {
	let finishFactory;
	const r = runtime({ controllerOptions: { audioStartTimeoutMs: 10 }, factory: (engine) => new Promise((resolve) => { finishFactory = () => resolve(engine); }) });
	await r.ready(); await settlesWithin(r.controller.start());
	assert.equal(r.controller.snapshot().voice, "error"); assert.equal(r.controller.snapshot().startupPhase, "error");
	assert.match(r.controller.snapshot().notice.text, /本机音频.*超时/);
	finishFactory(); await tick(); await tick();
	assert.equal(r.engines[0].starts, 0); assert.ok(r.engines[0].stops >= 1);
	await r.controller.dispose();
});

test("permanently pending native readiness times out, closes capture and never claims an upstream session", async () => {
	const r = runtime({ start: () => new Promise(() => {}), controllerOptions: { audioStartTimeoutMs: 10 } });
	await r.ready(); await settlesWithin(r.controller.start());
	assert.equal(r.controller.snapshot().voice, "error"); assert.equal(r.controller.snapshot().startupPhase, "error");
	assert.ok(r.engines[0].stops >= 1); assert.match(r.controller.snapshot().notice.text, /超时/);
	assert.equal(r.messages.some((message) => message.type === "voice.start" || message.type === "agent.cancel"), false);
	await r.controller.dispose();
});

test("missing upstream readiness has a bounded failure transition and closes the microphone without cancelling host work", async () => {
	const r = runtime({ controllerOptions: { modelReadyTimeoutMs: 10 } });
	await r.ready(); await r.controller.start();
	assert.equal(r.controller.snapshot().startupPhase, "connecting-model");
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(r.controller.snapshot().voice, "error"); assert.equal(r.controller.snapshot().startupPhase, "error");
	assert.match(r.controller.snapshot().notice.text, /StepFun.*就绪超时/);
	assert.ok(r.engines[0].stops >= 1);
	assert.ok(r.messages.some((message) => message.type === "voice.stop"));
	assert.equal(r.messages.some((message) => message.type === "agent.cancel"), false);
	await r.controller.dispose();
});

test("native progress distinguishes preparation, microphone permission and model readiness", async () => {
	let finishNative;
	const r = runtime({ start: () => new Promise((resolve) => { finishNative = resolve; }) });
	await r.ready(); const starting = r.controller.start(); await tick();
	r.engines[0].hooks.onStatus("preparing", "正在编译音频助手");
	assert.equal(r.controller.snapshot().startupPhase, "preparing-audio");
	r.engines[0].hooks.onStatus("permission", "等待系统麦克风权限");
	assert.equal(r.controller.snapshot().startupPhase, "opening-microphone");
	r.engines[0].hooks.onStatus("ready"); finishNative(); await starting;
	assert.equal(r.controller.snapshot().startupPhase, "connecting-model");
	assert.equal(r.controller.snapshot().voice, "connecting");
	r.emit({ type: "voice.state", state: "ready" });
	assert.equal(r.controller.snapshot().startupPhase, "ready");
	await r.controller.stop(); assert.equal(r.controller.snapshot().startupPhase, "idle");
	await r.controller.dispose();
});

for (const source of ["server-stopped", "server-error", "native-error", "native-closed"]) {
	test(`late cleanup from ${source} cannot overwrite a newly ready audio generation`, async () => {
		const r = runtime(); await r.startReady();
		let finishOldStop;
		r.engines[0].stop = async () => { r.engines[0].stops++; await new Promise((resolve) => { finishOldStop = resolve; }); };
		if (source === "server-stopped") r.emit({ type: "voice.state", state: "stopped" });
		else if (source === "server-error") r.emit({ type: "voice.state", state: "error" });
		else if (source === "native-error") r.engines[0].hooks.onError(new Error("old engine failed"));
		else r.engines[0].hooks.onClosed();
		await tick(); await r.controller.start(); r.emit({ type: "voice.state", state: "ready" });
		finishOldStop(); await tick();
		assert.equal(r.controller.snapshot().voice, "ready");
		assert.equal(r.controller.snapshot().startupPhase, "ready");
		assert.equal(r.controller.snapshot().notice, undefined);
		await r.controller.dispose();
	});
}

test("playback clear and WebSocket send errors cannot prevent native microphone cleanup", async () => {
	const r = runtime(); await r.startReady();
	r.engines[0].clear = () => { throw new Error("queue overloaded"); };
	const originalSend = r.sockets[0].send.bind(r.sockets[0]);
	r.sockets[0].send = (data) => {
		if (JSON.parse(data).type === "voice.stop") throw new Error("socket write failed");
		originalSend(data);
	};
	await r.controller.stop();
	assert.ok(r.engines[0].stops >= 1);
	assert.equal(r.controller.snapshot().voice, "stopped");
	assert.equal(r.controller.snapshot().startupPhase, "idle");
	assert.match(r.controller.snapshot().notice.text, /queue overloaded.*socket write failed/);
	assert.equal(r.messages.some((message) => message.type === "agent.cancel"), false);
	await r.controller.dispose();
});

test("a stuck third-party native stop is bounded and produces an honest failure state", async () => {
	const r = runtime({ controllerOptions: { audioStopTimeoutMs: 10 } }); await r.startReady();
	r.engines[0].stop = () => new Promise(() => {});
	await settlesWithin(r.controller.stop());
	assert.equal(r.controller.snapshot().voice, "error"); assert.equal(r.controller.snapshot().startupPhase, "error");
	assert.match(r.controller.snapshot().notice.text, /音频.*停止超时/);
	await r.controller.dispose();
});

test("a late ready event after local cancellation cannot claim a live microphone session", async () => {
	const r = runtime(); await r.ready(); await r.controller.start(); await r.controller.stop();
	r.emit({ type: "voice.state", state: "ready" });
	assert.equal(r.controller.snapshot().voice, "stopped"); assert.equal(r.controller.snapshot().startupPhase, "idle");
	await r.controller.dispose();
});

test("cancellation on the microphone-stage update prevents its queued native start from opening capture", async () => {
	const r = runtime(); await r.ready();
	let cancelling;
	const unsubscribe = r.controller.subscribe((snapshot) => {
		if (snapshot.startupPhase === "opening-microphone" && !cancelling) cancelling = r.controller.stop();
	});
	await settlesWithin(r.controller.start()); await cancelling;
	assert.equal(r.engines[0].starts, 0); assert.ok(r.engines[0].stops >= 1);
	assert.equal(r.controller.snapshot().voice, "stopped");
	assert.equal(r.messages.some((message) => message.type === "voice.start"), false);
	unsubscribe(); await r.controller.dispose();
});

test("each explicit start identifies its session and stop retains that identity until restart", async () => {
	const r = runtime(); await r.ready(); await r.controller.start();
	const firstId = r.messages.at(-1).voiceSessionId;
	assert.match(firstId, /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	r.emit({ type: "voice.state", state: "ready", voiceSessionId: firstId });
	await r.controller.stop(); assert.equal(r.messages.at(-1).voiceSessionId, firstId);
	await r.controller.stop(); assert.equal(r.messages.at(-1).voiceSessionId, firstId);
	await r.controller.start();
	const secondId = r.messages.at(-1).voiceSessionId;
	assert.notEqual(secondId, firstId);
	r.emit({ type: "voice.state", state: "ready", voiceSessionId: secondId });
	assert.equal(r.controller.snapshot().voice, "ready");
	assert.equal(r.messages.some((message) => message.type === "agent.cancel"), false);
	await r.controller.dispose();
});

test("late stopped acknowledgements and other frames from an old voice session cannot tear down or contaminate a new session", async () => {
	const r = runtime(); await r.ready(); await r.controller.start();
	const oldId = r.messages.at(-1).voiceSessionId;
	r.emit({ type: "voice.state", state: "ready", voiceSessionId: oldId });
	await r.controller.stop(); await r.controller.start();
	const currentId = r.messages.at(-1).voiceSessionId;
	// The old stop acknowledgement can arrive before the new provider's ready frame as well.
	r.emit({ type: "voice.state", state: "stopped", voiceSessionId: oldId });
	r.emit({ type: "voice.state", state: "ready", voiceSessionId: oldId });
	assert.equal(r.controller.snapshot().voice, "connecting"); assert.equal(r.engines[1].stops, 0);
	r.emit({ type: "voice.state", state: "ready", voiceSessionId: currentId });
	r.emit({ type: "response.started", responseId: "current-response", voiceSessionId: currentId });
	r.emit({ type: "output.transcript.delta", responseId: "current-response", text: "当前回复", voiceSessionId: currentId });
	r.emit({ type: "output.audio.delta", responseId: "current-response", audio: PCM, voiceSessionId: currentId });
	r.emit({ type: 'input.transcript.final', source: 'user_audio', itemId: 'input', contentIndex: 0, text: '当前输入', voiceSessionId: currentId });
	r.engines[1].hooks.onLevel(.6);
	const before = r.controller.snapshot();
	const clearCount = r.engines[1].clears;
	const frames = [
		{ type: "voice.state", state: "stopped" },
		{ type: "voice.state", state: "error" },
		{ type: "voice.state", state: "connecting" },
		{ type: "voice.state", state: "ready" },
		{ type: "speech.start" }, { type: "speech.end" }, { type: "audio.clear" },
		{ type: "response.started", responseId: "old-response" },
		{ type: "input.transcript.final", text: "旧的识别结果" },
		{ type: "output.transcript.delta", responseId: "old-response", text: "旧的字幕" },
		{ type: "output.transcript.final", responseId: "old-response", text: "旧的字幕终稿" },
		{ type: "output.audio.delta", responseId: "old-response", audio: PCM },
		{ type: "response.done", status: "failed", statusDetails: { error: { message: "old failure" } } },
		{ type: "error", message: "old socket failure" }, { type: "closed" },
	];
	for (const frame of frames) {
		r.emit({ ...frame, voiceSessionId: oldId });
		assert.deepEqual(r.controller.snapshot(), before, `stale ${frame.type} must be ignored`);
	}
	await tick();
	assert.equal(r.engines[1].stops, 0); assert.equal(r.engines[1].clears, clearCount);
	assert.equal(r.engines[1].played.length, 1);
	assert.equal(r.controller.snapshot().transcripts.at(-1).text, '当前输入');
	// Matching stop acknowledgements must still close the current capture adapter.
	r.emit({ type: "voice.state", state: "stopped", voiceSessionId: currentId }); await tick();
	assert.equal(r.controller.snapshot().voice, "stopped"); assert.equal(r.engines[1].stops, 1);
	assert.equal(r.messages.some((message) => message.type === "agent.cancel"), false);
	await r.controller.dispose();
});

test("a synchronous restart during the stop snapshot cannot change the identity of the outgoing old stop", async () => {
	const r = runtime(); await r.startReady();
	const oldId = r.messages.find((message) => message.type === "voice.start").voiceSessionId;
	let restarting;
	const unsubscribe = r.controller.subscribe((snapshot) => {
		if (snapshot.startupPhase === "stopping" && !restarting) restarting = r.controller.start();
	});
	await r.controller.stop(); await restarting;
	const stopMessage = r.messages.find((message) => message.type === "voice.stop");
	const newStart = r.messages.filter((message) => message.type === "voice.start").at(-1);
	assert.equal(stopMessage.voiceSessionId, oldId);
	assert.notEqual(newStart.voiceSessionId, oldId);
	r.emit({ type: "voice.state", state: "ready", voiceSessionId: newStart.voiceSessionId });
	assert.equal(r.controller.snapshot().voice, "ready");
	unsubscribe(); await r.controller.dispose();
});
