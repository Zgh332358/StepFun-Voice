import type { ExtensionCommandContext } from "@step-harness/coding-agent";
import {
	Input,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TUI,
} from "@step-harness/pi-tui";
import type { AgentSnapshot, TerminalVoiceController, TerminalVoiceSnapshot, VoiceDelivery } from "./types.ts";

type VoiceTheme = ExtensionCommandContext["ui"]["theme"];
type PanelResult = "hide" | "end";
type Channel = "api" | "step_plan";

/** Mirrors src/credentials.mjs CHANNELS (kept here so the TUI module has no runtime import). */
export const CHANNEL_INFO: Record<Channel, { label: string; billing: string; realtime: string; tts: string }> = {
	api: { label: "开放平台 API", billing: "按调用量计费", realtime: "stepaudio-3-realtime-preview", tts: "stepaudio-3-tts" },
	step_plan: { label: "Step Plan", billing: "使用订阅套餐额度", realtime: "stepaudio-2.5-realtime", tts: "stepaudio-2.5-tts" },
};
const CHANNEL_ORDER: Channel[] = ["api", "step_plan"];
const KEY_URL = "https://platform.stepfun.com/interface-key";
const PLAN_URL = "https://platform.stepfun.com/step-plan";

/** Show only the last four characters of a Key that is being typed. */
export function maskKey(value: string): string {
	if (!value) return "";
	const dots = "•".repeat(Math.min(Math.max(value.length - 4, 0), 40));
	return value.length > 8 ? `${dots}${value.slice(-4)}` : "•".repeat(value.length);
}

