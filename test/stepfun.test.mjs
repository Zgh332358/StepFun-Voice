import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
	createRealtimeSession,
	loadStepFunConfig,
	normalizeRealtimeEvent,
	readSseEvents,
	sanitizeProviderError,
	StepFunRealtimeClient,
	synthesizeSpeech,
	transcribeAudio,
} from "../src/stepfun.mjs";

const config = () => loadStepFunConfig({ STEP_API_KEY: "test-key-never-real" });

class FakeWebSocket extends EventEmitter {
	constructor(url, options) {
		super();
		this.url = url;
		this.options = options;
		this.readyState = 0;
		this.sent = [];
	}
	open() {
		this.readyState = 1;
		this.emit("open");
	}
	send(message) {
		this.sent.push(JSON.parse(message));
	}
	receive(event) {
		this.emit("message", Buffer.from(JSON.stringify(event)));
	}
	close(code = 1000) {
		this.readyState = 3;
		this.emit("close", code);
	}
	terminate() {
		this.close(1006);
	}
}

async function connected(options = {}) {
	const events = [];
	const client = new StepFunRealtimeClient(config(), {
		WebSocketImpl: FakeWebSocket,
		onEvent: (event) => events.push(event),
		...options,
	});
	const ready = client.connect();
	client.socket.open();
	client.socket.receive({ type: "session.created", session: { id: "s1" } });
	client.socket.receive({ type: "session.updated", session: { id: "s1" } });
	await ready;
	return { client, events, socket: client.socket };
}

function sseResponse(events, { fragmentSize = 3, status = 200 } = {}) {
	const encoded = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""));
	return new Response(
		new ReadableStream({
			start(controller) {
				for (let i = 0; i < encoded.length; i += fragmentSize) controller.enqueue(encoded.slice(i, i + fragmentSize));
				controller.close();
			},
		}),
		{ status, headers: { "Content-Type": "text/event-stream" } },
	);
}

function openSseResponse(t, content) {
	let streamController;
	let canceled = 0;
	const body = new ReadableStream({
		start(controller) {
			streamController = controller;
			if (content) controller.enqueue(new TextEncoder().encode(content));
		},
		cancel() { canceled++; },
	});
	t.after(() => { try { streamController.close(); } catch { /* Already canceled. */ } });
	return { response: new Response(body), body, enqueue: (text) => streamController.enqueue(new TextEncoder().encode(text)), canceled: () => canceled };
}

test("config uses StepFun models, explicit key precedence and mono 24 kHz realtime", () => {
	const result = loadStepFunConfig({ STEP_API_KEY: "preferred", STEPFUN_API_KEY: "secondary" });
	assert.equal(result.apiKey, "preferred");
	assert.equal(result.realtimeModel, "stepaudio-3-realtime-preview");
	assert.equal(result.ttsModel, "stepaudio-3-tts");
	assert.equal(result.asrModel, "stepaudio-3-asr-max");
	assert.equal(result.inputSampleRate, 24_000);
	assert.equal(result.outputSampleRate, 24_000);
	assert.throws(() => loadStepFunConfig({ STEP_VOICE_REALTIME_MODEL: "gpt-realtime" }), /StepFun/);
	assert.throws(() => loadStepFunConfig({ STEP_VOICE_BASE_URL: "https://example.com/v1" }), /StepFun/);
});

test("session schema matches StepFun nested function API and does not add undocumented format fields", () => {
	const session = createRealtimeSession(config());
	assert.deepEqual(session.modalities, ["text", "audio"]);
	assert.equal(session.input_audio_format, "pcm16");
	assert.equal(session.output_audio_format, "pcm16");
	assert.deepEqual(
		session.tools.map((tool) => tool.function.name),
		["stepcode_task", "stepcode_status", "stepcode_cancel"],
	);
	assert.ok(session.tools.every((tool) => tool.type === "function" && !tool.name));
	assert.equal(session.turn_detection.type, "server_vad");
	assert.ok(!("input_audio_transcription" in session));
	assert.deepEqual(createRealtimeSession(config(), { delegate: false }).tools, []);
});

