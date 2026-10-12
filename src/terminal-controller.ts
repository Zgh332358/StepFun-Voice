import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { AgentSnapshot, VoiceDelivery } from "./types.ts";
import { ResponseFence } from "./audio.mjs";
export { ResponseFence as TerminalResponseFence } from "./audio.mjs";

export type VoiceState = "stopped" | "connecting" | "ready" | "error";
export type VoiceStartupPhase = "idle" | "preparing-audio" | "opening-microphone" | "connecting-model" | "ready" | "stopping" | "error";
export type VoiceChannel = "api" | "step_plan";
export interface TerminalVoiceConfig {
	baseUrl: string;
	realtimeModel: string;
	ttsModel: string;
	voice: string;
	keyConfigured: boolean;
	channel: VoiceChannel;
	/** Where the active Key comes from: the panel setup, the environment, or nowhere */
	keySource: "saved" | "env" | "";
	/** The first-run setup has been completed */
	setupDone: boolean;
	/** Last four characters of STEP_API_KEY / STEPFUN_API_KEY, if set */
	envKeyHint: string;
	/** Last four characters of the active Key */
	keyHint: string;
}
export interface CredentialsResult { ok: boolean; message: string; file?: string }
export interface TerminalTranscript {
	id: string;
	role: "user" | "assistant";
	text: string;
	final: boolean;
	source?: string;
}
export interface TerminalActivity {
	id: number;
	text: string;
	kind: "info" | "error";
	time: number;
}
export interface TerminalVoiceSnapshot {
	connection: "disconnected" | "connecting" | "connected";
	voice: VoiceState;
	startupPhase: VoiceStartupPhase;
	muted: boolean;
	micLevel: number;
	speaking: boolean;
	config: TerminalVoiceConfig;
	agentConnected: boolean;
	agent?: AgentSnapshot;
	transcripts: TerminalTranscript[];
	activity: TerminalActivity[];
	notice?: { kind: "info" | "warning" | "error"; text: string };
	lastAgentText: string;
	/** Progress of a Key check started from the setup view */
	setup: { phase: "idle" | "checking" | "saved" | "invalid"; message: string };
}
export interface NativeAudioCallbacks {
	onAudio(audioBase64: string): void;
	onLevel(level: number): void;
	onPlayback(playing: boolean): void;
	onError(error: unknown): void;
	onClosed(): void;
	onNotice?(message: string): void;
	onStatus?(status: "preparing" | "permission" | "ready", message?: string): void;
}
export interface NativeAudioAdapter {
	start(): Promise<void>;
	play(audioBase64: string, sampleRate?: number): void;
	clear(): void;
	setMuted(value: boolean): void;
	stop(): Promise<void>;
}
interface VoiceSocket {
	readyState: number;
	send(data: string): void;
	close(): void;
	on(name: string, callback: (...args: unknown[]) => void): unknown;
}
interface VoiceSocketConstructor {
	new (url: string, protocols: string[], options: { headers: Record<string, string> }): VoiceSocket;
}
export interface TerminalVoiceControllerOptions {
	url: string;
	audioFactory?: (callbacks: NativeAudioCallbacks) => NativeAudioAdapter | Promise<NativeAudioAdapter>;
	WebSocketImpl?: VoiceSocketConstructor;
	connectTimeoutMs?: number;
	audioStartTimeoutMs?: number;
	modelReadyTimeoutMs?: number;
	audioStopTimeoutMs?: number;
}
export interface NormalizedVoiceEvent {
	type: string;
	voiceSessionId?: string;
	state?: VoiceState;
	config?: Partial<TerminalVoiceConfig>;
	agentConnected?: boolean;
	agent?: AgentSnapshot;
	snapshot?: AgentSnapshot;
	text?: string;
	message?: string;
	itemId?: string;
	responseId?: string;
	source?: string;
	audio?: string;
	sampleRate?: number;
	status?: string;
	statusDetails?: { reason?: string; error?: { message?: string; code?: string } };
	queued?: boolean;
	toolName?: string;
	isError?: boolean;
}
type NormalizedEvent = NormalizedVoiceEvent;
type SnapshotListener = (snapshot: TerminalVoiceSnapshot, event?: NormalizedEvent) => void;

