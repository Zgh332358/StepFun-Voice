import { randomUUID } from "node:crypto";
import { CHANNELS, channelFromBaseUrl, isChannel, keyHint, loadSavedCredentials } from "./credentials.mjs";

// Protocol sources, checked 2026-10-11:
// https://platform.stepfun.com/docs/zh/api-reference/realtime/chat
// https://platform.stepfun.com/docs/zh/guides/developer/realtime
// https://platform.stepfun.com/docs/zh/api-reference/audio/create-audio
// https://platform.stepfun.com/docs/zh/api-reference/audio/asr-sse
// Realtime PCM follows the official guide's mono 24 kHz s16le player example.
export const REALTIME_SAMPLE_RATE = 24_000;

export const VOICE_TOOLS = [
	{
		type: "function",
		function: {
			name: "stepcode_task",
			description:
				"把用户明确要求的代码、文件或终端任务交给当前 Step Code 工作区后台执行。立即返回任务状态，随后可以继续语音对话。",
			parameters: {
				type: "object",
				properties: {
					instruction: { type: "string", maxLength: 4_000, description: "用户授权的具体任务或对当前任务的补充要求。" },
					delivery: {
						type: "string",
						enum: ["steer", "followUp"],
						description: "steer 用于调整正在执行的任务，followUp 用于加入后续任务。",
					},
				},
				required: ["instruction"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function",
		function: {
			name: "stepcode_status",
			description: "查询当前 Step Code 后台任务的状态与最近进度。",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		},
	},
	{
		type: "function",
		function: {
			name: "stepcode_cancel",
			description: "用户明确要求停止工作时，取消当前 Step Code 后台任务。打断语音播放不应调用此工具。",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		},
	},
];

const DEFAULT_INSTRUCTIONS = "这是语音直通 Step Code 的会话：用户的语音会被转写并直接交给 Step Code 执行。你可以用简短口语化的中文语音回应，例如确认收到、澄清追问或轻量提示，但不要自己完成编码任务，不要调用工具，不要编造 Step Code 的执行结果；复杂的回答交给 Step Code。";

function modelId(value, fallback) {
	const model = String(value || fallback).trim();
	if (!/^step[a-z0-9._-]+$/i.test(model)) throw new Error("语音插件仅接受 StepFun 模型名称。");
	return model;
}

function boundedInteger(value, fallback, min, max) {
	if (value === undefined || value === "") return fallback;
	const number = Number(value);
	if (!Number.isInteger(number) || number < min || number > max) {
		throw new Error(`语音参数应为 ${min} 到 ${max} 的整数。`);
	}
	return number;
}

/** Official hosts with the open-platform (/v1) or Step Plan (/step_plan/v1) prefix. */
export function assertOfficialBaseUrl(baseUrl) {
	const url = new URL(baseUrl);
	const path = url.pathname.replace(/\/+$/, "");
	if (url.protocol !== "https:" || !["api.stepfun.com", "api.stepfun.ai"].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash || !["/v1", "/step_plan/v1"].includes(path)) {
		throw new Error("服务地址须为官方 StepFun 地址：https://api.stepfun.com/v1（开放平台）或 https://api.stepfun.com/step_plan/v1（Step Plan）。");
	}
	return `${url.origin}${path}`;
}

/**
 * Configuration from the panel setup (saved file) and environment variables.
 * The saved setup is read from the real home, or from STEP_VOICE_HOME when a
 * custom environment is passed (tests).
 * Precedence: the Key and channel chosen in the panel, then STEP_API_KEY /
 * STEPFUN_API_KEY, STEP_VOICE_CHANNEL and STEP_VOICE_BASE_URL. Model variables
 * override the channel defaults.
 */
export function loadStepFunConfig(env = process.env, { saved = env === process.env || env.STEP_VOICE_HOME ? loadSavedCredentials(env) : undefined } = {}) {
	const envKey = String(env.STEP_API_KEY || env.STEPFUN_API_KEY || "").trim();
	const envBase = env.STEP_VOICE_BASE_URL ? assertOfficialBaseUrl(String(env.STEP_VOICE_BASE_URL)) : "";
	const channel = saved?.channel
		|| (isChannel(env.STEP_VOICE_CHANNEL) ? env.STEP_VOICE_CHANNEL : "")
		|| (envBase ? channelFromBaseUrl(envBase) : "api");
	const defaults = CHANNELS[channel];
	const baseUrl = envBase && channelFromBaseUrl(envBase) === channel ? envBase : defaults.baseUrl;
	const apiKey = saved?.apiKey || envKey;
	return {
		apiKey,
		channel,
		keySource: saved?.apiKey ? "saved" : envKey ? "env" : "",
		setupDone: Boolean(saved),
		envKeyHint: keyHint(envKey),
		baseUrl,
		realtimeModel: modelId(env.STEP_VOICE_REALTIME_MODEL, defaults.realtimeModel),
		ttsModel: modelId(env.STEP_VOICE_TTS_MODEL, defaults.ttsModel),
		summaryModel: modelId(env.STEP_VOICE_SUMMARY_MODEL, "step-3.7-flash"),
		asrModel: modelId(env.STEP_VOICE_ASR_MODEL, defaults.asrModel),
		voice: String(env.STEP_VOICE_VOICE || "linjiajiejie").trim(),
		inputSampleRate: REALTIME_SAMPLE_RATE,
		outputSampleRate: REALTIME_SAMPLE_RATE,
		instructions: String(env.STEP_VOICE_INSTRUCTIONS || DEFAULT_INSTRUCTIONS),
		turnDetection: {
			type: "server_vad",
			prefix_padding_ms: 500,
			silence_duration_ms: boundedInteger(env.STEP_VOICE_SILENCE_MS, 450, 100, 2_000),
			energy_awakeness_threshold: boundedInteger(env.STEP_VOICE_VAD_THRESHOLD, 2_500, 0, 5_000),
		},
	};
}

/** StepFun uses nested function definitions, unlike the OpenAI Realtime shape. */
export function createRealtimeSession(config, { delegate = false } = {}) {
	return {
		modalities: ["text", "audio"],
		instructions: config.instructions || DEFAULT_INSTRUCTIONS,
		voice: config.voice,
		input_audio_format: "pcm16",
		output_audio_format: "pcm16",
		turn_detection: config.turnDetection ?? null,
		tools: delegate ? structuredClone(VOICE_TOOLS) : [],
	};
}

/** Redact both the configured key and generic bearer credentials before UI output. */
/** Turns a rejected WebSocket handshake into an actionable message. */
export function handshakeHint(status) {
	if (status === 401) return "StepFun 拒绝了 API Key（401）：Key 无效或不是开放平台 Key。请在 https://platform.stepfun.com 创建 Key，设置 STEP_API_KEY 后重启 Step Code。";
	if (status === 403) return "StepFun 拒绝访问（403）：当前 Key 没有实时语音模型权限或额度不足。";
	if (status === 404) return "找不到实时语音模型（404）：请检查 STEP_VOICE_REALTIME_MODEL 和 STEP_VOICE_BASE_URL。";
	if (status === 429) return "StepFun 请求过于频繁或额度用尽（429），请稍后重试。";
	return `StepFun 实时语音握手失败（HTTP ${status}）。`;
}

/**
 * Live check used by the first-run setup: the Key must be accepted by the
 * channel and the channel's realtime model must open a session.
 */
export async function verifyChannelAccess(config, { WebSocketImpl, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
	const channel = CHANNELS[config.channel] || CHANNELS.api;
	const planHint = config.channel === "step_plan" ? `请确认账号已订阅 Step Plan（${CHANNELS.step_plan.subscribeUrl}）。` : "请确认该 Key 有实时语音模型权限且账户余额充足。";
	let response;
	try {
		response = await fetchImpl(`${config.baseUrl}/models`, { headers: { Authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(timeoutMs) });
	} catch (error) {
		return { ok: false, reason: "network", message: `无法连接 StepFun（${sanitizeProviderError(error, config.apiKey)}）。请检查网络或代理。` };
	}
	if (response.status === 401) return { ok: false, reason: "key", message: `${channel.label} 不认这个 Key（401）。请到 ${channel.keyUrl} 复制完整的 API Key 后重试。` };
	if (!response.ok) return { ok: false, reason: "http", message: `${channel.label} 返回 HTTP ${response.status}。${planHint}` };
	const client = new StepFunRealtimeClient({ ...config, turnDetection: null }, { WebSocketImpl, delegate: false });
	try {
		await client.connect({ timeoutMs });
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: "realtime", message: `Key 有效，但 ${channel.label} 上无法使用实时模型 ${config.realtimeModel}：${sanitizeProviderError(error, config.apiKey)} ${planHint}` };
	} finally {
		client.close();
	}
}

export function sanitizeProviderError(value, apiKey = "") {
	// Bun's ws shim emits ErrorEvent objects (not Error) whose text is in .message / .error.
	const raw = value instanceof Error ? value.message
		: value && typeof value === "object" ? (value.message || value.error?.message || value.reason || "")
		: value;
	let message = String(raw || "StepFun 语音服务出错。");
	if (/Expected 101 status code/i.test(message)) message = "StepFun 拒绝了实时语音连接（握手未返回 101）。最常见原因是 API Key 无效或不是开放平台 Key，其次是没有该实时模型的权限。请检查 STEP_API_KEY 后重启 Step Code。";
	if (apiKey) message = message.split(apiKey).join("[redacted]");
	return message.replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [redacted]").slice(0, 1_000);
}

function safeDetails(value, apiKey) {
	if (value === undefined || value === null) return null;
	if (typeof value === "string") return sanitizeProviderError(value, apiKey);
	if (Array.isArray(value)) return value.map((item) => safeDetails(item, apiKey));
	if (typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeDetails(item, apiKey)]));
	}
	return value;
}

/** Convert only documented public events; internal thinking events are not surfaced. */
export function normalizeRealtimeEvent(event, { apiKey = "" } = {}) {
	if (!event || typeof event !== "object") return null;
	const ids = { itemId: event.item_id, responseId: event.response_id };
	switch (event.type) {
		case "session.created":
			return { type: "session.created", sessionId: event.session?.id };
		case "session.updated":
			return { type: "ready", sessionId: event.session?.id, sampleRate: REALTIME_SAMPLE_RATE };
		case "input_audio_buffer.speech_started":
			return { type: "speech.start", ...ids, source: "user_audio", audioStartMs: event.audio_start_ms };
		case "input_audio_buffer.speech_stopped":
			return { type: "speech.end", ...ids, source: "user_audio", audioEndMs: event.audio_end_ms };
		case "input_audio_buffer.committed":
			return { type: "input.committed", ...ids, previousItemId: event.previous_item_id, source: "user_audio" };
		case "conversation.item.input_audio_transcription.completed":
			return { type: "input.transcript.final", ...ids, contentIndex: event.content_index, source: "user_audio", text: typeof event.transcript === "string" ? event.transcript : "" };
		case "conversation.item.input_audio_transcription.failed":
			return {
				type: "input.transcript.failed", ...ids, contentIndex: event.content_index, source: "user_audio",
				code: event.error?.code || "transcription_failed",
				message: sanitizeProviderError(event.error?.message || "语音转录失败。", apiKey),
			};
		case "response.created":
			return { type: "response.started", responseId: event.response?.id || event.response_id };
		case "response.audio.delta":
			return { type: "output.audio.delta", ...ids, audio: event.delta, sampleRate: REALTIME_SAMPLE_RATE };
		case "response.audio.done":
			return { type: "output.audio.done", ...ids };
		case "response.audio_transcript.delta":
		case "response.text.delta":
			return { type: "output.transcript.delta", ...ids, text: String(event.delta || "") };
		case "response.audio_transcript.done":
		case "response.text.done":
			return { type: "output.transcript.final", ...ids, text: String(event.transcript ?? event.text ?? "") };
		case "response.done":
		case "response.cancelled":
			return {
				type: "response.done",
				responseId: event.response?.id || event.response_id,
				status: event.response?.status || (event.type === "response.cancelled" ? "cancelled" : "unknown"),
				statusDetails: safeDetails(event.response?.status_details, apiKey),
				usage: event.response?.usage || null,
			};
		case "response.function_call_arguments.done": {
			let args;
			try {
				args = typeof event.arguments === "string" ? JSON.parse(event.arguments) : event.arguments;
			} catch {
				return { type: "tool.invalid", ...ids, callId: event.call_id, name: event.name, message: "工具参数不是有效 JSON。" };
			}
			if (!args || typeof args !== "object" || Array.isArray(args)) {
				return { type: "tool.invalid", ...ids, callId: event.call_id, name: event.name, message: "工具参数必须是对象。" };
			}
			return {
				type: "tool.call",
				...ids,
				callId: event.call_id,
				name: event.name,
				arguments: args,
				argumentsText: typeof event.arguments === "string" ? event.arguments : JSON.stringify(args),
			};
		}
		case "error":
			return {
				type: "error",
				code: sanitizeProviderError(event.error?.code || event.code || "upstream_error", apiKey),
				message: sanitizeProviderError(event.error?.message || event.message, apiKey),
			};
		default:
			return null;
	}
}

function toolArgumentError(event) {
	if (!event.callId) return "工具调用缺少 call_id。";
	if (!VOICE_TOOLS.some((tool) => tool.function.name === event.name)) return "模型请求了未注册的工具。";
	const args = event.arguments;
	if (event.name === "stepcode_task") {
		if (typeof args.instruction !== "string" || !args.instruction.trim() || args.instruction.length > 4_000) {
			return "任务 instruction 必须是非空文本，且不能超过 4000 字符。";
		}
		if (args.delivery !== undefined && !["steer", "followUp"].includes(args.delivery)) return "任务 delivery 值无效。";
		if (Object.keys(args).some((key) => !["instruction", "delivery"].includes(key))) return "任务包含未注册的参数。";
	} else if (Object.keys(args).length !== 0) return "状态和取消工具不接受额外参数。";
	return null;
}

/** Server-side WebSocket relay client. Pass the ws constructor; keys stay out of public event snapshots. */
export class StepFunRealtimeClient {
	constructor(config, { WebSocketImpl, onEvent = () => {}, onToolCall, delegate = false, autoBargeIn = true } = {}) {
		if (typeof WebSocketImpl !== "function") throw new Error("需要服务端 WebSocketImpl（ws），以便通过请求头鉴权。");
		this.config = config;
		this.WebSocketImpl = WebSocketImpl;
		this.onEvent = onEvent;
		this.onToolCall = onToolCall;
		this.delegate = delegate;
		this.autoBargeIn = autoBargeIn;
		this.activeResponseId = null;
		this.responseActive = false;
		this.ready = false;
		this.cancelledResponseIds = new Set();
		this.handledToolCalls = new Set();
		this.itemResponseIds = new Map();
		this.callResponseIds = new Map();
		this.hasCancelledResponse = false;
		this.muteOutput = false;
	}

	connect({ timeoutMs = 20_000 } = {}) {
		if (!this.config.apiKey) return Promise.reject(new Error("请配置 STEP_API_KEY 或 STEPFUN_API_KEY 后再连接语音。"));
		if (this.socket) return Promise.reject(new Error("语音连接已经启动。"));
		const url = new URL(`${this.config.baseUrl}/realtime`);
		url.protocol = "wss:";
		url.searchParams.set("model", this.config.realtimeModel);
		return new Promise((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				finish(new Error("StepFun 实时语音连接超时。"));
				this.close();
			}, timeoutMs);
			timer.unref?.();
			const finish = (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (error) reject(new Error(sanitizeProviderError(error, this.config.apiKey)));
				else resolve(this);
			};
			try {
				this.socket = new this.WebSocketImpl(url.toString(), {
					headers: { Authorization: `Bearer ${this.config.apiKey}` },
					maxPayload: 16 * 1024 * 1024,
				});
			} catch (error) {
				finish(error);
				return;
			}
			this.socket.on("open", () => {
				this.send({ type: "session.update", session: createRealtimeSession(this.config, { delegate: this.delegate }) });
			});
			this.socket.on("message", (data) => {
				let raw;
				try {
					raw = JSON.parse(String(data));
				} catch {
					this.onEvent({ type: "error", code: "invalid_event", message: "语音服务返回了无效事件。" });
					return;
				}
				if (raw.type === "session.updated") {
					this.ready = true;
					finish();
				}
				if (raw.type === "error" && !this.ready) {
					finish(new Error(raw.error?.message || raw.message || "语音会话配置失败。"));
					this.close();
				}
				this.handleEvent(raw);
			});
			// Node's ws reports the HTTP status of a rejected handshake (Bun does not emit this event).
			this.socket.on("unexpected-response", (_request, response) => {
				const message = handshakeHint(response?.statusCode);
				response?.resume?.();
				this.onEvent({ type: "error", code: "connection_error", message });
				finish(new Error(message));
				this.close();
			});
			this.socket.on("error", (error) => {
				const message = sanitizeProviderError(error, this.config.apiKey);
				this.onEvent({ type: "error", code: "connection_error", message });
				finish(new Error(message));
				if (!this.ready) this.close();
			});
			this.socket.on("close", (code) => {
				this.ready = false;
				this.responseActive = false;
				this.onEvent({ type: "closed", code });
				finish(new Error(`StepFun 实时语音连接已关闭 (${code})。`));
			});
		});
	}

	send(event) {
		if (!this.socket || this.socket.readyState !== 1) throw new Error("语音连接尚未就绪。");
		this.socket.send(JSON.stringify({ event_id: randomUUID(), ...event }));
	}

	appendAudio(audio) {
		if (!this.ready) throw new Error("语音会话尚未配置完成。");
		if (typeof audio !== "string" || !audio || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio) || audio.length % 4 !== 0) {
			throw new Error("输入音频应为 Base64 编码的 PCM16 数据。");
		}
		const bytes = Buffer.from(audio, "base64");
		if (bytes.length % 2 || bytes.length > 15 * 1024 * 1024) throw new Error("PCM16 音频长度无效或超出 15 MB。");
		this.send({ type: "input_audio_buffer.append", audio });
	}

	commitAudio({ respond = true } = {}) {
		this.send({ type: "input_audio_buffer.commit" });
		if (respond) this.send({ type: "response.create" });
	}

	clearAudio() {
		this.send({ type: "input_audio_buffer.clear" });
	}

	sendText(text) {
		this.addTextMessage("user", text);
		this.send({ type: "response.create" });
	}

	/** A background notification is system context, never a fabricated user turn. */
	sendContext(text, { respond = true } = {}) {
		this.addTextMessage("system", text);
		if (respond) this.send({ type: "response.create" });
	}

	addTextMessage(role, text) {
		if (typeof text !== "string" || !text.trim()) throw new Error("语音文本消息不能为空。");
		this.send({ type: "conversation.item.create", item: { type: "message", role, content: [{ type: "input_text", text }] } });
	}

	cancelResponse() {
		if (!this.responseActive) return false;
		this.send({ type: "response.cancel" });
		if (this.activeResponseId) {
			this.cancelledResponseIds.add(this.activeResponseId);
		}
		this.responseActive = false;
		this.hasCancelledResponse = true;
		this.muteOutput = true;
		return true;
	}

	submitToolResult(callId, result, { respond = true } = {}) {
		if (!callId) throw new Error("工具结果缺少 call_id。");
		this.send({
			type: "conversation.item.create",
			item: { type: "function_call_output", call_id: callId, output: typeof result === "string" ? result : JSON.stringify(result) },
		});
		if (respond) this.send({ type: "response.create" });
	}

	/** Correlate events whose documented examples omit response_id. */
	correlateEvent(raw) {
		const assistantItem = raw.item?.type === "function_call" || raw.item?.role === "assistant";
		if (!raw.type?.startsWith("response.") && !(raw.type === "conversation.item.created" && assistantItem)) return raw;
		const itemId = raw.item_id || raw.item?.id;
		const callId = raw.call_id || raw.item?.call_id;
		let responseId = raw.response_id || this.itemResponseIds.get(itemId) || this.callResponseIds.get(callId);
		const introducesItem = ["conversation.item.created", "response.output_item.added", "response.output_item.created"].includes(raw.type);
		const introducesCall = raw.type === "response.function_call_arguments.delta";
		if (!responseId && this.responseActive && this.activeResponseId) {
			// Lifecycle events introduce an item/call in the currently active response.
			// Once cancellation has occurred, an unannounced late output or completed
			// call cannot safely be attributed to the newly started response.
			if (introducesItem || introducesCall || !this.hasCancelledResponse) responseId = this.activeResponseId;
		}
		if (responseId) {
			if (itemId) this.itemResponseIds.set(itemId, responseId);
			if (callId) this.callResponseIds.set(callId, responseId);
			return { ...raw, response_id: responseId };
		}
		return raw;
	}

	shouldRespondToTool(event) {
		return !this.muteOutput && !this.cancelledResponseIds.has(event.responseId) && (!this.hasCancelledResponse || Boolean(event.responseId));
	}

	handleEvent(raw) {
		// In transcription-only sessions, discard locally rather than cancelling a
		// response: upstream cancellation can also interrupt input transcription.
		if (!this.delegate && (raw.type?.startsWith("response.") || raw.item?.role === "assistant" || raw.item?.type === "function_call")) return;
		const event = normalizeRealtimeEvent(this.correlateEvent(raw), { apiKey: this.config.apiKey });
		if (!event) return;
		if (event.type === "response.started") {
			if (this.cancelledResponseIds.has(event.responseId)) return;
			this.activeResponseId = event.responseId;
			this.responseActive = true;
			this.muteOutput = false;
		}
		if (event.type === "response.done" && (!event.responseId || event.responseId === this.activeResponseId)) this.responseActive = false;
		// StepFun answers our own response.cancel (barge-in, Ctrl+X, typed text) with status
		// "incomplete" and no details. That is a normal interruption, not a failed reply.
		if (event.type === "response.done" && event.status === "incomplete" && !event.statusDetails
			&& (this.cancelledResponseIds.has(event.responseId) || (this.hasCancelledResponse && !event.responseId))) {
			event.status = "cancelled";
			event.statusDetails = { reason: "client_cancelled" };
		}
		if (event.type === "speech.start" && this.autoBargeIn) this.cancelResponse();
		const fenced = this.muteOutput || this.cancelledResponseIds.has(event.responseId) || (this.hasCancelledResponse && !event.responseId);
		if (event.type.startsWith("output.") && fenced) return;
		if (event.type === "tool.invalid" || event.type === "tool.call") {
			if (this.handledToolCalls.has(event.callId)) return;
			// IDs remain deduplicated throughout the API's at-most-30-minute session.
			// Evicting old IDs would permit a replay to execute a host task twice.
			if (event.callId) this.handledToolCalls.add(event.callId);
			if (fenced) return;
			const invalid = event.type === "tool.invalid" ? event.message : toolArgumentError(event);
			if (invalid) {
				this.onEvent({ type: "error", code: "invalid_tool_arguments", message: invalid });
				if (event.callId) this.submitToolResult(event.callId, { error: invalid });
				return;
			}
			this.onEvent(event);
			if (this.onToolCall) {
				Promise.resolve()
					.then(() => {
						// Barge-in may arrive before this microtask begins host execution.
						if (this.socket?.readyState !== 1 || !this.shouldRespondToTool(event)) return undefined;
						return this.onToolCall(event);
					})
					.then((result) => {
						// An already-dispatched host task keeps running through barge-in.
						// Its delayed ack updates context without reviving cancelled speech.
						if (result !== undefined && this.socket?.readyState === 1) {
							this.submitToolResult(event.callId, result, { respond: this.shouldRespondToTool(event) });
						}
					})
					.catch((error) => {
						const message = sanitizeProviderError(error, this.config.apiKey);
						this.onEvent({ type: "error", code: "tool_failed", message });
						if (this.socket?.readyState === 1) this.submitToolResult(event.callId, { error: message }, { respond: this.shouldRespondToTool(event) });
					});
			}
			return;
		}
		this.onEvent(event);
	}

	close() {
		this.ready = false;
		this.responseActive = false;
		if (this.socket?.readyState === 0) this.socket.terminate?.();
		else if (this.socket?.readyState === 1) this.socket.close(1000);
	}
}