test("WebSocket auth stays in server headers and readiness waits for session.updated", async () => {
	const events = [];
	const client = new StepFunRealtimeClient(config(), { WebSocketImpl: FakeWebSocket, onEvent: (event) => events.push(event) });
	const promise = client.connect();
	assert.equal(client.socket.url, "wss://api.stepfun.com/v1/realtime?model=stepaudio-3-realtime-preview");
	assert.equal(client.socket.options.headers.Authorization, "Bearer test-key-never-real");
	client.socket.open();
	assert.equal(client.socket.sent[0].type, "session.update");
	assert.ok(client.socket.sent[0].event_id);
	client.socket.receive({ type: "session.created", session: { id: "s1" } });
	assert.equal(client.ready, false);
	assert.throws(() => client.appendAudio("AAA="), /尚未配置/);
	client.socket.receive({ type: "session.updated", session: { id: "s1" } });
	await promise;
	assert.equal(client.ready, true);
	assert.ok(!JSON.stringify(events).includes(config().apiKey));
	client.close();
});

test("missing key prevents a socket constructor or an API request", async () => {
	let constructed = false;
	const client = new StepFunRealtimeClient(loadStepFunConfig({}), {
		WebSocketImpl: class {
			constructor() {
				constructed = true;
			}
		},
	});
	await assert.rejects(client.connect(), /STEP_API_KEY/);
	assert.equal(constructed, false);
});

test("audio append requires PCM16 frames; manual commit triggers a response", async () => {
	const { client, socket } = await connected();
	const audio = Buffer.from([0, 0, 255, 127]).toString("base64");
	client.appendAudio(audio);
	assert.equal(socket.sent.at(-1).audio, audio);
	assert.equal(socket.sent.at(-1).type, "input_audio_buffer.append");
	assert.throws(() => client.appendAudio(Buffer.from([0]).toString("base64")), /PCM16/);
	assert.throws(() => client.appendAudio("not base64"), /Base64/);
	client.commitAudio();
	assert.deepEqual(socket.sent.slice(-2).map((event) => event.type), ["input_audio_buffer.commit", "response.create"]);
	client.close();
});

test("speech detection cancels active output once and drops late audio until next response", async () => {
	const { client, socket, events } = await connected();
	assert.equal(client.cancelResponse(), false);
	socket.receive({ type: "response.created", response: { id: "r1" } });
	socket.receive({ type: "response.audio.delta", response_id: "r1", delta: "AAA=" });
	assert.equal(events.at(-1).type, "output.audio.delta");
	socket.receive({ type: "input_audio_buffer.speech_started", item_id: "i2" });
	assert.equal(socket.sent.at(-1).type, "response.cancel");
	assert.equal(client.cancelResponse(), false);
	const audioCount = events.filter((event) => event.type === "output.audio.delta").length;
	socket.receive({ type: "response.audio.delta", response_id: "r1", delta: "AAA=" });
	assert.equal(events.filter((event) => event.type === "output.audio.delta").length, audioCount);
	socket.receive({ type: "response.created", response: { id: "r2" } });
	socket.receive({ type: "response.audio.delta", response_id: "r1", delta: "AAA=" });
	socket.receive({ type: "response.audio.delta", response_id: "r2", delta: "AAA=" });
	assert.equal(events.filter((event) => event.type === "output.audio.delta").length, audioCount + 1);
	assert.equal(events.at(-1).sampleRate, 24_000);
	assert.ok(!socket.sent.some((event) => event.item?.name === "stepcode_cancel"));
	client.close();
});