const ENV_HELP = "还没有配置 API Key。在语音面板按 Enter 按引导选择通道并输入 Key；也可以在启动 Step Code 前 export STEP_API_KEY。";
const MAX_HISTORY = 100;
const MAX_TEXT = 12_000;
const DefaultWebSocket = createRequire(import.meta.url)("ws") as VoiceSocketConstructor;

type StartupCancellation = "cancelled" | "timeout";
interface StartupGate {
	generation: number;
	cancelled: Promise<StartupCancellation>;
	cancel(reason?: StartupCancellation): void;
	reason?: StartupCancellation;
	timer?: ReturnType<typeof setTimeout>;
}
class StartupCancelledError extends Error {
	reason: StartupCancellation;
	constructor(reason: StartupCancellation) { super(reason); this.reason = reason; }
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error || "未知错误");
}

/** A local normalized-protocol client. No credential file discovery or browser is involved. */
export class TerminalVoiceController {
	private options: TerminalVoiceControllerOptions;
	private socket?: VoiceSocket;
	private audio?: NativeAudioAdapter;
	private audioGeneration = 0;
	private voiceSessionId?: string;
	private startup?: StartupGate;
	private modelReadyTimer?: ReturnType<typeof setTimeout>;
	private connectPromise?: Promise<void>;
	private connectedResolve?: () => void;
	private connectedReject?: (error: Error) => void;
	private connectTimer?: ReturnType<typeof setTimeout>;
	private disposed = false;
	private listeners = new Set<SnapshotListener>();
	private sequence = 0;
	private outputKey?: string;
	private fence = new ResponseFence();
	private credentialsWaiter?: (result: CredentialsResult) => void;
	private state: TerminalVoiceSnapshot = {
		connection: "disconnected", voice: "stopped", startupPhase: "idle", muted: false, micLevel: 0, speaking: false,
		config: { baseUrl: "https://api.stepfun.com/v1", realtimeModel: "stepaudio-3-realtime-preview", ttsModel: "stepaudio-3-tts", voice: "linjiajiejie", keyConfigured: false, channel: "api", keySource: "", setupDone: false, envKeyHint: "", keyHint: "" },
		agentConnected: false, transcripts: [], activity: [], lastAgentText: "", setup: { phase: "idle", message: "" },
	};

	constructor(options: TerminalVoiceControllerOptions) { this.options = options; }

	snapshot(): TerminalVoiceSnapshot {
		return { ...this.state, config: { ...this.state.config }, setup: { ...this.state.setup }, agent: this.state.agent ? { ...this.state.agent } : undefined,
			transcripts: this.state.transcripts.map((entry) => ({ ...entry })), activity: this.state.activity.map((entry) => ({ ...entry })),
			notice: this.state.notice ? { ...this.state.notice } : undefined };
	}

	subscribe(listener: SnapshotListener): () => void {
		this.listeners.add(listener);
		listener(this.snapshot());
		return () => { this.listeners.delete(listener); };
	}

