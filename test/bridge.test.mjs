import assert from "node:assert/strict";
import test from "node:test";
import { createVoiceAgentBridge } from "../src/bridge.ts";

function host() {
	const handlers = new Map();
	const messages = [];
	let idle = true;
	let pending = false;
	let aborts = 0;
	const ctx = {
		cwd: "/test/project",
		model: { provider: "stepfun", id: "step-3.5-flash" },
		sessionManager: { getSessionId: () => "test-session", getSessionName: () => "Voice task" },
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		abort: () => { aborts += 1; },
	};
	const pi = {
		on: (name, handler) => handlers.set(name, handler),
		sendUserMessage: (text, options) => messages.push({ text, options }),
	};
	const controller = createVoiceAgentBridge(pi);
	controller.setContext(ctx);
	return {
		...controller,
		ctx,
		messages,
		get aborts() { return aborts; },
		setIdle(value) { idle = value; },
		setPending(value) { pending = value; },
		async emit(name, event = {}) {
			await handlers.get(name)?.({ type: name, ...event }, ctx);
		},
	};
}

function assistant(text, extra = {}) {
	return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra };
}

test("voice delegates to the existing host agent without expanding slash commands", () => {
	const runtime = host();
	const result = runtime.agent.submit("  /dangerous user text  ");
	assert.match(result.requestId, /^[\da-f-]{36}$/);
	assert.equal(result.queued, false);
	assert.deepEqual(runtime.messages, [{
		text: "/dangerous user text",
		options: { deliverAs: "steer", expandPromptTemplates: false },
	}]);
	assert.deepEqual(runtime.agent.snapshot(), {
		sessionId: "test-session",
		sessionName: "Voice task",
		cwd: "/test/project",
		busy: false,
		pending: false,
		waitingForApproval: false,
		model: "stepfun/step-3.5-flash",
		status: "已发送语音任务",
		lastResponse: "",
	});
});

test("steering and follow-up requests use the host queue during a running task", () => {
	const runtime = host();
	runtime.setIdle(false);
	runtime.setPending(true);
	assert.equal(runtime.agent.submit("Focus on tests").queued, true);
	assert.equal(runtime.agent.submit("Then explain", "followUp").queued, true);
	assert.equal(runtime.messages[0].options.deliverAs, "steer");
	assert.equal(runtime.messages[1].options.deliverAs, "followUp");
	assert.equal(runtime.agent.snapshot().pending, true);
	runtime.agent.cancel();
	assert.equal(runtime.aborts, 1);
	runtime.setIdle(true);
	runtime.agent.cancel();
	assert.equal(runtime.aborts, 1);
});

test("public text and tool names stream while reasoning and tool parameters stay in the host", async () => {
	const runtime = host();
	const events = [];
	const unsubscribe = runtime.agent.subscribe((event) => events.push(event));
	await runtime.emit("agent_start");
	await runtime.emit("message_update", {
		message: assistant("I'll inspect the files.", {
			content: [
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: "I'll inspect the files." },
				{ type: "toolCall", name: "read_file", arguments: { secret: "never forward" } },
			],
		}),
	});
	await runtime.emit("tool_execution_start", { toolCallId: "t1", toolName: "read_file", args: { secret: "never forward" } });
	await runtime.emit("tool_execution_end", { toolCallId: "t1", toolName: "read_file", result: { secret: "never forward" }, isError: false });
	assert.equal(events.find((event) => event.type === "agent.text").text, "I'll inspect the files.");
	assert.equal(events.find((event) => event.type === "agent.tool").toolName, "read_file");
	assert.doesNotMatch(JSON.stringify(events), /private reasoning|never forward|arguments/);
	const count = events.length;
	unsubscribe();
	await runtime.emit("agent_end");
	assert.equal(events.length, count);
});

test("completion waits for host settled state and forwards host permission prompts", async () => {
	const runtime = host();
	const events = [];
	runtime.agent.subscribe((event) => events.push(event));
	runtime.setIdle(false);
	await runtime.emit("agent_start");
	await runtime.emit("ui_prompt_start", { kind: "confirm", title: "Tool permission" });
	assert.equal(runtime.agent.snapshot().waitingForApproval, true);
	assert.match(runtime.agent.snapshot().status, /终端.*权限确认/);
	await runtime.emit("ui_prompt_end", { kind: "confirm" });
	assert.equal(runtime.agent.snapshot().waitingForApproval, false);
	await runtime.emit("message_end", { message: assistant("First attempt finished.") });
	await runtime.emit("agent_end");
	assert.equal(events.filter((event) => event.type === "agent.complete").length, 0);
	// The host may retry or process queued instructions before it settles.
	await runtime.emit("agent_start");
	await runtime.emit("message_end", { message: assistant("The task and follow-up are finished.") });
	await runtime.emit("agent_end");
	runtime.setIdle(true);
	await runtime.emit("agent_settled");
	const complete = events.filter((event) => event.type === "agent.complete");
	assert.equal(complete.length, 1);
	assert.equal(complete[0].text, "The task and follow-up are finished.");
	assert.equal(complete[0].snapshot.busy, false);
});