test("barge-in fences late calls after new response and permits announced new calls", async () => {
	const calls = [];
	const { client, socket } = await connected({ onToolCall: (event) => { calls.push(event); } });
	socket.receive({ type: "response.created", response: { id: "old" } });
	socket.receive({ type: "conversation.item.created", item: { id: "old-function", type: "function_call", call_id: "old-call", name: "stepcode_task" } });
	client.cancelResponse();
	socket.receive({ type: "response.function_call_arguments.done", response_id: "old", call_id: "explicit-old", name: "stepcode_task", arguments: '{"instruction":"late old work"}' });
	socket.receive({ type: "response.created", response: { id: "new" } });
	socket.receive({ type: "response.function_call_arguments.done", call_id: "old-call", name: "stepcode_task", arguments: '{"instruction":"late old work"}' });
	socket.receive({ type: "response.function_call_arguments.done", call_id: "unannounced", name: "stepcode_task", arguments: '{"instruction":"unknown old work"}' });
	socket.receive({ type: "conversation.item.created", item: { id: "new-function", type: "function_call", call_id: "new-call", name: "stepcode_task" } });
	socket.receive({ type: "response.function_call_arguments.done", call_id: "new-call", name: "stepcode_task", arguments: '{"instruction":"new work"}' });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(calls.map((event) => event.callId), ["new-call"]);
	assert.equal(calls[0].responseId, "new");
	// Suppressed calls cannot later be replayed as belonging to the new response.
	socket.receive({ type: "response.function_call_arguments.done", response_id: "new", call_id: "old-call", name: "stepcode_task", arguments: '{"instruction":"replay"}' });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.length, 1);
	client.close();
});

test("audio and transcripts without response_id are correlated across interrupted turns", async () => {
	const { client, socket, events } = await connected();
	socket.receive({ type: "response.created", response: { id: "old" } });
	socket.receive({ type: "response.output_item.added", response_id: "old", item: { id: "old-item", type: "message", role: "assistant" } });
	socket.receive({ type: "response.audio.delta", item_id: "old-item", delta: "AAA=" });
	client.cancelResponse();
	socket.receive({ type: "response.created", response: { id: "new" } });
	const before = events.filter((event) => event.type.startsWith("output.")).length;
	socket.receive({ type: "response.audio.delta", item_id: "old-item", delta: "AAA=" });
	socket.receive({ type: "response.audio_transcript.delta", item_id: "old-item", delta: "late old words" });
	socket.receive({ type: "response.audio.delta", item_id: "unknown-item", delta: "AAA=" });
	assert.equal(events.filter((event) => event.type.startsWith("output.")).length, before);
	socket.receive({ type: "conversation.item.created", item: { id: "new-item", type: "message", role: "assistant" } });
	socket.receive({ type: "response.audio.delta", item_id: "new-item", delta: "AAA=" });
	socket.receive({ type: "response.audio_transcript.delta", item_id: "new-item", delta: "new words" });
	assert.equal(events.filter((event) => event.type.startsWith("output.")).length, before + 2);
	assert.equal(events.at(-1).responseId, "new");
	client.close();
});

