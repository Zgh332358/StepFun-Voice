import type { ExtensionAPI, ExtensionContext } from "@step-harness/coding-agent";
import { createVoiceAgentBridge } from "./src/bridge.ts";
import { createHarnessVoiceRuntime, type HarnessVoiceRuntime } from "./src/harness-provider.mjs";
import { HarnessVoiceTransport } from "./src/harness-transport.mjs";
import type { TerminalVoicePanel } from "./src/terminal-ui.ts";
import type { TerminalVoiceController, TerminalVoiceSnapshot, VoiceServerHandle } from "./src/types.ts";

const CONFIG_HELP = [
	"桌面端：/stepvoice 打开壳内语音弹窗（不开始录音）；/stepvoice setup 配置接入通道与 Key；/stepvoice mute|interrupt|end 控制通话。",
	"运行 /stepvoice setup，按引导选择接入通道（开放平台 API / Step Plan）并输入 API Key；Key 会先实时验证再保存。",
	"API Key 在 https://platform.stepfun.com/interface-key 创建；Step Plan 通道需要账号已订阅套餐。",
	"也可以在启动 StepCode 前 export STEP_API_KEY='你的 Key'（同样支持 STEPFUN_API_KEY）。桌面端从 Finder 启动不继承终端 export，建议在 /stepvoice setup 中配置。",
	"可选：STEP_VOICE_REALTIME_MODEL、STEP_VOICE_TTS_MODEL、STEP_VOICE_VOICE。",
].join("\n");
const ACTIONS = ["panel", "setup", "start", "mute", "interrupt", "end", "stop", "status", "config"];
const VOICE_STATE_LABEL: Record<string, string> = {
	stopped: "未开始", connecting: "正在连接", ready: "正在聆听", error: "语音出错",
};
const PHASE_LABEL: Record<string, string> = {
	idle: "", "preparing-audio": "正在准备本机音频助手…", "opening-microphone": "等待 macOS 麦克风权限",
	"connecting-model": "正在连接实时语音模型…", ready: "停顿后自动提交当前任务", stopping: "正在关闭麦克风…", error: "启动未完成",
};