function abortable(promise, signal) {
	if (!signal) return promise;
	if (signal.aborted) {
		void Promise.resolve(promise).catch(() => {});
		return Promise.reject(signal.reason || new Error("语音请求已取消。"));
	}
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason || new Error("语音请求已取消。"));
		signal.addEventListener("abort", onAbort, { once: true });
		Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

async function authorizedFetch(config, path, body, { fetchImpl, signal }) {
	if (!config.apiKey) throw new Error("请配置 STEP_API_KEY 或 STEPFUN_API_KEY。");
	let response;
	try {
		signal?.throwIfAborted();
		response = await abortable(fetchImpl(`${config.baseUrl}${path}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
			body: JSON.stringify(body),
			signal,
		}), signal);
	} catch (error) {
		throw new Error(sanitizeProviderError(error, config.apiKey));
	}
	if (!response.ok) {
		const detail = await abortable(response.text(), signal);
		throw new Error(`StepFun HTTP ${response.status}: ${sanitizeProviderError(detail, config.apiKey)}`);
	}
	return response;
}

/** Handles UTF-8, CRLF, multi-line data and arbitrary network chunk boundaries. */
export async function* readSseEvents(body, { signal, onChunk = () => {} } = {}) {
	if (!body) throw new Error("StepFun SSE 响应缺少流。");
	const decoder = new TextDecoder();
	let pending = "";
	let dataLines = [];
	const consume = function* (line) {
		if (line === "") {
			if (dataLines.length) {
				const data = dataLines.join("\n");
				dataLines = [];
				signal?.throwIfAborted();
				if (data === "[DONE]") return true;
				let event;
				try {
					event = JSON.parse(data);
				} catch {
					throw new Error("StepFun SSE 返回了无效 JSON。");
				}
				// A single transport chunk can contain several events. Re-check after
				// each consumer resumes so cancellation fences already-buffered data.
				signal?.throwIfAborted();
				yield event;
			}
		} else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
	};
	const reader = typeof body.getReader === "function" ? body.getReader() : null;
	const iterator = reader ? null : body[Symbol.asyncIterator]();
	try {
		while (true) {
			signal?.throwIfAborted();
			const { value: chunk, done } = await abortable(reader ? reader.read() : iterator.next(), signal);
			if (done) break;
			onChunk();
			pending += decoder.decode(chunk, { stream: true });
			let newline;
			while ((newline = pending.indexOf("\n")) !== -1) {
				const line = pending.slice(0, newline).replace(/\r$/, "");
				pending = pending.slice(newline + 1);
				if (yield* consume(line)) return;
			}
		}
		pending += decoder.decode();
		if (pending && (yield* consume(pending.replace(/\r$/, "")))) return;
		yield* consume("");
	} finally {
		// Logical completion or cancellation must release a still-open HTTP body.
		// Do not await transport cleanup: a stalled transport must not stall teardown.
		if (reader) {
			void reader.cancel().catch(() => {});
			reader.releaseLock();
		} else if (iterator.return) {
			void Promise.resolve(iterator.return()).catch(() => {});
		}
	}
}

/** Optional segmented TTS route; the primary full-duplex model synthesizes natively. */
export async function synthesizeSpeech(config, text, { fetchImpl = globalThis.fetch, onAudio = () => {}, signal, timeoutMs = 30_000, speed = 1 } = {}) {
	if (typeof text !== "string" || !text.trim() || Array.from(text).length > 1_000) {
		throw new Error("StepFun TTS 文本必须为 1 到 1000 字符。");
	}
	const playbackSpeed = Math.min(2, Math.max(0.5, Number(speed) || 1));
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("StepFun TTS 超时时间必须大于 0 毫秒。");
	const request = new AbortController();
	let timer;
	const refreshTimeout = () => {
		clearTimeout(timer);
		timer = setTimeout(() => request.abort(new Error("StepFun TTS 等待语音数据超时，请检查网络后重试。")), timeoutMs);
	};
	const onAbort = () => request.abort(signal.reason || new Error("语音请求已取消。"));
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	refreshTimeout();
	try {
		const response = await authorizedFetch(
			config,
			"/audio/speech",
			{
				model: config.ttsModel,
				input: text,
				voice: config.voice,
				response_format: "pcm",
				sample_rate: REALTIME_SAMPLE_RATE,
				stream_format: "sse",
				speed: playbackSpeed,
				instruction: "自然、清晰、简短地说话，语气温暖，像面对面交谈。",
				markdown_filter: true,
			},
			{ fetchImpl, signal: request.signal },
		);
		refreshTimeout();
		const audio = [];
		let done = false;
		for await (const event of readSseEvents(response.body, { signal: request.signal, onChunk: refreshTimeout })) {
			request.signal.throwIfAborted();
			if (event.type === "speech.audio.delta") {
				const chunk = Buffer.from(event.audio || "", "base64");
				audio.push(chunk);
				request.signal.throwIfAborted();
				await abortable(onAudio(chunk, { sampleRate: REALTIME_SAMPLE_RATE, format: "pcm16" }), request.signal);
			} else if (event.type === "speech.audio.done") {
				done = true;
				break;
			} else if (event.type === "speech.audio.error" || event.type === "error") {
				throw new Error(sanitizeProviderError(event.message || event.error?.message || "StepFun TTS 生成失败。", config.apiKey));
			}
		}
		if (!done) throw new Error("StepFun TTS 流在完成前关闭。");
		request.signal.throwIfAborted();
		return { audio: Buffer.concat(audio), format: "pcm16", sampleRate: REALTIME_SAMPLE_RATE };
	} catch (error) {
		throw new Error(sanitizeProviderError(error, config.apiKey));
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		request.abort();
	}
}

/** LLM 摘要用于播报：把任务结果压缩到标准时长内；任何失败都由调用方回退为截断。 */
export async function summarizeForSpeech(config, text, { fetchImpl = globalThis.fetch, signal, timeoutMs = 60_000, maxChars = 80 } = {}) {
	const chars = Array.from(String(text || "").trim());
	if (!chars.length) throw new Error("没有可总结的内容。");
	if (chars.length <= maxChars) return chars.join("");
	const request = new AbortController();
	const onAbort = () => request.abort(signal.reason || new Error("总结请求已取消。"));
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const response = await authorizedFetch(config, "/chat/completions", {
			model: config.summaryModel,
			messages: [
				{ role: "system", content: `你是编码任务播报编辑。把用户提供的任务执行结果压缩成不超过 ${maxChars} 字的口语化中文摘要：只保留结论、关键改动和下一步，不要代码块、不要列表符号、不要客套话。` },
				{ role: "user", content: chars.join("") },
			],
			temperature: 0.2,
			max_tokens: 8_000,
			stream: false,
		}, { fetchImpl, signal: request.signal });
		const payload = await response.json();
		if (!response.ok) throw new Error(sanitizeProviderError(payload?.error?.message || `HTTP ${response.status}`, config.apiKey));
		const choice = payload?.choices?.[0];
		const content = String(choice?.message?.content || "").replace(/```[\s\S]*?```/g, " ").trim();
		const summary = Array.from(content).slice(0, maxChars * 2).join("");
		if (!summary) {
			// 思考型模型常因 token 预算不足只输出了推理过程。
			throw new Error(`总结为空（${choice?.finish_reason ? `finish_reason=${choice.finish_reason}` : "模型未返回文本"}）。`);
		}
		return summary;
	} catch (error) {
		throw new Error(sanitizeProviderError(error, config.apiKey));
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

/** Optional turn-based ASR upload. PCM callers must supply the real recording rate. */
export async function transcribeAudio(
	config,
	audio,
	{ fetchImpl = globalThis.fetch, format = "pcm", sampleRate = 16_000, language = "zh", onDelta = () => {}, signal } = {},
) {
	if (!["pcm", "wav", "mp3", "ogg", "m4a"].includes(format)) throw new Error("StepFun ASR 不支持该音频格式。");
	const bytes = Buffer.from(audio);
	if (!bytes.length) throw new Error("ASR 音频不能为空。");
	if (format === "pcm" && (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 48_000 || bytes.length % 2)) {
		throw new Error("ASR PCM 必须是有效单声道 PCM16 音频，且带正确采样率。");
	}
	const response = await authorizedFetch(
		config,
		"/audio/asr/sse",
		{
			audio: {
				data: bytes.toString("base64"),
				input: {
					transcription: { model: config.asrModel, language, hotwords: [], enable_itn: true, enable_timestamp: false },
					format: format === "pcm" ? { type: "pcm", codec: "pcm_s16le", rate: sampleRate, bits: 16, channel: 1 } : { type: format },
				},
			},
		},
		{ fetchImpl, signal },
	);
	let text = "";
	let final = null;
	for await (const event of readSseEvents(response.body)) {
		if (event.type === "transcript.text.delta") {
			text += String(event.delta || "");
			await onDelta(String(event.delta || ""), text);
		} else if (event.type === "transcript.text.done") final = String(event.text ?? text);
		else if (event.type === "error") throw new Error(sanitizeProviderError(event.message || event.error?.message, config.apiKey));
	}
	if (final === null) throw new Error("StepFun ASR 流在完整转录前关闭。");
	return final;
}