test("an already-dispatched host task continues after barge-in without reviving old speech", async () => {
	let finishHost;
	let dispatched = 0;
	const { client, socket } = await connected({
		onToolCall: () => {
			dispatched++;
			return new Promise((resolve) => { finishHost = resolve; });
		},
	});
	socket.receive({ type: "response.created", response: { id: "old" } });
	socket.receive({ type: "response.function_call_arguments.done", response_id: "old", call_id: "dispatched", name: "stepcode_task", arguments: '{"instruction":"authorized work"}' });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(dispatched, 1);
	client.cancelResponse();
	socket.receive({ type: "response.created", response: { id: "new" } });
	const responseCreatesBefore = socket.sent.filter((event) => event.type === "response.create").length;
	finishHost({ status: "submitted" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(socket.sent.at(-1).item.type, "function_call_output");
	assert.equal(socket.sent.at(-1).item.call_id, "dispatched");
	assert.equal(socket.sent.filter((event) => event.type === "response.create").length, responseCreatesBefore);
	assert.equal(dispatched, 1);
	client.close();
});

test("barge-in before the host dispatch microtask prevents newly launching cancelled work", async () => {
	let dispatched = 0;
	const { client, socket } = await connected({ onToolCall: () => { dispatched++; } });
	socket.receive({ type: "response.created", response: { id: "old" } });
	socket.receive({ type: "response.function_call_arguments.done", response_id: "old", call_id: "not-started", name: "stepcode_task", arguments: '{"instruction":"old work"}' });
	client.cancelResponse();
	socket.receive({ type: "response.created", response: { id: "new" } });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(dispatched, 0);
	client.close();
});

test("tool call IDs remain deduplicated after more than 200 calls in one session", async () => {
	const calls = [];
	const { client, socket } = await connected({ onToolCall: (event) => { calls.push(event.callId); } });
	for (let i = 0; i < 220; i++) {
		socket.receive({ type: "response.function_call_arguments.done", call_id: `call-${i}`, name: "stepcode_status", arguments: "{}" });
	}
	await new Promise((resolve) => setImmediate(resolve));
	socket.receive({ type: "response.function_call_arguments.done", call_id: "call-0", name: "stepcode_status", arguments: "{}" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.length, 220);
	assert.equal(calls.filter((id) => id === "call-0").length, 1);
	client.close();
});

test("background context is a system item and explicit typed text is a user item", async () => {
	const { client, socket } = await connected();
	client.sendContext("后台任务已完成。", { respond: false });
	assert.equal(socket.sent.at(-1).item.role, "system");
	assert.deepEqual(socket.sent.at(-1).item.content, [{ type: "input_text", text: "后台任务已完成。" }]);
	client.sendText("现在进度如何？");
	assert.equal(socket.sent.at(-2).item.role, "user");
	assert.equal(socket.sent.at(-1).type, "response.create");
	client.close();
});

test("tool callback returns an immediate ack once using function_call_output", async () => {
	const calls = [];
	const { client, socket } = await connected({
		onToolCall(event) {
			calls.push(event);
			return { status: "running", taskId: "task1" };
		},
	});
	const event = {
		type: "response.function_call_arguments.done",
		call_id: "call1",
		name: "stepcode_task",
		arguments: '{"instruction":"检查 README","delivery":"followUp"}',
	};
	socket.receive(event);
	socket.receive(event);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.length, 1);
	assert.equal(calls[0].arguments.instruction, "检查 README");
	assert.deepEqual(socket.sent.at(-2).item, {
		type: "function_call_output",
		call_id: "call1",
		output: '{"status":"running","taskId":"task1"}',
	});
	assert.equal(socket.sent.at(-1).type, "response.create");
	client.close();
});

test("malformed, wrong-shaped, unknown and extra-parameter tools never reach host", async () => {
	let calls = 0;
	const { client, socket, events } = await connected({ onToolCall: () => calls++ });
	const cases = [
		{ name: "stepcode_task", arguments: "{bad" },
		{ name: "stepcode_task", arguments: "[]" },
		{ name: "stepcode_task", arguments: '{"instruction":"ok","delivery":"shell"}' },
		{ name: "run_shell", arguments: '{"command":"rm -rf /"}' },
		{ name: "stepcode_status", arguments: '{"command":"x"}' },
	];
	cases.forEach((value, index) => socket.receive({ type: "response.function_call_arguments.done", call_id: `bad${index}`, ...value }));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls, 0);
	assert.equal(events.filter((event) => event.code === "invalid_tool_arguments").length, cases.length);
	assert.equal(socket.sent.filter((event) => event.item?.type === "function_call_output").length, cases.length);
	client.close();
});

test("failed and cancelled response statuses remain distinguishable and details redact secrets", () => {
	for (const status of ["completed", "failed", "cancelled", "incomplete"]) {
		const event = normalizeRealtimeEvent(
			{
				type: "response.done",
				response: { id: "r1", status, status_details: { error: { message: `denied Bearer ${config().apiKey}` } } },
			},
			{ apiKey: config().apiKey },
		);
		assert.equal(event.status, status);
		assert.ok(!JSON.stringify(event).includes(config().apiKey));
	}
});

test("session rejection and socket error redact credentials and close incomplete connection", async () => {
	const events = [];
	const client = new StepFunRealtimeClient(config(), { WebSocketImpl: FakeWebSocket, onEvent: (event) => events.push(event) });
	const promise = client.connect();
	client.socket.open();
	client.socket.receive({ type: "error", error: { code: "invalid_voice", message: `failed ${config().apiKey}` } });
	await assert.rejects(promise, (error) => !error.message.includes(config().apiKey) && error.message.includes("redacted"));
	assert.equal(client.socket.readyState, 3);
	assert.ok(!JSON.stringify(events).includes(config().apiKey));
});

test("connection timeout closes an unfinished socket and errors are sanitized", async () => {
	const client = new StepFunRealtimeClient(config(), { WebSocketImpl: FakeWebSocket });
	// The extra referenced timer keeps the test alive while the connection timer is unref'ed.
	await Promise.all([
		assert.rejects(client.connect({ timeoutMs: 5 }), /连接超时/),
		new Promise((resolve) => setTimeout(resolve, 10)),
	]);
	assert.equal(client.socket.readyState, 3);
	const failed = new StepFunRealtimeClient(config(), { WebSocketImpl: FakeWebSocket });
	const promise = failed.connect();
	failed.socket.emit("error", new Error(`handshake failed Bearer ${config().apiKey}`));
	await assert.rejects(promise, (error) => !error.message.includes(config().apiKey));
	assert.equal(failed.socket.readyState, 3);
});

test("SSE decoder preserves fragmented UTF-8 and handles CRLF + multi-line data", async () => {
	const result = [];
	for await (const event of readSseEvents(sseResponse([{ type: "transcript.text.delta", delta: "你好" }]).body)) result.push(event);
	assert.deepEqual(result, [{ type: "transcript.text.delta", delta: "你好" }]);
	const multiline = new Response('data: {"type":"done",\n data: ignored\ndata: "value":1}\n\ndata: [DONE]\n\n');
	const items = [];
	for await (const event of readSseEvents(multiline.body)) items.push(event);
	assert.deepEqual(items, [{ type: "done", value: 1 }]);
});

test("SSE DONE ends a still-open body, discards trailing bytes and releases its reader", { timeout: 1_000 }, async (t) => {
	const stream = openSseResponse(t, 'data: {"type":"first"}\n\ndata: [DONE]\n\ndata: invalid-json\n\n');
	const events = [];
	for await (const event of readSseEvents(stream.body)) events.push(event);
	assert.deepEqual(events, [{ type: "first" }]);
	assert.equal(stream.canceled(), 1);
	assert.equal(stream.body.locked, false);
});

test("StepAudio 3 TTS sends official SSE schema, decodes each chunk and excludes voice_label", async () => {
	const outputs = [];
	let request;
	const result = await synthesizeSpeech(config(), "你好。", {
		fetchImpl: async (url, options) => {
			request = { url, options, body: JSON.parse(options.body) };
			return sseResponse([
				{ type: "speech.audio.delta", audio: Buffer.from([1, 0]).toString("base64") },
				{ type: "speech.audio.delta", audio: Buffer.from([2, 0]).toString("base64") },
				{ type: "speech.audio.done", audio: "" },
			]);
		},
		onAudio: (audio, metadata) => outputs.push({ audio, metadata }),
	});
	assert.equal(request.url, "https://api.stepfun.com/v1/audio/speech");
	assert.equal(request.body.model, "stepaudio-3-tts");
	assert.equal(request.body.stream_format, "sse");
	assert.equal(request.body.response_format, "pcm");
	assert.equal(request.body.sample_rate, 24_000);
	assert.equal(request.body.voice_label, undefined);
	assert.equal(outputs.length, 2);
	assert.deepEqual(result.audio, Buffer.from([1, 0, 2, 0]));
	assert.equal(result.sampleRate, 24_000);
});

test("TTS bounds input before API calls and detects an incomplete SSE stream", async () => {
	await assert.rejects(synthesizeSpeech(config(), "x".repeat(1_001)), /1000/);
	await assert.rejects(
		synthesizeSpeech(config(), "hello", { fetchImpl: async () => sseResponse([{ type: "speech.audio.delta", audio: "AAA=" }]) }),
		/完成前关闭/,
	);
});

test("TTS completes on speech.audio.done without waiting for DONE or HTTP EOF", { timeout: 1_000 }, async (t) => {
	const stream = openSseResponse(t, 'data: {"type":"speech.audio.delta","audio":"AQACAA=="}\n\ndata: {"type":"speech.audio.done","audio":""}\n\ndata: {"type":"speech.audio.delta","audio":"AwA="}\n\n');
	const chunks = [];
	const result = await synthesizeSpeech(config(), "完成了。", { fetchImpl: async () => stream.response, onAudio: (audio) => chunks.push(audio) });
	assert.deepEqual(result.audio, Buffer.from([1, 0, 2, 0]));
	assert.equal(chunks.length, 1);
	assert.equal(stream.canceled(), 1);
	assert.equal(stream.body.locked, false);
});

test("TTS cancellation while releasing a completed reader cannot return success", { timeout: 1_000 }, async () => {
	const abort = new AbortController();
	let canceled = 0;
	const body = new ReadableStream({
		start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"speech.audio.done"}\n\n')); },
		cancel() {
			canceled++;
			abort.abort(new Error("完成时已打断"));
		},
	});
	await assert.rejects(synthesizeSpeech(config(), "你好。", { signal: abort.signal, fetchImpl: async () => new Response(body) }), /完成时已打断/);
	assert.equal(canceled, 1);
	assert.equal(body.locked, false);
});