/** Same host bridge and native audio in TUI and desktop/RPC. Never opens a second agent. */
export default function stepVoice(pi: ExtensionAPI): void {
	const bridge = createVoiceAgentBridge(pi);
	let context: ExtensionContext | undefined;
	let server: VoiceServerHandle | undefined;
	let harnessRuntime: HarnessVoiceRuntime | undefined;
	let harnessTransport: HarnessVoiceTransport | undefined;
	let unregisterVoiceProvider: (() => Promise<void>) | undefined;
	let controller: TerminalVoiceController | undefined;
	let starting: Promise<TerminalVoiceController> | undefined;
	let panel: TerminalVoicePanel | undefined;
	let terminalUI: typeof import("./src/terminal-ui.ts") | undefined;
	let unsubscribe: (() => void) | undefined;
	let disposed = false;
	/** Dismiss the open desktop dialog when the host needs focus (approval, turn start, shutdown). */
	let desktopDialogAbort: AbortController | undefined;
	/** Host dismissed our dialog for a turn/permission: keep any live call running; the user can reopen. */
	let hostDismissedDialog = false;

	const bindContext = (ctx: ExtensionContext): void => {
		context = ctx;
		bridge.setContext(ctx);
	};
	const report = async (ctx: ExtensionContext, text: string, kind: "info" | "warning" | "error" = "info"): Promise<void> => {
		if (ctx.mode === "rpc" && ctx.hasUI) await withVoiceDialogOpen(() => ctx.ui.select(text, ["返回 StepCode"]));
		else ctx.ui.notify(text, kind);
	};
	const updateWidget = (): void => {
		if (disposed || !context || !controller || context.mode !== "tui" || !terminalUI) return;
		try {
			context.ui.setWidget("step-voice", terminalUI.voiceWidgetLines(controller.snapshot(), bridge.agent.snapshot(), context.ui.theme));
			context.ui.setStatus("step-voice", `语音 · ${terminalUI.voiceStateLabel(controller.snapshot())}`);
		} catch { /* Session replacement releases the old context before late UI updates. */ }
	};
	/** The host's RPC UI owns every select prompt; tag ours so bridge and focus-yield ignore only voice dialogs. */
	const withVoiceDialogOpen = async <T>(run: () => Promise<T>): Promise<T> => {
		desktopDialogAbort = new AbortController();
		bridge.setVoicePanelOpen(true);
		try { return await run(); }
		finally {
			desktopDialogAbort = undefined;
			bridge.setVoicePanelOpen(false);
		}
	};
	const dismissDesktopDialog = (): void => { hostDismissedDialog = true; desktopDialogAbort?.abort(); };

	const ensureHarness = (ctx: ExtensionContext): HarnessVoiceRuntime | undefined => {
		if (ctx.voice?.protocolVersion !== 1) return undefined;
		if (!harnessRuntime) {
			const runtime = createHarnessVoiceRuntime();
			unregisterVoiceProvider = ctx.voice.registerProvider(runtime.provider);
			harnessRuntime = runtime;
		}
		return harnessRuntime;
	};

	const ensureController = async (ctx: ExtensionContext): Promise<TerminalVoiceController> => {
		if (disposed) throw new Error("当前语音插件已随旧会话关闭，请在新会话运行 /stepvoice。");
		bindContext(ctx);
		if (controller) return controller;
		if (!starting) {
			starting = (async () => {
				const { createTerminalVoiceController } = await import("./src/terminal-controller.ts");
				const runtime = ensureHarness(ctx);
				let created: TerminalVoiceController;
				if (runtime && ctx.voice) {
					harnessTransport = new HarnessVoiceTransport({ voice: ctx.voice, runtime, agent: bridge.agent });
					created = createTerminalVoiceController({ transport: harnessTransport });
				} else {
					const { startVoiceServer } = await import("./src/server.mjs");
					server = await startVoiceServer({ cwd: ctx.cwd, agent: bridge.agent, mode: "stepaudio" });
					created = createTerminalVoiceController({ url: server.url });
				}
				try {
					await created.connect();
					if (disposed) throw new Error("StepCode 会话已经关闭。");
					controller = created;
					unsubscribe = created.subscribe(() => updateWidget());
					updateWidget();
					return created;
				} catch (error) {
					await created.dispose().catch(() => {});
					await harnessTransport?.dispose(); harnessTransport = undefined;
					await server?.close(); server = undefined;
					throw error;
				}
			})();
		}
		const pending = starting;
		try { return await pending; }
		finally { if (starting === pending) starting = undefined; }
	};
	const close = async (): Promise<void> => {
		dismissDesktopDialog();
		panel?.close(); panel = undefined;
		bridge.setVoicePanelOpen(false);
		if (starting) await starting.catch(() => {});
		unsubscribe?.(); unsubscribe = undefined;
		const current = controller; controller = undefined;
		const currentServer = server; server = undefined;
		const currentTransport = harnessTransport; harnessTransport = undefined;
		try { await current?.dispose(); }
		finally {
			try { await currentTransport?.dispose(); }
			finally {
				await currentServer?.close();
				if (!controller && context?.mode === "tui") try {
					context.ui.setWidget("step-voice", undefined);
					context.ui.setStatus("step-voice", undefined);
				} catch {}
			}
		}
	};

	// ---------------- Desktop (RPC) native dialogs ----------------
	function desktopStatusText(state: TerminalVoiceSnapshot): string {
		const parts = [
			`语音：${state.muted && state.voice === "ready" ? "麦克风已静音" : VOICE_STATE_LABEL[state.voice] ?? state.voice}`,
			PHASE_LABEL[state.startupPhase ?? "idle"] || "",
			`接入：${state.config.channel === "step_plan" ? "Step Plan" : "开放平台 API"} · Key ${state.config.keyConfigured ? `已配置 ${state.config.keyHint}` : "未配置"}`,
		];
		if (state.agent) {
			parts.push(`会话：${state.agent.sessionName || state.agent.sessionId}`);
			parts.push(`任务：${state.agent.status}${state.agent.waitingForApproval ? "（等待你在上方处理权限）" : ""}`);
			const latest = state.transcripts.filter(t => t.final).slice(-2);
			for (const t of latest) parts.push(`${t.role === "user" ? "你" : "语音"}：${t.text.slice(0, 60)}`);
			if (state.subtitle?.active) parts.push(`朗读：${state.subtitle.text.slice(0, 80)}`);
			if (state.lastAgentText) parts.push(`输出：${state.lastAgentText.slice(-120)}`);
		}
		if (state.notice?.text) parts.push(`提示：${state.notice.text}`);
		return parts.filter(Boolean).join("\n");
	}

	async function desktopSelect(ctx: ExtensionContext, title: string, options: string[], timeoutMs = 120_000): Promise<string | undefined> {
		const abort = new AbortController();
		desktopDialogAbort = abort;
		bridge.setVoicePanelOpen(true);
		const timer = setTimeout(() => abort.abort(), timeoutMs);
		timer.unref?.();
		try { return await ctx.ui.select(title, options, { signal: abort.signal }); }
		finally {
			clearTimeout(timer);
			if (desktopDialogAbort === abort) desktopDialogAbort = undefined;
			bridge.setVoicePanelOpen(false);
		}
	}

	/** First-run / later setup without a browser page: channel → Key source → verify & save. */
	async function desktopSetup(ctx: ExtensionContext, voice: TerminalVoiceController): Promise<void> {
		const state = voice.snapshot();
		const channelChoice = await desktopSelect(ctx, `接入设置\n\n当前通道：${state.config.channel === "step_plan" ? "Step Plan" : "开放平台 API"} · Key：${state.config.keyConfigured ? `已配置 ${state.config.keyHint}（${state.config.keySource === "saved" ? "已保存" : "环境变量"}）` : "未配置"}\n\n选择接入通道`, [
			"开放平台 API（按调用量计费）", "Step Plan（需订阅套餐）", "返回",
		]);
		if (!channelChoice || channelChoice === "返回") return;
		const channel = channelChoice.startsWith("Step Plan") ? "step_plan" : "api";
		const keyChoice = await desktopSelect(ctx, `接入设置 · ${channelChoice}\n\nStepFun API Key 在 platform.stepfun.com/interface-key 创建。\n桌面端没有密码输入框；选择“粘贴输入”会调用 macOS 隐藏输入框，Key 不进入聊天或日志。`, [
			"粘贴输入新 Key（macOS 隐藏输入框）",
			state.config.envKeyHint ? `使用环境变量 Key（${state.config.envKeyHint}）` : "使用环境变量中的 Key（需先在启动前 export）",
			state.config.keyConfigured ? "保留当前已配置的 Key" : "",
			"清除已保存的 Key",
			"返回",
		].filter(Boolean));
		if (!keyChoice || keyChoice === "返回") return;
		if (keyChoice === "清除已保存的 Key") {
			voice.clearCredentials();
			await report(ctx, "已清除保存的 Key。环境变量中的 Key 不受影响。");
			return;
		}
		if (keyChoice.startsWith("保留当前")) return;
		let apiKey = "";
		const useEnvKey = keyChoice.startsWith("使用环境变量");
		if (!useEnvKey) {
			const result = await pi.exec("/usr/bin/osascript", ["-e",
				`display dialog "粘贴 StepFun API Key（不会显示输入内容）" default answer "" with hidden answer with title "Step Voice 接入设置" buttons {"取消","保存"} default button "保存"`,
				"-e", "text returned of result"], { timeout: 120_000 });
			if (result.code !== 0) return; // cancelled
			apiKey = String(result.stdout ?? "").trim();
			if (!apiKey) { await report(ctx, "未输入 Key，未修改接入设置。", "warning"); return; }
		}
		const save = voice.saveCredentials(channel as "api" | "step_plan", apiKey, useEnvKey);
		// Verification is async; keep a status dialog so the user can cancel focus without orphaning it.
		const done = await Promise.race([save, desktopSelect(ctx, "正在验证 Key 和通道…", ["继续等待", "取消等待"], 30_000).then(() => undefined as never)]);
		if (done === undefined) { void save.catch(() => {}); await report(ctx, "已取消等待；若验证随后完成，Key 仍会保存。可用 /stepvoice status 查看。"); return; }
		await report(ctx, done.ok ? "验证通过，已保存接入设置。" : `Key 验证未通过：${done.message}`, done.ok ? "info" : "error");
	}

	/** Main desktop menu: controls the call without leaving the StepCode window. */
	async function desktopMenu(ctx: ExtensionContext, voice: TerminalVoiceController, setup = false): Promise<void> {
		if (setup) { await desktopSetup(ctx, voice); return; }
		for (;;) {
			if (disposed) return;
			const state = voice.snapshot();
			const active = state.voice === "ready" || state.voice === "connecting";
			const options = [
				active ? (state.muted ? "恢复麦克风" : "静音麦克风") : (state.config.keyConfigured ? "开始语音" : "配置接入（未配置 Key）"),
				active ? "打断朗读/语音回复" : "",
				active ? "结束通话" : "",
				"刷新状态",
				"接入设置",
				"关闭（结束通话）",
			].filter(Boolean);
			const choice = await desktopSelect(ctx, `Step Voice · 当前桌面会话\n\n${desktopStatusText(state)}`, options);
			if (!choice && hostDismissedDialog) { hostDismissedDialog = false; return; } // host needs focus; call continues
			if (!choice || choice === "关闭（结束通话）") { if (active) await voice.stop(); return; } // idle timeout or explicit close ends capture
			if (choice === "刷新状态") continue;
			if (choice === "接入设置" || choice === "配置接入（未配置 Key）") { await desktopSetup(ctx, voice); continue; }
			if (choice === "开始语音") { void voice.start().catch(() => {}); continue; }
			if (choice === "静音麦克风" || choice === "恢复麦克风") { voice.mute(); continue; }
			if (choice === "打断朗读/语音回复") { voice.interrupt(); continue; }
			if (choice === "结束通话") { await voice.stop(); continue; }
		}
	}

	pi.on("session_start", (_event, ctx) => { bindContext(ctx); ensureHarness(ctx); });
	pi.on("session_shutdown", async () => {
		disposed = true;
		try { await close(); }
		finally {
			try { await unregisterVoiceProvider?.(); }
			finally { try { await harnessRuntime?.dispose(); } finally { bridge.dispose(); } }
		}
	});
	// Yield focus: when the host starts a turn or raises a non-voice prompt,
	// dismiss our dialog. A call in progress keeps running (dictation may be the
	// task itself); /stepvoice end still works and executes even while streaming.
	const yieldToHost = (): void => { panel?.close(); panel = undefined; dismissDesktopDialog(); };
	pi.on("before_agent_start", yieldToHost);
	pi.on("agent_start", yieldToHost);
	pi.on("ui_prompt_start", (event) => {
		// Our own voice dialogs are kind "select"; bridge skips those while one is open.
		if (event.kind !== "custom" && event.kind !== "select") dismissDesktopDialog();
	});
	bridge.agent.subscribe(() => updateWidget());

	pi.registerCommand("stepvoice", {
		description: "StepFun voice in StepCode terminal / macOS desktop (/stepvoice setup|panel|start|mute|interrupt|end|stop|status|config)",
		getArgumentCompletions: (prefix) => ACTIONS.filter(value => value.startsWith(prefix.trim())).map(value => ({ value, label: value })),
		handler: async (args, ctx) => {
			bindContext(ctx);
			const action = args.trim().toLowerCase();
			if (ctx.mode !== "tui" && (ctx.mode !== "rpc" || !ctx.hasUI)) {
				ctx.ui.notify("语音需要 StepCode 交互终端或桌面/RPC 交互模式。", "error"); return;
			}
			try {
				if (action === "config") { await report(ctx, CONFIG_HELP); return; }
				if (action === "status") {
					const state = controller?.snapshot();
					await report(ctx, state ? desktopStatusText(state) : "语音尚未启动。运行 /stepvoice 打开控制。"); return;
				}
				if (action === "stop") { await close(); await report(ctx, "语音服务已关闭。"); return; }
				if (action && !ACTIONS.includes(action)) { await report(ctx, "用法：/stepvoice [setup|panel|start|mute|interrupt|end|stop|status|config]", "warning"); return; }
				if (ctx.mode === "rpc" && process.platform !== "darwin") { await report(ctx, "本分支的桌面原生音频适配仅支持 macOS。", "error"); return; }
				if (ctx.mode === "tui") terminalUI ??= await import("./src/terminal-ui.ts");
				const voice = await ensureController(ctx);
				if (action === "start") {
					if (!voice.snapshot().config.keyConfigured) { await report(ctx, "还没有配置 API Key。运行 /stepvoice setup 完成接入设置。", "warning"); return; }
					await voice.start(); updateWidget(); return;
				}
				if (action === "mute") { voice.mute(); updateWidget(); return; }
				if (action === "interrupt") { voice.interrupt(); return; }
				if (action === "end") { await voice.stop(); updateWidget(); return; }
				if (ctx.mode === "rpc") { await desktopMenu(ctx, voice, action === "setup"); return; }
				if (!ctx.isIdle()) {
					updateWidget();
					await report(ctx, "StepCode 正在工作，语音控件保留在终端。可用 /stepvoice mute、/stepvoice interrupt、/stepvoice end 控制；任务结束后 /stepvoice 打开面板。"); return;
				}
				if (panel) { await report(ctx, "语音面板已经打开。Esc 收起可返回 StepCode。"); return; }
				bridge.setVoicePanelOpen(true);
				try {
					await ctx.ui.custom<"hide" | "end">((tui, theme, _kb, done) => {
						panel = new terminalUI!.TerminalVoicePanel(tui, theme, voice, () => bridge.agent.snapshot(), done, { setup: action === "setup" });
						return panel;
					}, { overlay: true, overlayOptions: { width: "92%", maxHeight: "92%", anchor: "center", margin: 1 } });
				} finally { panel = undefined; bridge.setVoicePanelOpen(false); updateWidget(); }
			} catch (error) { await report(ctx, error instanceof Error ? error.message : "语音启动失败，请检查接入设置。", "error"); }
		},
	});
}
