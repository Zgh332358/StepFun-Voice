import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createTerminalVoiceController } from "../src/terminal-controller.ts";

// The source checkout exposes the same TUI module through the extension loader.
// Installed hosts resolve the peer normally; source tests use its actual source.
const workspaceTui = process.env.STEP_CODE_SOURCE
	? pathToFileURL(resolve(process.env.STEP_CODE_SOURCE, "packages/tui/src/index.ts"))
	: new URL("../../../packages/tui/src/index.ts", import.meta.url);
if (process.env.STEP_CODE_SOURCE && !existsSync(workspaceTui)) {
	throw new Error("STEP_CODE_SOURCE must point to a Step Code source checkout with packages/tui/src/index.ts and installed dependencies.");
}
if (existsSync(workspaceTui)) registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@step-harness/pi-tui") return { url: workspaceTui.href, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
let TerminalVoicePanel, voiceWidgetLines;
try {
	({ TerminalVoicePanel, voiceWidgetLines } = await import("../src/terminal-ui.ts"));
} catch (error) {
	if (error.code === "ERR_MODULE_NOT_FOUND" && String(error.message).includes("@step-harness/pi-tui")) {
		throw new Error("Terminal UI tests need the host TUI module. Run STEP_CODE_SOURCE=/path/to/Step-Code npm test with an installed Step Code source checkout.", { cause: error });
	}
	throw error;
}
const { visibleWidth } = await import("@step-harness/pi-tui");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const theme = { fg: (_color, text) => text, bold: (text) => text };

function runtime({ keyConfigured = true, start = async () => {} } = {}) {
	const state = {
		connection: "connected", voice: "stopped", muted: false, micLevel: 0, speaking: false,
		config: { baseUrl: "https://api.stepfun.com/v1", realtimeModel: "stepaudio-3-realtime-preview", ttsModel: "stepaudio-3-tts", voice: "linjiajiejie", keyConfigured },
		agentConnected: true, transcripts: [], activity: [], lastAgentText: "",
	};
	const agent = { sessionId: "session", cwd: "/example", busy: false, pending: false, waitingForApproval: false, status: "等待任务", lastResponse: "" };
	const listeners = new Set();
	const calls = { start: 0, stop: 0, mute: 0, interrupt: 0, cancel: 0, unsubscribed: 0, text: [], tasks: [], done: [], renders: 0 };
	const update = () => { for (const listener of listeners) listener(state); };
	const controller = {
		snapshot: () => state,
		subscribe(listener) { listeners.add(listener); listener(state); return () => { listeners.delete(listener); calls.unsubscribed++; }; },
		async start() { calls.start++; state.voice = "connecting"; update(); await start(); },
		async stop() { calls.stop++; state.voice = "stopped"; update(); },
		mute() { calls.mute++; state.muted = !state.muted; update(); },
		interrupt() { calls.interrupt++; state.speaking = false; update(); },
		cancelTask() { calls.cancel++; },
		sendText(text) { calls.text.push(text); },
		submitTask(text, delivery) { calls.tasks.push({ text, delivery }); },
		reloadConfigFromEnvironment() {},
	};
	const panel = new TerminalVoicePanel({ terminal: { rows: 48 }, requestRender() { calls.renders++; } }, theme, controller, () => agent, (result) => calls.done.push(result));
	return { panel, state, agent, calls, update };
}

test("starting without a Key opens readable environment setup before invoking native capture", () => {
	const r = runtime({ keyConfigured: false });
	try {
		r.panel.handleInput("\r");
		const content = r.panel.render(104).join("\n");
		assert.match(content, /export STEP_API_KEY=/);
		assert.match(content, /STEPFUN_API_KEY.*重新启动/);
		assert.match(content, /Step Plan.*独立/);
		assert.match(content, /尚未配置/);
		assert.equal(r.calls.start, 0);
	} finally { r.panel.dispose(); }
});

test("microphone startup remains cancellable while native permission or compilation is pending", async () => {
	let resume;
	const r = runtime({ start: () => new Promise((resolve) => { resume = resolve; }) });
	try {
		r.panel.handleInput("\r"); await tick();
		assert.equal(r.state.voice, "connecting");
		for (const key of ["m", "i", "c", "\r"]) r.panel.handleInput(key);
		await tick();
		assert.equal(r.calls.stop, 1);
		assert.equal(r.calls.mute, 1); assert.equal(r.calls.interrupt, 1); assert.equal(r.calls.cancel, 1);
		assert.equal(r.state.voice, "stopped");
		resume(); await tick();
		// A new pending startup also allows Q to end and dismiss immediately.
		r.panel.handleInput("\r"); await tick();
		r.panel.handleInput("q"); await tick();
		assert.equal(r.calls.stop, 2); assert.deepEqual(r.calls.done, ["end"]);
		resume(); await tick();
	} finally { resume?.(); r.panel.dispose(); }
});