	private emit(event?: NormalizedEvent): void {
		for (const listener of this.listeners) {
			try { listener(this.snapshot(), event); } catch { /* A closed terminal view cannot interrupt audio or the host. */ }
		}
	}
	private notice(text: string, kind: "info" | "warning" | "error" = "info"): void {
		this.state.notice = { text, kind };
		this.emit();
	}
	private send(message: { type: string; [key: string]: unknown }): void {
		if (this.disposed || !this.socket || this.socket.readyState !== 1) throw new Error("本地语音服务未连接。请重新运行 /voice。");
		this.socket.send(JSON.stringify(message));
	}
	private addActivity(text: string, kind: "info" | "error" = "info"): void {
		if (!text) return;
		this.state.activity.push({ id: ++this.sequence, text, kind, time: Date.now() });
		if (this.state.activity.length > MAX_HISTORY) this.state.activity.shift();
	}
	private transcript(role: "user" | "assistant", text: string, id?: string, append = false, final = true, source?: string): void {
		if (!text) return;
		const key = id || `${role}-${++this.sequence}`;
		const existing = this.state.transcripts.find((entry) => entry.id === key);
		if (existing) { existing.text = append ? existing.text + text : text; existing.final = final; }
		else this.state.transcripts.push({ id: key, role, text, final, source });
		if (this.state.transcripts.length > MAX_HISTORY) this.state.transcripts.shift();
	}
	private clearPlayback(interrupted = false): void {
		if (interrupted) this.fence.interrupt();
		this.state.speaking = false;
		for (const entry of this.state.transcripts) entry.final = true;
		this.audio?.clear();
	}
	private createStartupGate(generation: number): StartupGate {
		let resolveCancellation: (reason: StartupCancellation) => void = () => {};
		const gate: StartupGate = {
			generation,
			cancelled: new Promise((resolve) => { resolveCancellation = resolve; }),
			cancel(reason = "cancelled") {
				if (gate.reason) return;
				gate.reason = reason; clearTimeout(gate.timer); gate.timer = undefined;
				resolveCancellation(reason);
			},
		};
		gate.timer = setTimeout(() => gate.cancel("timeout"), this.options.audioStartTimeoutMs ?? 75_000);
		this.startup = gate;
		return gate;
	}
	private finishStartupGate(gate: StartupGate): void {
		clearTimeout(gate.timer); gate.timer = undefined;
		if (this.startup === gate) this.startup = undefined;
	}
	private async awaitStartup<T>(operation: Promise<T>, gate: StartupGate): Promise<T> {
		const outcome = await Promise.race([
			operation.then((value) => ({ value })),
			gate.cancelled.then((reason) => ({ reason })),
		]);
		if ("reason" in outcome) throw new StartupCancelledError(outcome.reason);
		return outcome.value;
	}
	private async stopAdapter(audio: NativeAudioAdapter): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.resolve().then(() => audio.stop()),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error("本机音频进程停止超时，请检查终端的麦克风状态。")), this.options.audioStopTimeoutMs ?? 2000);
				}),
			]);
		} finally { clearTimeout(timer); }
	}
	private failAudioSession(generation: number, message: string): void {
		if (generation !== this.audioGeneration || this.disposed) return;
		this.notice(message, "error");
		void this.stopWithState(true, "error");
	}

	connect(): Promise<void> {
		if (this.disposed) return Promise.reject(new Error("语音控制器已关闭。"));
		if (this.state.connection === "connected") return Promise.resolve();
		if (this.connectPromise) return this.connectPromise;
		this.state.connection = "connecting"; this.emit();
		this.connectPromise = new Promise<void>((resolve, reject) => {
			this.connectedResolve = resolve; this.connectedReject = reject;
			try {
				const url = new URL(this.options.url);
				if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) throw new Error("语音控制器只接受插件生成的本机服务地址。");
				const token = new URLSearchParams(url.hash.slice(1)).get("token") || url.hash.slice(1);
				if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("本地语音连接凭证无效，请重新运行 /voice。");
				const Socket = this.options.WebSocketImpl || DefaultWebSocket;
				this.socket = new Socket(`ws://${url.host}/ws`, ["step-voice", token], { headers: { Origin: url.origin } });
				this.socket.on("message", (data: unknown) => {
					try { this.handleEvent(JSON.parse(String(data))); }
					catch (error) { this.notice(`本地语音消息读取失败：${errorText(error)}`, "error"); }
				});
				this.socket.on("error", (error: unknown) => {
					this.failConnection(new Error(`本地语音连接失败：${errorText(error)}`));
					void this.stop(false);
				});
				this.socket.on("close", () => {
					this.state.connection = "disconnected"; this.state.agentConnected = false;
					this.failConnection(new Error("本地语音服务已关闭，请重新运行 /voice。"));
					void this.stop(false);
				});
				this.connectTimer = setTimeout(() => {
					this.failConnection(new Error("本地语音服务连接超时，请重新运行 /voice。")); this.socket?.close();
				}, this.options.connectTimeoutMs ?? 8000);
			} catch (error) { this.failConnection(new Error(errorText(error))); }
		});
		// Callers may await this promise; keep an internal handler for terminal teardown races.
		void this.connectPromise.catch(() => {});
		return this.connectPromise;
	}
	private failConnection(error: Error): void {
		clearTimeout(this.connectTimer); this.connectTimer = undefined;
		this.connectedReject?.(error); this.connectedReject = undefined; this.connectedResolve = undefined;
		this.state.connection = "disconnected";
		if (!this.disposed) this.notice(error.message, "error");
	}

	private async createAudio(generation: number): Promise<NativeAudioAdapter> {
		const callbacks: NativeAudioCallbacks = {
			onAudio: (audio) => {
				if (generation === this.audioGeneration && !this.disposed && this.state.voice === "ready" && !this.state.muted) {
					try { this.send({ type: "audio.append", audio }); } catch (error) { this.notice(errorText(error), "error"); }
				}
			},
			onLevel: (level) => { if (generation !== this.audioGeneration) return; this.state.micLevel = this.state.muted || this.state.voice !== "ready" ? 0 : Math.max(0, Math.min(1, level)); this.emit(); },
			onPlayback: (playing) => { if (generation !== this.audioGeneration) return; this.state.speaking = playing && this.state.voice === "ready"; this.emit(); },
			onError: (error) => {
				this.failAudioSession(generation, `本机音频出错：${errorText(error)}`);
			},
			onClosed: () => {
				if (this.state.voice === "stopped") return;
				this.failAudioSession(generation, "本机音频进程已结束，请检查麦克风权限后重新开始。");
			},
			onNotice: (message) => { if (generation === this.audioGeneration && !this.disposed) this.notice(message); },
			onStatus: (status, message) => {
				if (generation !== this.audioGeneration || this.disposed || this.state.voice !== "connecting") return;
				this.state.startupPhase = status === "preparing" ? "preparing-audio" : status === "permission" ? "opening-microphone" : "connecting-model";
				if (message) this.state.notice = { kind: "info", text: message };
				this.emit();
			},
		};
		if (this.options.audioFactory) return this.options.audioFactory(callbacks);
		const { NativeAudioEngine } = await import("./native-audio.mjs");
		return new NativeAudioEngine(callbacks) as NativeAudioAdapter;
	}

	/** Only an explicit terminal Start command may call this; connect() never opens the microphone. */
	async start(): Promise<void> {
		if (this.disposed) throw new Error("语音控制器已关闭。请重新运行 /voice。");
		if (this.state.connection !== "connected") await this.connect();
		if (this.state.voice === "ready" || this.state.voice === "connecting") return;
		if (!this.state.config.keyConfigured) { this.notice(ENV_HELP, "warning"); return; }
		const generation = ++this.audioGeneration;
		const voiceSessionId = `${generation}-${randomUUID()}`;
		this.voiceSessionId = voiceSessionId;
		const gate = this.createStartupGate(generation);
		this.state.voice = "connecting"; this.state.startupPhase = "preparing-audio"; this.state.muted = false; this.state.notice = undefined;
		this.fence.reset(); this.outputKey = undefined; this.emit();
		try {
			const creatingAudio = this.createAudio(generation);
			// A factory may resolve after cancellation. Dispose it without ever opening its microphone.
			void creatingAudio.then((audio) => {
				if (gate.reason || generation !== this.audioGeneration || this.disposed) void this.stopAdapter(audio).catch(() => {});
			}, () => {});
			const audio = await this.awaitStartup(creatingAudio, gate);
			if (generation !== this.audioGeneration || this.disposed) { void this.stopAdapter(audio).catch(() => {}); return; }
			this.audio = audio;
			this.state.startupPhase = "opening-microphone"; this.emit();
			await this.awaitStartup(Promise.resolve().then(() => {
				if (gate.reason || generation !== this.audioGeneration || this.disposed) throw new StartupCancelledError(gate.reason || "cancelled");
				return audio.start();
			}), gate);
			if (generation !== this.audioGeneration || this.disposed) return;
			this.finishStartupGate(gate);
			this.state.startupPhase = "connecting-model";
			this.send({ type: "voice.start", voiceSessionId });
			if (generation === this.audioGeneration && this.state.voice === "connecting") {
				clearTimeout(this.modelReadyTimer);
				this.modelReadyTimer = setTimeout(() => {
					this.failAudioSession(generation, "StepFun 语音会话等待就绪超时。请检查 API Key、模型权限与网络，再重新开始。");
				}, this.options.modelReadyTimeoutMs ?? 25_000);
			}
			this.emit();
		} catch (error) {
			if (generation !== this.audioGeneration || this.disposed) return;
			if (error instanceof StartupCancelledError && error.reason === "cancelled") return;
			const message = error instanceof StartupCancelledError
				? "本机音频准备或麦克风启动超时。可以重新开始，或检查 macOS 麦克风权限与音频助手。"
				: `语音启动失败：${errorText(error)}`;
			this.notice(message, "error");
			await this.stopWithState(false, "error");
		} finally { this.finishStartupGate(gate); }
	}

	setMuted(value: boolean): void {
		if (this.state.voice !== "ready" && this.state.voice !== "connecting") return;
		this.state.muted = Boolean(value); this.state.micLevel = 0;
		this.audio?.setMuted(this.state.muted); this.emit();
	}
	mute(value = !this.state.muted): void { this.setMuted(value); }
	interrupt(): void {
		if (this.state.voice !== "ready") return;
		this.clearPlayback(true); this.send({ type: "voice.interrupt" }); this.emit();
	}
	stop(notifyServer = true): Promise<void> { return this.stopWithState(notifyServer, "stopped"); }
	private async stopWithState(notifyServer: boolean, finalState: "stopped" | "error"): Promise<void> {
		const generation = ++this.audioGeneration;
		// Retain the stopped identity for acknowledgements; a reentrant start may replace the field after emit().
		const voiceSessionId = this.voiceSessionId;
		this.startup?.cancel(); this.startup = undefined;
		clearTimeout(this.modelReadyTimer); this.modelReadyTimer = undefined;
		const audio = this.audio; this.audio = undefined;
		this.state.voice = finalState; this.state.startupPhase = finalState === "error" ? "error" : audio ? "stopping" : "idle";
		this.state.muted = false; this.state.micLevel = 0; this.state.speaking = false;
		for (const entry of this.state.transcripts) entry.final = true;
		this.fence.reset(); this.emit();
		const problems: string[] = [];
		let cleanupFailed = false;
		try { audio?.clear(); } catch (error) { problems.push(`清除播放队列失败：${errorText(error)}`); }
		try {
			if (notifyServer && this.socket?.readyState === 1 && !this.disposed) this.send({ type: "voice.stop", voiceSessionId });
		} catch (error) { problems.push(`关闭上游语音失败：${errorText(error)}`); }
		// Neither a playback IPC failure nor a socket failure may skip microphone cleanup.
		try { if (audio) await this.stopAdapter(audio); }
		catch (error) { cleanupFailed = true; problems.push(`音频停止失败：${errorText(error)}`); }
		finally {
			if (generation === this.audioGeneration && !this.disposed) {
				if (cleanupFailed) this.state.voice = "error";
				this.state.startupPhase = this.state.voice === "error" ? "error" : "idle";
				if (problems.length) this.state.notice = { kind: cleanupFailed ? "error" : "warning", text: problems.join("；") };
				this.emit();
			}
		}
	}
	private textValue(text: string): string {
		const value = text.trim();
		if (!value || value.length > MAX_TEXT) throw new Error("请输入 1–12000 字的内容。");
		return value;
	}
	sendText(text: string): void {
		if (this.state.voice !== "ready") throw new Error("请先开始语音通话，再发送对话文字。");
		const value = this.textValue(text); this.clearPlayback(true);
		this.send({ type: "input.text", text: value }); this.emit();
	}
	submitTask(text: string, delivery: VoiceDelivery = "steer"): void {
		if (!this.state.agentConnected) throw new Error("后台编码任务未连接，请从 Step Code 当前会话运行 /voice。");
		if (delivery !== "steer" && delivery !== "followUp") throw new Error("任务发送方式无效。");
		const value = this.textValue(text);
		this.send({ type: "agent.submit", text: value, delivery });
		this.transcript("user", value); this.addActivity(delivery === "followUp" ? "正在排入后续任务" : "正在提交任务"); this.emit();
	}
	cancelTask(): void {
		if (!this.state.agentConnected) throw new Error("后台编码任务未连接。");
		this.send({ type: "agent.cancel" }); this.addActivity("正在请求停止后台任务"); this.emit();
	}
	/**
	 * Check a Key against the chosen channel and save it (first-run setup).
	 * Pass an empty key with useEnvKey to keep the Key from the environment.
	 */
	saveCredentials(channel: VoiceChannel, apiKey: string, useEnvKey = false): Promise<CredentialsResult> {
		if (this.state.voice === "ready" || this.state.voice === "connecting") return Promise.reject(new Error("请先结束语音通话，再修改接入设置。"));
		if (this.credentialsWaiter) return Promise.reject(new Error("正在验证上一个 Key，请稍候。"));
		const key = apiKey.trim();
		this.state.setup = { phase: "checking", message: "正在验证 Key 和通道…" }; this.emit();
		return new Promise<CredentialsResult>((resolve, reject) => {
			this.credentialsWaiter = resolve;
			try { this.send({ type: "credentials.save", channel, apiKey: key, useEnvKey: useEnvKey && !key }); }
			catch (error) { this.credentialsWaiter = undefined; this.state.setup = { phase: "invalid", message: errorText(error) }; this.emit(); reject(error); }
		});
	}
	clearCredentials(): void {
		if (this.state.voice === "ready" || this.state.voice === "connecting") throw new Error("请先结束语音通话，再修改接入设置。");
		this.send({ type: "credentials.clear" });
	}
	private settleCredentials(result: CredentialsResult): void {
		const resolve = this.credentialsWaiter; this.credentialsWaiter = undefined;
		resolve?.(result);
	}

	reloadConfigFromEnvironment(env: Record<string, string | undefined> = process.env): void {
		if (this.state.voice === "ready" || this.state.voice === "connecting") throw new Error("请先结束语音通话，再重新读取环境变量。");
		const config: Record<string, string> = {};
		const fields = { STEP_VOICE_BASE_URL: "baseUrl", STEP_VOICE_REALTIME_MODEL: "realtimeModel", STEP_VOICE_TTS_MODEL: "ttsModel", STEP_VOICE_VOICE: "voice" };
		for (const [name, field] of Object.entries(fields)) if (env[name]?.trim()) config[field] = env[name]!.trim();
		const key = env.STEP_API_KEY?.trim() || env.STEPFUN_API_KEY?.trim();
		if (key) config.apiKey = key;
		else if (!this.state.config.keyConfigured) { this.notice(ENV_HELP, "warning"); return; }
		this.send({ type: "config.update", config });
	}

	private handleEvent(event: NormalizedEvent): void {
		if (!event || typeof event.type !== "string" || this.disposed) return;
		// A stopped provider may deliver frames after a rapid restart. Legacy unscoped frames remain compatible.
		if (event.voiceSessionId !== undefined && event.voiceSessionId !== this.voiceSessionId) return;
		switch (event.type) {
			case "server.ready":
				this.state.connection = "connected"; this.state.agentConnected = Boolean(event.agentConnected);
				this.applyPublicConfig(event.config); this.state.agent = event.agent;
				if (event.agent?.lastResponse) this.state.lastAgentText = event.agent.lastResponse;
				if (!this.state.config.keyConfigured) this.state.notice = { kind: "warning", text: ENV_HELP };
				clearTimeout(this.connectTimer); this.connectTimer = undefined;
				this.connectedResolve?.(); this.connectedResolve = undefined; this.connectedReject = undefined;
				break;
			case "credentials.checking": this.state.setup = { phase: "checking", message: "正在验证 Key 和通道…" }; break;
			case "credentials.invalid":
				this.state.setup = { phase: "invalid", message: event.message || "验证失败。" };
				this.settleCredentials({ ok: false, message: this.state.setup.message });
				break;
			case "credentials.saved": {
				this.applyPublicConfig(event.config);
				const cleared = (event as { cleared?: boolean }).cleared;
				const file = (event as { file?: string }).file;
				this.state.setup = { phase: cleared ? "idle" : "saved", message: cleared ? "" : "验证通过，已保存。" };
				this.state.notice = cleared ? { kind: "info", text: "已清除面板里保存的 Key。" } : undefined;
				if (!cleared) this.settleCredentials({ ok: true, message: this.state.setup.message, file });
				break;
			}
			case "config.saved": this.applyPublicConfig(event.config); this.state.notice = { kind: "info", text: "已重新读取环境变量。点击开始语音即可连接。" }; break;
			case "voice.state":
				if (event.state === "ready" && this.audio && this.state.voice === "connecting") {
					clearTimeout(this.modelReadyTimer); this.modelReadyTimer = undefined;
					this.state.voice = "ready"; this.state.startupPhase = "ready";
				} else if (event.state === "connecting" && this.audio && this.state.voice === "connecting") this.state.startupPhase = "connecting-model";
				else if (event.state === "stopped" || event.state === "error") void this.stopWithState(false, event.state);
				break;
			case "speech.start": this.clearPlayback(true); break;
			case "speech.end": this.state.micLevel = 0; break;
			case "audio.clear": this.clearPlayback(true); break;
			case "response.started": if (this.fence.start(event.responseId)) this.outputKey = undefined; break;
			case "input.transcript.final": this.transcript("user", event.text || "", event.itemId); break;
			case "output.transcript.delta":
				if (!this.fence.accept(event.responseId)) break;
				this.outputKey = event.itemId || event.responseId || this.outputKey || `assistant-${++this.sequence}`;
				this.transcript("assistant", event.text || "", this.outputKey, true, false, event.source); break;
			case "output.transcript.final":
				if (!this.fence.accept(event.responseId)) break;
				this.outputKey = event.itemId || event.responseId || this.outputKey || `assistant-${++this.sequence}`;
				this.transcript("assistant", event.text || "", this.outputKey, false, true, event.source); break;
			case "output.audio.delta":
				if (this.state.voice !== "ready" || !this.audio || !this.fence.accept(event.responseId)) break;
				if (event.responseId && event.responseId !== this.fence.activeId) this.fence.start(event.responseId);
				if (typeof event.audio !== "string" || !event.audio || !/^[A-Za-z0-9+/]+={0,2}$/.test(event.audio) || event.audio.length % 4 || Buffer.from(event.audio, "base64").length % 2) throw new Error("语音模型返回了无效的 PCM16 音频。");
				if (event.sampleRate !== undefined && (!Number.isFinite(event.sampleRate) || event.sampleRate < 8000 || event.sampleRate > 192000)) throw new Error("语音模型返回了无效的采样率。");
				this.audio.play(event.audio, event.sampleRate || 24000); break;
			case "response.done":
				if (event.responseId && this.fence.activeId && event.responseId !== this.fence.activeId) break;
				if (this.outputKey) { const entry = this.state.transcripts.find((item) => item.id === this.outputKey); if (entry) entry.final = true; }
				this.outputKey = undefined;
				if (event.status === "failed") this.state.notice = { kind: "error", text: `语音回复失败：${event.statusDetails?.error?.message || event.statusDetails?.error?.code || "请检查模型访问权限与网络后重试。"}` };
				else if (event.status === "incomplete") this.state.notice = { kind: "warning", text: `语音回复未完整生成：${event.statusDetails?.reason || "可以继续说话或重试。"}` };
				break;
			case "task.accepted": this.addActivity(event.queued ? "任务已排入队列" : "已交给 Step Code 后台执行"); break;
			case "agent.status": this.updateAgent(event); break;
			case "agent.text": this.updateAgent(event); if (event.text) this.state.lastAgentText = event.text; break;
			case "agent.tool": this.updateAgent(event); this.addActivity(`工具活动 · ${event.toolName || "工具"}`, event.isError ? "error" : "info"); break;
			case "agent.complete": this.updateAgent(event); if (event.text) this.state.lastAgentText = event.text; this.addActivity(event.isError ? "后台任务未成功完成或已停止" : "后台任务已完成", event.isError ? "error" : "info"); break;
			case "agent.error": this.updateAgent(event); this.addActivity(event.text || "后台任务执行出错", "error"); break;
			case "error":
				this.state.notice = { kind: "error", text: event.message || "语音服务发生错误。" };
				if (this.credentialsWaiter) { this.state.setup = { phase: "invalid", message: this.state.notice.text }; this.settleCredentials({ ok: false, message: this.state.notice.text }); }
				break;
			case "closed": void this.stop(false); this.state.notice = { kind: "info", text: "语音会话已结束，可以重新开始。" }; break;
		}
		this.emit(event);
	}
	private applyPublicConfig(config: unknown): void {
		if (!config || typeof config !== "object") return;
		const value = config as Record<string, unknown>;
		for (const field of ["baseUrl", "realtimeModel", "ttsModel", "voice", "envKeyHint", "keyHint"] as const) if (typeof value[field] === "string") this.state.config[field] = value[field];
		if (value.channel === "api" || value.channel === "step_plan") this.state.config.channel = value.channel;
		if (value.keySource === "saved" || value.keySource === "env" || value.keySource === "") this.state.config.keySource = value.keySource;
		for (const field of ["keyConfigured", "setupDone"] as const) if (typeof value[field] === "boolean") this.state.config[field] = value[field];
	}
	private updateAgent(event: NormalizedEvent): void {
		if (!event.snapshot) return;
		this.state.agent = event.snapshot;
		if (event.snapshot.lastResponse) this.state.lastAgentText = event.snapshot.lastResponse;
	}
	async dispose(): Promise<void> {
		if (this.disposed) return;
		await this.stop(); this.disposed = true;
		clearTimeout(this.connectTimer); this.connectTimer = undefined;
		this.connectedReject?.(new Error("语音控制器已关闭。")); this.connectedReject = undefined; this.connectedResolve = undefined;
		this.settleCredentials({ ok: false, message: "语音控制器已关闭。" });
		this.socket?.close(); this.socket = undefined;
		this.state.connection = "disconnected"; this.state.agentConnected = false; this.emit(); this.listeners.clear();
	}
	close(): Promise<void> { return this.dispose(); }
}

export function createTerminalVoiceController(options: TerminalVoiceControllerOptions): TerminalVoiceController {
	return new TerminalVoiceController(options);
}
