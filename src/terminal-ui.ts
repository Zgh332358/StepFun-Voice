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
	if (agent.busy || agent.pending) lines.push(theme.fg("dim", `  ${clean(agent.status)} · 后台工作时语音保持在线`));
	if (state.notice && ["error", "warning"].includes(state.notice.kind)) lines.push(theme.fg(state.notice.kind === "error" ? "error" : "warning", `  ${clean(state.notice.text).slice(0, 180)}`));
	return lines;
}

export class TerminalVoicePanel implements Component {
	focused = false;
	private readonly input = new Input({ prompt: "› " });
	private snapshot: TerminalVoiceSnapshot;
	private editing = false;
	private settings = false;
	private target: "voice" | VoiceDelivery = "voice";
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
	) {
		this.tui = tui;
		this.theme = theme;
		this.controller = controller;
		this.agentSnapshot = agentSnapshot;
		this.done = done;
		this.snapshot = controller.snapshot();
		this.unsubscribe = controller.subscribe((snapshot) => {
			if (this.closed) return;
			this.snapshot = snapshot;
			this.tui.requestRender();
		});
		this.input.onSubmit = (text) => this.submitText(text);
		this.input.onEscape = () => { this.editing = false; this.input.setValue(""); this.tui.requestRender(); };
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
			if (this.target === "voice") this.controller.sendText(text);
			else this.controller.submitTask(text, this.target);
			this.input.setValue("");
			this.editing = false;
		});
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (this.editing) {
			if (matchesKey(data, "tab")) {
				const targets = ["voice", "steer", "followUp"] as const;
				this.target = targets[(targets.indexOf(this.target) + 1) % targets.length];
			} else this.input.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.close(); return; }
		if (this.settings) {
			if (matchesKey(data, "s") || matchesKey(data, "return")) this.settings = false;
			if (matchesKey(data, "r")) this.run(() => this.controller.reloadConfigFromEnvironment());
		} else if (matchesKey(data, "return") || matchesKey(data, "space")) {
			if (this.snapshot.voice === "ready" || this.snapshot.voice === "connecting") this.run(() => this.controller.stop(), true);
			else if (!this.snapshot.config.keyConfigured) this.settings = true;
			else this.run(() => this.controller.start());
		} else if (matchesKey(data, "m")) this.run(() => this.controller.mute(), true);
		else if (matchesKey(data, "i")) this.run(() => this.controller.interrupt(), true);
		else if (matchesKey(data, "s")) this.settings = true;
		else if (matchesKey(data, "t")) this.editing = true;
		else if (matchesKey(data, "g")) { this.target = "steer"; this.editing = true; }
		else if (matchesKey(data, "c")) this.run(() => this.controller.cancelTask(), true);
		else if (matchesKey(data, "q")) this.run(async () => { await this.controller.stop(); this.close("end"); }, true);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 2);
		const row = (text: string): string => this.theme.fg("borderMuted", "│") + truncateToWidth(text, inner, "…", true) + this.theme.fg("borderMuted", "│");
		const separator = this.theme.fg("borderMuted", `├${"─".repeat(inner)}┤`);
		const heading = (text: string): string => row(` ${this.theme.bold(this.theme.fg("accent", text))}`);
		const lines = [
			this.theme.fg("borderMuted", `╭${"─".repeat(inner)}╮`),
			heading("✦ Step Voice  /  语音工作搭档"),
		];
		if (this.settings) {
			lines.push(separator, heading("在启动 Step Code 的终端接入 StepFun"));
			for (const line of [
				"export STEP_API_KEY='你的开放平台 Key'",
				"也支持 STEPFUN_API_KEY；配置后重新启动 Step Code。",
				"插件读取进程环境变量，不读取 .env 或 OAuth 登录文件。",
				"Step Plan 登录和语音平台 Key 独立。",
			]) for (const wrapped of wrapTextWithAnsi(line, Math.max(1, inner - 2))) lines.push(row(` ${this.theme.fg("dim", wrapped)}`));
			lines.push(separator, row(` Key 状态   ${this.snapshot.config.keyConfigured ? this.theme.fg("success", "已配置") : this.theme.fg("warning", "尚未配置")}`));
			for (const [label, value] of [
				["实时模型", this.snapshot.config.realtimeModel], ["任务播报", this.snapshot.config.ttsModel],
				["音色", this.snapshot.config.voice], ["API", this.snapshot.config.baseUrl],
			]) lines.push(row(` ${label}  ${clean(value)}`));
			lines.push(row(this.theme.fg("dim", " STEP_VOICE_REALTIME_MODEL / TTS_MODEL / VOICE 可自定义")));
			lines.push(separator, row(this.theme.fg("dim", " Enter / S 返回  ·  R 重读进程环境  ·  Esc 收起")));
		} else {
			const stateColor = this.snapshot.voice === "ready" ? "success" : this.snapshot.voice === "error" ? "error" : "accent";
			lines.push(row(` ${this.theme.fg(stateColor, "●")} ${this.theme.fg(stateColor, voiceStateLabel(this.snapshot))}${this.pending ? this.theme.fg("dim", "  ·  正在处理") : ""}`));
			const level = this.snapshot.muted || !Number.isFinite(this.snapshot.micLevel) ? 0 : Math.min(1, Math.max(0, this.snapshot.micLevel));
			const meterWidth = Math.min(24, Math.max(8, inner - 20));
			const filled = Math.round(level * meterWidth);
			const meter = "█".repeat(filled) + "░".repeat(meterWidth - filled);
			lines.push(row(` ${this.theme.fg("dim", "麦克风")} ${this.theme.fg(stateColor, meter)} ${Math.round(level * 100)}%`));
			lines.push(row(this.theme.fg("dim", " 自然说话、随时打断；任务在后台继续。")), separator, heading("对话"));
			const maxHeight = Math.max(18, Math.min(36, this.tui.terminal.rows - 4));
			const transcriptRows = Math.max(2, maxHeight - 17);
			const transcript = this.snapshot.transcripts.flatMap((entry) => {
				const prefix = entry.role === "user" ? "你" : "Step";
				return wrapTextWithAnsi(`${prefix}  ${clean(entry.text)}`, Math.max(1, inner - 2));
			});
			for (const line of transcript.length ? transcript.slice(-transcriptRows) : ["说出想法，或按 T 输入文字。", "按 G 将任务交给当前 Step Code。"])
				lines.push(row(` ${this.theme.fg("text", line)}`));
			const agent = this.agentSnapshot();
			lines.push(separator, heading(`Step Code  ·  ${agent.waitingForApproval ? "等待你确认" : agent.busy || agent.pending ? "后台工作中" : "等待任务"}`));
			lines.push(row(` ${clean(agent.status)}`));
			const lastText = clean(agent.lastResponse || this.snapshot.lastAgentText);
			for (const line of wrapTextWithAnsi(lastText || "任务公开回复会显示在这里。", Math.max(1, inner - 2)).slice(-2)) lines.push(row(` ${this.theme.fg("dim", line)}`));
			const notice = this.error || this.snapshot.notice?.text;
			if (notice) for (const line of wrapTextWithAnsi(clean(notice), Math.max(1, inner - 2)).slice(0, 3))
				lines.push(row(this.theme.fg(this.error || this.snapshot.notice?.kind === "error" ? "error" : "warning", ` ${line}`)));
			lines.push(separator);
			if (this.editing) {
				const label = this.target === "voice" ? "语音对话" : this.target === "steer" ? "交给 Step Code" : "排入后续任务";
				lines.push(row(this.theme.fg("accent", ` ${label} · Tab 切换 · Enter 发送 · Esc 取消`)));
				this.input.focused = this.focused;
				lines.push(row(` ${this.input.render(Math.max(1, inner - 2))[0] ?? ""}`));
			} else {
				lines.push(row(this.theme.fg("dim", " Enter 开始/结束 · M 静音 · I 打断 · T 文字 · G 任务")));
				lines.push(row(this.theme.fg("dim", " S 设置 · C 停止任务 · Q 结束并收起 · Esc 收起保留通话")));
			}
		}
		lines.push(this.theme.fg("borderMuted", `╰${"─".repeat(inner)}╯`));
		return lines.map((line) => visibleWidth(line) > width ? truncateToWidth(line, width) : line);
	}
}