test("Escape yields the terminal without ending the call and disposal detaches updates", () => {
	const r = runtime();
	r.state.voice = "ready"; r.update();
	r.panel.handleInput("\x1b");
	assert.deepEqual(r.calls.done, ["hide"]); assert.equal(r.calls.stop, 0);
	const renders = r.calls.renders;
	r.update(); assert.equal(r.calls.renders, renders);
	r.panel.dispose(); assert.equal(r.calls.unsubscribed, 1);
	assert.match(voiceWidgetLines(r.state, { ...r.agent, busy: true, status: "正在执行检查" }, theme).join("\n"), /正在聆听.*\n.*后台工作.*在线/);
});

test("public transcript rendering handles Chinese widths and removes injected terminal sequences", () => {
	const r = runtime();
	try {
		r.state.transcripts.push({ id: "one", role: "assistant", text: "\x1b]0;injected-title\x07你好，公开回复。".repeat(15), final: true });
		r.agent.lastResponse = "\x1b[31m中文任务回复，已经处理完成。".repeat(12);
		for (const width of [24, 48, 96]) {
			const lines = r.panel.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `overflow at ${width}`);
			assert.doesNotMatch(lines.join("\n"), /injected-title|\x1b\]0;|\x1b\[31m/);
		}
	} finally { r.panel.dispose(); }
});

test("the microphone meter uses captured input level rather than assistant playback", () => {
	const r = runtime();
	try {
		r.state.voice = "ready"; r.state.speaking = true; r.state.micLevel = 0;
		assert.match(r.panel.render(96).join("\n"), /麦克风.*0%/);
		r.state.micLevel = .7;
		assert.match(r.panel.render(96).join("\n"), /麦克风.*70%/);
		r.state.muted = true;
		assert.match(r.panel.render(96).join("\n"), /麦克风.*0%/);
	} finally { r.panel.dispose(); }
});

test("typed tasks preserve an explicit follow-up delivery choice through the native panel", async () => {
	const r = runtime();
	try {
		r.panel.handleInput("g"); r.panel.handleInput("\t");
		r.panel.handleInput("检查语音插件"); r.panel.handleInput("\r"); await tick();
		assert.deepEqual(r.calls.tasks, [{ text: "检查语音插件", delivery: "followUp" }]);
		assert.deepEqual(r.calls.text, []);
	} finally { r.panel.dispose(); }
});

test("real controller cancellation releases the panel for repeated starts while native startup never settles", async () => {
	let socket;
	let starts = 0;
	const messages = [];
	class Socket extends EventEmitter {
		readyState = 1;
		constructor() { super(); socket = this; }
		send(raw) { messages.push(JSON.parse(raw)); }
		close() { this.readyState = 3; this.emit("close"); }
	}
	const controller = createTerminalVoiceController({
		url: `http://127.0.0.1:9999/#${"a".repeat(43)}`, WebSocketImpl: Socket,
		audioFactory: () => ({ start: () => { starts++; return new Promise(() => {}); }, stop: async () => {}, clear() {}, setMuted() {}, play() {} }),
	});
	const connected = controller.connect();
	socket.emit("message", JSON.stringify({ type: "server.ready", config: { keyConfigured: true } }));
	await connected;
	const agent = { sessionId: "session", cwd: "/example", busy: true, pending: false, waitingForApproval: false, status: "后台检查", lastResponse: "" };
	const panel = new TerminalVoicePanel({ terminal: { rows: 48 }, requestRender() {} }, theme, controller, () => agent, () => {});
	try {
		for (let i = 0; i < 10; i++) {
			panel.handleInput("\r"); await tick();
			assert.equal(starts, i + 1);
			panel.handleInput("\r"); await tick(); await tick();
			assert.equal(controller.snapshot().voice, "stopped");
			assert.doesNotMatch(panel.render(104).join("\n"), /正在处理/);
		}
		assert.equal(messages.some(event => event.type === "agent.cancel"), false);
	} finally { panel.dispose(); await controller.dispose(); }
});

test("startup labels identify native preparation, microphone permission and model connection", () => {
	const r = runtime();
	try {
		r.state.voice = "connecting";
		for (const [phase, expected] of [["preparing-audio", /准备本地音频助手/], ["opening-microphone", /打开麦克风.*系统权限/], ["connecting-model", /连接 StepFun 语音模型/]]) {
			r.state.startupPhase = phase; r.update();
			assert.match(r.panel.render(104).join("\n"), expected);
		}
		assert.match(r.panel.render(104).join("\n"), /Step Code.*等待任务/);
	} finally { r.panel.dispose(); }
});