test("the voice control panel is not reported as an agent approval prompt", async () => {
	const runtime = host();
	runtime.setVoicePanelOpen(true);
	await runtime.emit("ui_prompt_start", { kind: "custom" });
	assert.equal(runtime.agent.snapshot().waitingForApproval, false);
	// The panel yields before the host asks a real tool permission.
	runtime.setVoicePanelOpen(false);
	await runtime.emit("ui_prompt_end", { kind: "custom" });
	await runtime.emit("ui_prompt_start", { kind: "confirm", title: "Tool permission" });
	assert.equal(runtime.agent.snapshot().waitingForApproval, true);
	await runtime.emit("ui_prompt_end", { kind: "confirm" });
	assert.equal(runtime.agent.snapshot().waitingForApproval, false);
});

test("host failure is distinguishable from successful completion", async () => {
	const runtime = host();
	const events = [];
	runtime.agent.subscribe((event) => events.push(event));
	await runtime.emit("agent_start");
	await runtime.emit("message_end", { message: assistant("", { stopReason: "error", errorMessage: "Provider unavailable" }) });
	await runtime.emit("agent_end");
	await runtime.emit("agent_settled");
	assert.equal(events.find((event) => event.type === "agent.error").text, "Provider unavailable");
	assert.equal(events.find((event) => event.type === "agent.complete").isError, true);
});

test("cancelled host run does not report a successful partial response", async () => {
	const runtime = host();
	const events = [];
	runtime.agent.subscribe((event) => events.push(event));
	runtime.setIdle(false);
	await runtime.emit("agent_start");
	runtime.agent.cancel();
	await runtime.emit("message_end", { message: assistant("Partial output", { stopReason: "aborted" }) });
	await runtime.emit("agent_end");
	runtime.setIdle(true);
	await runtime.emit("agent_settled");
	const completion = events.find((event) => event.type === "agent.complete");
	assert.equal(completion.isError, true);
	assert.equal(completion.text, "当前任务已停止。");
	assert.equal(completion.snapshot.status, "当前任务已停止");
});

test("one settled run correlates every queued voice request and emits one completion", async () => {
	const runtime = host();
	const events = [];
	runtime.agent.subscribe((event) => events.push(event));
	const first = runtime.agent.submit("Inspect the project");
	runtime.setIdle(false);
	await runtime.emit("agent_start");
	const second = runtime.agent.submit("Focus on voice integration");
	const third = runtime.agent.submit("Then explain limitations", "followUp");
	await runtime.emit("message_end", { message: assistant("The inspection and requested refinements are complete.") });
	await runtime.emit("agent_end");
	runtime.setIdle(true);
	await runtime.emit("agent_settled");
	const completions = events.filter((event) => event.type === "agent.complete");
	assert.equal(completions.length, 1);
	assert.equal(completions[0].requestId, third.requestId);
	assert.deepEqual(completions[0].requestIds, [first.requestId, second.requestId, third.requestId]);
	// A later terminal-only task must not be attributed to an old voice request.
	await runtime.emit("agent_start");
	await runtime.emit("agent_end");
	await runtime.emit("agent_settled");
	const lastCompletion = events.filter((event) => event.type === "agent.complete").at(-1);
	assert.equal(lastCompletion.requestId, undefined);
	assert.deepEqual(lastCompletion.requestIds, []);
});

test("session replacement clears old voice request associations", async () => {
	const runtime = host();
	const events = [];
	runtime.agent.subscribe((event) => events.push(event));
	runtime.agent.submit("Old session task");
	await runtime.emit("session_start", { reason: "new" });
	await runtime.emit("agent_start");
	await runtime.emit("message_end", { message: assistant("New session result") });
	await runtime.emit("agent_settled");
	const completion = events.find((event) => event.type === "agent.complete");
	assert.equal(completion.requestId, undefined);
	assert.deepEqual(completion.requestIds, []);
});

test("empty, oversized, invalid and unconfigured inputs are rejected before host dispatch", () => {
	const runtime = host();
	assert.throws(() => runtime.agent.submit("  "), /任务/);
	assert.throws(() => runtime.agent.submit("a".repeat(24_001)), /过长/);
	assert.throws(() => runtime.agent.submit("Task", "invalid"), /方式/);
	runtime.ctx.model = undefined;
	assert.throws(() => runtime.agent.submit("Task"), /选择模型/);
	assert.equal(runtime.messages.length, 0);
});

test("disposed bridge rejects further work and stops publishing events", async () => {
	const runtime = host();
	const events = [];
	runtime.agent.subscribe((event) => events.push(event));
	runtime.dispose();
	assert.throws(() => runtime.agent.submit("Task"), /关闭/);
	assert.throws(() => runtime.agent.cancel(), /关闭/);
	assert.throws(() => runtime.agent.subscribe(() => {}), /关闭/);
	await runtime.emit("agent_start");
	assert.equal(events.length, 0);
	assert.equal(runtime.agent.snapshot().status, "语音桥接已关闭");
});