test("TTS DONE without audio.done fails promptly and cancels a still-open body", { timeout: 1_000 }, async (t) => {
	const stream = openSseResponse(t, 'data: {"type":"speech.audio.delta","audio":"AAA="}\n\ndata: [DONE]\n\n');
	await assert.rejects(synthesizeSpeech(config(), "你好。", { fetchImpl: async () => stream.response }), /完成前关闭/);
	assert.equal(stream.canceled(), 1);
	assert.equal(stream.body.locked, false);
});

test("TTS error cancels an open body and keeps provider credentials out of errors", { timeout: 1_000 }, async (t) => {
	const stream = openSseResponse(t, `data: ${JSON.stringify({ type: "speech.audio.error", message: `denied ${config().apiKey}` })}\n\n`);
	await assert.rejects(synthesizeSpeech(config(), "你好。", { fetchImpl: async () => stream.response }), (error) => !error.message.includes(config().apiKey) && error.message.includes("redacted"));
	assert.equal(stream.canceled(), 1);
	assert.equal(stream.body.locked, false);
});

test("TTS pre-cancellation makes no request and cancellation interrupts stalled headers", { timeout: 1_000 }, async () => {
	const before = new AbortController();
	before.abort(new Error("已打断"));
	let requests = 0;
	await assert.rejects(synthesizeSpeech(config(), "你好。", { signal: before.signal, fetchImpl: async () => { requests++; return new Response(); } }), /已打断/);
	assert.equal(requests, 0);
	const during = new AbortController();
	let requestSignal;
	const pending = synthesizeSpeech(config(), "你好。", { signal: during.signal, fetchImpl: (_, options) => { requestSignal = options.signal; return new Promise(() => {}); } });
	during.abort(new Error("已打断"));
	await assert.rejects(pending, /已打断/);
	assert.equal(requestSignal.aborted, true);
});