function clean(value: unknown): string {
	return stripTerminalSequences(String(value ?? "")).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function voiceStateLabel(state: TerminalVoiceSnapshot): string {
	if (state.connection !== "connected") return state.connection === "connecting" ? "连接本地服务" : "服务未连接";
	if (state.voice === "connecting") {
		if (state.startupPhase === "preparing-audio") return "准备本地音频助手 · 首次启动可能需要编译";
		if (state.startupPhase === "opening-microphone") return "打开麦克风 · 请确认系统权限提示";
		return "连接 StepFun 语音模型";
	}
	if (state.startupPhase === "stopping") return "正在结束语音";
	if (state.voice === "error") return "语音连接出错";
	if (state.voice !== "ready") return "准备开始";
	return state.muted ? "麦克风已静音" : state.speaking ? "正在回复 · 随时可打断" : "正在聆听";
}

export function voiceWidgetLines(state: TerminalVoiceSnapshot, agent: AgentSnapshot, theme: VoiceTheme): string[] {
	const accent = state.voice === "ready" ? "success" : state.voice === "error" ? "error" : "accent";
	const status = theme.fg(accent, `● Step Voice · ${voiceStateLabel(state)}`);
	const lines = [status + theme.fg("dim", "  /voice · /voice mute · /voice interrupt · /voice end")];
	lines.push(theme.fg(agent.waitingForApproval ? "warning" : "dim", `  ${clean(agent.status)}${agent.busy || agent.pending ? " · 后台工作时语音保持在线" : ""}`));
	if (agent.waitingForApproval) lines.push(theme.fg("warning", "  请在主终端处理权限确认；语音不会代为批准。"));
	const activity = state.activity.at(-1);
	if (activity && activity.kind !== "error") lines.push(theme.fg("dim", `  ${clean(activity.text).slice(0, 180)}`));
	if (state.notice && ["error", "warning"].includes(state.notice.kind)) lines.push(theme.fg(state.notice.kind === "error" ? "error" : "warning", `  ${clean(state.notice.text).slice(0, 180)}`));
	return lines;
}

export class TerminalVoicePanel implements Component {
	focused = false;
	private readonly input = new Input({ prompt: "› " });
	private readonly keyInput = new Input({ prompt: "" });
	private snapshot: TerminalVoiceSnapshot;
	private settings = false;
	/** First-run / change-channel setup: choose the channel, then enter the Key */
	private setup: "off" | "channel" | "key" | "done" = "off";
	private channelIndex = 0;
	private target: VoiceDelivery = "followUp";
	private closed = false;
	private released = false;
	private pending = 0;
	private error = "";
	private readonly unsubscribe: () => void;
	private readonly tui: TUI;
	private readonly theme: VoiceTheme;
	private readonly controller: TerminalVoiceController;
	private readonly agentSnapshot: () => AgentSnapshot;
	private readonly done: (result: PanelResult) => void;

	constructor(
		tui: TUI,
		theme: VoiceTheme,
		controller: TerminalVoiceController,
		agentSnapshot: () => AgentSnapshot,
		done: (result: PanelResult) => void,
		options: { setup?: boolean } = {},
	) {
		this.tui = tui;
		this.theme = theme;
		this.controller = controller;
		this.agentSnapshot = agentSnapshot;
		this.done = done;
		this.snapshot = controller.snapshot();
		// First use: guide the user through choosing a channel and entering a Key.
		if (options.setup || !this.snapshot.config.setupDone) this.openSetup();
		this.unsubscribe = controller.subscribe((snapshot) => {
			if (this.closed) return;
			this.snapshot = snapshot;
			this.tui.requestRender();
		});
	}

	invalidate(): void {}

	close(result: PanelResult = "hide"): void {
		if (this.closed) return;
		this.closed = true;
		this.done(result);
	}

	dispose(): void {
		if (this.released) return;
		this.released = true;
		this.closed = true;
		this.unsubscribe();
	}

	private run(action: () => void | Promise<void>, interruptible = false): void {
		if (this.pending && !interruptible) return;
		this.error = "";
		this.pending += 1;
		Promise.resolve().then(action).catch((error) => {
			this.error = clean(error instanceof Error ? error.message : "操作失败，请查看 Step Code 提示。");
		}).finally(() => {
			this.pending -= 1;
			if (!this.closed) this.tui.requestRender();
		});
		this.tui.requestRender();
	}

	private submitText(raw: string): void {
		const text = raw.trim();
		if (!text) return;
		if (text.length > 12_000) { this.error = "内容过长，请拆成几段。"; return; }
		this.run(() => {
			this.controller.submitTask(text, this.target);
			this.input.setValue("");
		});
	}

	private toggleVoice(): void {
		if (this.snapshot.voice === "ready" || this.snapshot.voice === "connecting") this.run(() => this.controller.stop(), true);
		else if (!this.snapshot.config.keyConfigured) this.openSetup();
		else this.run(() => this.controller.start());
	}

	private openSetup(): void {
		if (this.snapshot.voice === "ready" || this.snapshot.voice === "connecting") { this.error = "请先结束语音通话，再修改接入设置。"; return; }
		this.settings = false;
		this.setup = "channel";
		this.channelIndex = Math.max(0, CHANNEL_ORDER.indexOf(this.snapshot.config.channel ?? "api"));
		this.keyInput.setValue("");
		this.error = "";
	}

	private submitKey(): void {
		if (this.snapshot.setup?.phase === "checking") return;
		const typed = this.keyInput.getValue().trim();
		const useEnv = !typed && Boolean(this.snapshot.config.envKeyHint);
		if (!typed && !useEnv) { this.error = "请粘贴 API Key 后按 Enter。"; return; }
		const channel = CHANNEL_ORDER[this.channelIndex];
		this.error = "";
		this.run(async () => {
			const result = await this.controller.saveCredentials(channel, typed, useEnv);
			if (result.ok) { this.keyInput.setValue(""); this.setup = "done"; }
		}, true);
	}

	private handleSetupInput(data: string): void {
		if (this.setup === "channel") {
			if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "tab")) this.channelIndex = (this.channelIndex + 1) % CHANNEL_ORDER.length;
			else if (data === "1" || data === "2") this.channelIndex = Number(data) - 1;
			else if (matchesKey(data, "return")) { this.setup = "key"; this.error = ""; }
			else if (matchesKey(data, "escape")) { this.setup = "off"; this.error = ""; }
		} else if (this.setup === "key") {
			if (matchesKey(data, "return")) this.submitKey();
			else if (matchesKey(data, "escape")) {
				if (this.keyInput.getValue()) this.keyInput.setValue("");
				else { this.setup = "channel"; }
				this.error = "";
			} else if (this.snapshot.setup?.phase !== "checking") { this.keyInput.handleInput(data); if (this.error) this.error = ""; }
		} else if (this.setup === "done") {
			if (matchesKey(data, "return")) { this.setup = "off"; this.toggleVoice(); }
			else if (matchesKey(data, "escape")) this.setup = "off";
		}
	}

	/**
	 * The text box is always live, so typing works while the microphone is open.
	 * Panel actions therefore use Ctrl shortcuts that the host Input does not bind;
	 * plain letters (and IME-composed Chinese) always go into the text box.
	 */
	handleInput(data: string): void {
		if (this.closed) return;
		if (matchesKey(data, "ctrl+c")) { this.close(); return; }
		if (this.setup !== "off") { this.handleSetupInput(data); this.tui.requestRender(); return; }
		if (this.settings) {
			if (matchesKey(data, "escape") || matchesKey(data, "return") || matchesKey(data, "ctrl+o") || matchesKey(data, "s")) this.settings = false;
			else if (matchesKey(data, "k")) this.openSetup();
			else if (matchesKey(data, "x") && this.snapshot.config.keySource === "saved") this.run(() => this.controller.clearCredentials(), true);
			else if (matchesKey(data, "ctrl+r") || matchesKey(data, "r")) this.run(() => this.controller.reloadConfigFromEnvironment());
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "escape")) {
			if (this.input.getValue()) { this.input.setValue(""); this.error = ""; }
			else { this.close(); return; }
		} else if (matchesKey(data, "return")) {
			const text = this.input.getValue();
			if (text.trim()) this.submitText(text);
			else this.toggleVoice();
		} else if (matchesKey(data, "tab")) {
			const targets = ["followUp", "steer"] as const;
			this.target = targets[(targets.indexOf(this.target) + 1) % targets.length];
			this.error = "";
		} else if (matchesKey(data, "ctrl+t")) this.run(() => this.controller.mute(), true);
		else if (matchesKey(data, "ctrl+x")) this.run(() => this.controller.interrupt(), true);
		else if (matchesKey(data, "ctrl+g")) this.run(() => this.controller.cancelTask(), true);
		else if (matchesKey(data, "ctrl+o")) this.settings = true;
		else if (matchesKey(data, "ctrl+q")) this.run(async () => { await this.controller.stop(); this.close("end"); }, true);
		else {
			this.input.handleInput(data);
			if (this.error && this.input.getValue()) this.error = "";
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 2);
		const row = (text: string): string => this.theme.fg("borderMuted", "│") + truncateToWidth(text, inner, "…", true) + this.theme.fg("borderMuted", "│");
		const separator = this.theme.fg("borderMuted", `├${"─".repeat(inner)}┤`);
		const heading = (text: string): string => row(` ${this.theme.bold(this.theme.fg("accent", text))}`);
		const lines = [
			this.theme.fg("borderMuted", `╭${"─".repeat(inner)}╮`),
			heading("✦ Step Voice  /  语音直送 Step Code"),
		];
		const wrapDim = (text: string): void => { for (const wrapped of wrapTextWithAnsi(text, Math.max(1, inner - 2))) lines.push(row(` ${this.theme.fg("dim", wrapped)}`)); };
		if (this.setup !== "off") {
			const firstRun = !this.snapshot.config.setupDone;
			const channel = CHANNEL_ORDER[this.channelIndex];
			const phase = this.snapshot.setup?.phase ?? "idle";
			if (this.setup === "channel") {
				lines.push(separator, heading(firstRun ? "欢迎使用 · 第 1 步：选择接入通道" : "接入设置 · 第 1 步：选择接入通道"));
				CHANNEL_ORDER.forEach((id, index) => {
					const info = CHANNEL_INFO[id], on = index === this.channelIndex;
					const mark = on ? this.theme.fg("accent", "› ●") : "  ○";
					lines.push(row(` ${mark} ${index + 1}. ${on ? this.theme.bold(info.label) : info.label}${this.theme.fg("dim", `  ${info.billing} · 实时模型 ${info.realtime}`)}`));
				});
				lines.push(row(""));
				wrapDim(`两个通道使用同一把平台 API Key，在 ${KEY_URL} 创建。`);
				wrapDim(`选 Step Plan 需要账号已订阅套餐（${PLAN_URL}），语音消耗套餐额度；开放平台按实际调用扣费。`);
				lines.push(separator, row(this.theme.fg("dim", " ↑↓ / 1 2 选择 · Enter 下一步 · Esc 稍后再说")));
			} else if (this.setup === "key") {
				const info = CHANNEL_INFO[channel];
				lines.push(separator, heading(`第 2 步：输入 API Key（通道：${info.label}）`));
				const typed = this.keyInput.getValue();
				const shown = typed ? maskKey(typed) : this.theme.fg("dim", "粘贴 Key（输入内容会被遮住）");
				lines.push(row(` ${this.theme.fg("accent", "›")} ${shown}`));
				if (!typed && this.snapshot.config.envKeyHint) wrapDim(`检测到环境变量 STEP_API_KEY（${this.snapshot.config.envKeyHint}），直接按 Enter 就用它，不会另存一份。`);
				wrapDim(`获取 Key：${KEY_URL}`);
				wrapDim("Key 会先实时验证，通过后保存在 ~/.stepcode/step-voice/credentials.json，只有你的账户能读取。");
				const status = this.error || (phase === "checking" || phase === "invalid" ? this.snapshot.setup!.message : "");
				if (status) for (const line of wrapTextWithAnsi(clean(status), Math.max(1, inner - 2)).slice(0, 4))
					lines.push(row(` ${this.theme.fg(phase === "checking" && !this.error ? "accent" : "error", line)}`));
				lines.push(separator, row(this.theme.fg("dim", phase === "checking" ? " 正在验证…" : " Enter 验证并保存 · Esc 清空 / 返回上一步")));
			} else {
				const info = CHANNEL_INFO[this.snapshot.config.channel ?? channel];
				lines.push(separator, heading("✓ 设置完成"));
				lines.push(row(` 通道   ${info.label}（${info.billing}）`));
				lines.push(row(` Key    ${this.snapshot.config.keySource === "env" ? `环境变量 ${this.snapshot.config.envKeyHint}` : `已保存 ${this.snapshot.config.keyHint ?? ""}`}`));
				lines.push(row(` 模型   实时 ${clean(this.snapshot.config.realtimeModel)} · 播报 ${clean(this.snapshot.config.ttsModel)}`));
				lines.push(separator, row(this.theme.fg("dim", " Enter 开始语音 · Esc 返回面板 · 以后可在 Ctrl+O 设置里更换")));
			}
		} else if (this.settings) {
			const config = this.snapshot.config;
			const info = CHANNEL_INFO[config.channel ?? "api"];
			const source = !config.keyConfigured ? this.theme.fg("warning", "尚未配置")
				: config.keySource === "saved" ? this.theme.fg("success", `面板保存 ${config.keyHint ?? ""}`)
				: this.theme.fg("success", `环境变量 ${config.envKeyHint || config.keyHint || ""}`);
			lines.push(separator, heading("接入设置"));
			lines.push(row(` 通道      ${info.label}${this.theme.fg("dim", `  ${info.billing}`)}`));
			lines.push(row(` API Key   ${source}`));
			for (const [label, value] of [
				["实时模型", config.realtimeModel], ["任务播报", config.ttsModel],
				["音色    ", config.voice], ["API     ", config.baseUrl],
			]) lines.push(row(` ${label}  ${clean(value)}`));
			wrapDim("模型、音色也可用 STEP_VOICE_REALTIME_MODEL / STEP_VOICE_TTS_MODEL / STEP_VOICE_VOICE 覆盖。");
			lines.push(separator, row(this.theme.fg("dim", ` K 更换通道或 Key${config.keySource === "saved" ? " · X 清除保存的 Key" : ""} · R 重读环境变量 · Enter / Esc 返回`)));
		} else {
			const compact = this.tui.terminal.rows < 32;
			const stateColor = this.snapshot.voice === "ready" ? "success" : this.snapshot.voice === "error" ? "error" : "accent";
			lines.push(row(` ${this.theme.fg(stateColor, "●")} ${this.theme.fg(stateColor, voiceStateLabel(this.snapshot))}${this.pending ? this.theme.fg("dim", "  ·  正在处理") : ""}`));
			const level = this.snapshot.muted || !Number.isFinite(this.snapshot.micLevel) ? 0 : Math.min(1, Math.max(0, this.snapshot.micLevel));
			const meterWidth = Math.min(24, Math.max(8, inner - 20));
			const filled = Math.round(level * meterWidth);
			const meter = "█".repeat(filled) + "░".repeat(meterWidth - filled);
			lines.push(row(` ${this.theme.fg("dim", "麦克风")} ${this.theme.fg(stateColor, meter)} ${Math.round(level * 100)}%`));
			wrapDim(compact ? "停顿即直送 Step Code；忙时排队。" : "语音停顿后自动直送 Step Code；忙时排队，任务完成后朗读结果。");
			lines.push(separator, heading("输入转写"));
			const maxHeight = Math.max(18, Math.min(36, this.tui.terminal.rows - 4));
			const subtitleActive = Boolean(this.snapshot.subtitle?.active);
			// 播报区预算：紧凑模式 1 行；常规模式标题 + 最多 3 行。从转写预算中扣除，避免溢出。
			const subtitleRows = subtitleActive ? (compact ? 1 : 3) : 0;
			const subtitleOverhead = subtitleActive ? (compact ? 1 : 4) : 0;
			const transcriptRows = compact ? 1 : Math.max(1, maxHeight - 27 - subtitleOverhead);
			const transcript = this.snapshot.transcripts.flatMap((entry) => {
				const prefix = entry.role === "user" ? (entry.source === "typed_text" ? "你·文字" : "你") : entry.source === "model_audio" ? "Step·语音" : "Step";
				const marker = entry.final ? "" : this.theme.fg("accent", " ▍");
				return wrapTextWithAnsi(`${prefix}  ${clean(entry.text)}${marker}`, Math.max(1, inner - 2));
			});
			for (const line of transcript.length ? transcript.slice(-transcriptRows) : ["说话停顿后即提交，请一次说完一条指令。", "文字也直接发给 Step Code，无需开启麦克风。"])
				lines.push(row(` ${this.theme.fg("text", line)}`));
			if (subtitleActive && this.snapshot.subtitle) {
				const subtitle = this.snapshot.subtitle;
				if (!compact) lines.push(separator, heading("任务播报"));
				const chars = Array.from(clean(subtitle.text));
				const at = Math.min(chars.length, Math.max(0, Math.round(subtitle.highlight)));
				const body = this.theme.fg("text", chars.slice(0, at).join("")) + this.theme.fg("dim", chars.slice(at).join(""));
				const wrapped = wrapTextWithAnsi(`${compact ? "" : "▸ "}${body}`, Math.max(1, inner - 2));
				for (const line of wrapped.slice(-subtitleRows)) lines.push(row(` ${line}`));
			}
			const agent = this.agentSnapshot();
			lines.push(separator, heading(`Step Code  ·  ${agent.waitingForApproval ? "等待你确认" : agent.busy || agent.pending ? "后台工作中" : "等待任务"}`));
			lines.push(row(` ${clean(agent.status)}`));
			lines.push(row(this.theme.fg("dim", " 真实输出预览 · 全文见主终端")));
			const lastText = clean(agent.lastResponse ?? this.snapshot.lastAgentText);
			for (const line of wrapTextWithAnsi(lastText || "等待 Step Code 的公开回复。", Math.max(1, inner - 2)).slice(compact ? -1 : -4)) lines.push(row(` ${this.theme.fg("dim", line)}`));
			const notice = this.error || this.snapshot.notice?.text;
			if (notice) for (const line of wrapTextWithAnsi(clean(notice), Math.max(1, inner - 2)).slice(0, 3))
				lines.push(row(this.theme.fg(this.error || this.snapshot.notice?.kind === "error" ? "error" : "warning", ` ${line}`)));
			lines.push(separator);
			const label = this.target === "steer" ? "Step Code · 补充当前任务 (steer)" : "Step Code · 后续任务 (followUp)";
			lines.push(row(this.theme.fg("accent", ` ${label}`)));
			wrapDim(compact ? "Tab 文字队列 · Enter 发送/空输入启停" : "Tab 仅切换文字队列 · Enter 发送（空输入开始/结束语音）");
			this.input.focused = this.focused;
			lines.push(row(` ${this.input.render(Math.max(1, inner - 2))[0] ?? ""}`));
			lines.push(row(this.theme.fg("dim", compact ? " Ctrl+T 静音 · Ctrl+G 停任务 · Esc 收起" : " Ctrl+T 静音 · Ctrl+X 清播放 · Ctrl+G 停止任务 · Ctrl+O 设置")));
			if (!compact) lines.push(row(this.theme.fg("dim", " Ctrl+Q 结束并收起 · Esc 收起（保留通话）")));
		}
		lines.push(this.theme.fg("borderMuted", `╰${"─".repeat(inner)}╯`));
		return lines.map((line) => visibleWidth(line) > width ? truncateToWidth(line, width) : line);
	}
}