test("TTS cancellation interrupts a stalled reader and releases it without trailing audio", { timeout: 1_000 }, async (t) => {
	const stream = openSseResponse(t, 'data: {"type":"speech.audio.delta","audio":"AAA="}\n\n');
	const abort = new AbortController();
	let markAudio;
	const heardAudio = new Promise((resolve) => { markAudio = resolve; });
	const pending = synthesizeSpeech(config(), "你好。", { signal: abort.signal, fetchImpl: async () => stream.response, onAudio: () => markAudio() });
	await heardAudio;
	abort.abort(new Error(`停止 ${config().apiKey}`));
	await assert.rejects(pending, (error) => error.message.includes("停止") && !error.message.includes(config().apiKey));
	assert.equal(stream.canceled(), 1);
	assert.equal(stream.body.locked, false);
});

test("SSE cancellation between events in one network chunk prevents the next yield", { timeout: 1_000 }, async (t) => {
	const stream = openSseResponse(t, 'data: {"type":"first"}\n\ndata: {"type":"second"}\n\n');
	const abort = new AbortController();
	const received = [];
	await assert.rejects(async () => {
		for await (const event of readSseEvents(stream.body, { signal: abort.signal })) {
			received.push(event.type);
			abort.abort(new Error("已打断"));
		}
	}, /已打断/);
	assert.deepEqual(received, ["first"]);
	assert.equal(stream.canceled(), 1);
	assert.equal(stream.body.locked, false);
});

test("TTS cancellation after the first callback prevents the second audio callback in the same chunk", { timeout: 1_000 }, async (t) => {
	const stream = openSseResponse(t, 'data: {"type":"speech.audio.delta","audio":"AQA="}\n\ndata: {"type":"speech.audio.delta","audio":"AgA="}\n\ndata: {"type":"speech.audio.done"}\n\n');
	const abort = new AbortController();
	const received = [];
	await assert.rejects(synthesizeSpeech(config(), "你好。", {
		fetchImpl: async () => stream.response,
		signal: abort.signal,
		onAudio(audio) {
			received.push(audio);
			if (received.length === 1) {
				// Abort after the callback promise settles, before the parser yields the
				// next buffered event. This reproduces the original microtask race.
				queueMicrotask(() => queueMicrotask(() => abort.abort(new Error("已打断"))));
			}
		},
	}), /已打断/);
	assert.deepEqual(received, [Buffer.from([1, 0])]);
	assert.equal(stream.canceled(), 1);
	assert.equal(stream.body.locked, false);
});

test("TTS times out while waiting for headers or the next audio chunk", { timeout: 1_000 }, async (t) => {
	let requestSignal;
	await assert.rejects(synthesizeSpeech(config(), "你好。", { timeoutMs: 20, fetchImpl: (_, options) => { requestSignal = options.signal; return new Promise(() => {}); } }), /超时/);
	assert.equal(requestSignal.aborted, true);
	const stream = openSseResponse(t, 'data: {"type":"speech.audio.delta","audio":"AAA="}\n\n');
	await assert.rejects(synthesizeSpeech(config(), "你好。", { timeoutMs: 20, fetchImpl: async () => stream.response }), /超时/);
	assert.equal(stream.canceled(), 1);
	assert.equal(stream.body.locked, false);
});

test("TTS refreshes its idle timeout on incoming bytes rather than total synthesis duration", { timeout: 1_000 }, async (t) => {
	const stream = openSseResponse(t, ': heartbeat\n\n');
	const timers = [];
	for (let i = 1; i <= 6; i++) timers.push(setTimeout(() => stream.enqueue(i === 6 ? 'data: {"type":"speech.audio.done"}\n\n' : ': heartbeat\n\n'), i * 20));
	t.after(() => { for (const timer of timers) clearTimeout(timer); });
	const result = await synthesizeSpeech(config(), "你好。", { timeoutMs: 80, fetchImpl: async () => stream.response });
	assert.equal(result.audio.length, 0);
	assert.equal(stream.canceled(), 1);
});

test("StepAudio 3 ASR sends actual PCM rate and returns final corrected transcript", async () => {
	let request;
	const deltas = [];
	const text = await transcribeAudio(config(), Buffer.from([0, 0, 1, 0]), {
		sampleRate: 24_000,
		fetchImpl: async (url, options) => {
			request = { url, body: JSON.parse(options.body) };
			return sseResponse([
				{ type: "transcript.text.delta", delta: "你好" },
				{ type: "transcript.text.delta", delta: "阶跃" },
				{ type: "transcript.text.done", text: "你好，阶跃。" },
			]);
		},
		onDelta: (delta, full) => deltas.push({ delta, full }),
	});
	assert.equal(request.url, "https://api.stepfun.com/v1/audio/asr/sse");
	assert.equal(request.body.audio.input.transcription.model, "stepaudio-3-asr-max");
	assert.deepEqual(request.body.audio.input.format, { type: "pcm", codec: "pcm_s16le", rate: 24_000, bits: 16, channel: 1 });
	assert.equal(request.body.audio.data, "AAABAA==");
	assert.equal(request.body.audio.input.transcription.full_rerun_on_commit, undefined);
	assert.equal(deltas.at(-1).full, "你好阶跃");
	assert.equal(text, "你好，阶跃。");
});

test("ASR HTTP and SSE failures redact keys and missing final transcripts fail visibly", async () => {
	await assert.rejects(
		transcribeAudio(config(), Buffer.from([0, 0]), {
			fetchImpl: async () => new Response(`denied ${config().apiKey}`, { status: 401 }),
		}),
		(error) => error.message.includes("401") && !error.message.includes(config().apiKey),
	);
	await assert.rejects(
		transcribeAudio(config(), Buffer.from([0, 0]), { fetchImpl: async () => sseResponse([{ type: "error", message: config().apiKey }]) }),
		(error) => !error.message.includes(config().apiKey) && error.message.includes("redacted"),
	);
	await assert.rejects(
		transcribeAudio(config(), Buffer.from([0, 0]), { fetchImpl: async () => sseResponse([{ type: "transcript.text.delta", delta: "partial" }]) }),
		/完整转录前关闭/,
	);
});

test("a rejected handshake under Bun (ErrorEvent) is reported in words, not [object ErrorEvent]", async () => {
	const events = [];
	const client = new StepFunRealtimeClient(config(), { WebSocketImpl: FakeWebSocket, onEvent: (event) => events.push(event) });
	const promise = client.connect();
	// Shape of Bun's ws shim error: not an Error, text lives in .message
	const bunError = { type: "error", message: "WebSocket connection to 'wss://api.stepfun.com/v1/realtime' failed: Expected 101 status code", toString: () => "[object ErrorEvent]" };
	client.socket.emit("error", bunError);
	await assert.rejects(promise, /拒绝了实时语音连接.*API Key/);
	const error = events.find((event) => event.type === "error");
	assert.doesNotMatch(error.message, /object ErrorEvent/);
	assert.match(error.message, /STEP_API_KEY/);
	assert.equal(sanitizeProviderError({ error: new Error("boom Bearer abc.def") }), "boom Bearer [redacted]");
});

test("under Node a 401 handshake explains that the Key is invalid", async () => {
	const events = [];
	const client = new StepFunRealtimeClient(config(), { WebSocketImpl: FakeWebSocket, onEvent: (event) => events.push(event) });
	const promise = client.connect();
	client.socket.emit("unexpected-response", {}, { statusCode: 401, resume() {} });
	await assert.rejects(promise, /401.*开放平台 Key/);
	assert.match(events.find((event) => event.type === "error").message, /API Key（401）/);
});

test("a reply cut off by our own barge-in cancel is reported as cancelled, not incomplete", async () => {
	const { events, socket } = await connected();
	socket.receive({ type: "response.created", response: { id: "r1", status: "in_progress" } });
	socket.receive({ type: "input_audio_buffer.speech_started", item_id: "i2" });
	assert.equal(socket.sent.at(-1).type, "response.cancel");
	// Real StepFun behaviour (verified live): the cancelled reply ends as "incomplete" without status_details.
	socket.receive({ type: "response.done", response: { id: "r1", status: "incomplete" } });
	const done = events.filter((event) => event.type === "response.done").at(-1);
	assert.equal(done.status, "cancelled");
	assert.equal(done.statusDetails.reason, "client_cancelled");
});

test("an incomplete reply we did not cancel still surfaces as incomplete", async () => {
	const { events, socket } = await connected();
	socket.receive({ type: "response.created", response: { id: "r9", status: "in_progress" } });
	socket.receive({ type: "response.done", response: { id: "r9", status: "incomplete", status_details: { reason: "max_output_tokens" } } });
	const done = events.filter((event) => event.type === "response.done").at(-1);
	assert.equal(done.status, "incomplete");
	assert.equal(done.statusDetails.reason, "max_output_tokens");
});
