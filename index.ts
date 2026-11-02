import type { ExtensionAPI, ExtensionContext } from "@step-harness/coding-agent";
import { createVoiceAgentBridge } from "./src/bridge.ts";
import { createHarnessVoiceRuntime, type HarnessVoiceRuntime } from "./src/harness-provider.mjs";
import { HarnessVoiceTransport } from "./src/harness-transport.mjs";
import { getComposerVoiceHost, COMPOSER_UNAVAILABLE, type ComposerAction, type ComposerRegistration } from "./src/composer-contract.ts";
import type { TerminalVoicePanel } from "./src/terminal-ui.ts";
import type { TerminalVoiceController, TerminalVoiceSnapshot, VoiceServerHandle } from "./src/types.ts";

const CONFIG_HELP = [
	"桌面端需要宿主提供 stepvoice.composer/1 输入栏扩展协议；/stepvoice 打开内嵌语音控制（不开始录音）。当前正式宿主未提供此能力时仅提示，不启动浮窗。",
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

/** Desktop uses an explicit composer contract; terminal keeps its existing native audio path. */
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
	let lifecycle = 0;
	let composerRegistration: ComposerRegistration | undefined;
	let composerRuntime: HarnessVoiceRuntime | undefined;
	let composerSessionId: string | undefined;

	const bindContext = (ctx: ExtensionContext): void => {
		context = ctx;
		bridge.setContext(ctx);
	};
	const report = async (ctx: ExtensionContext, text: string, kind: "info" | "warning" | "error" = "info"): Promise<void> => {
		ctx.ui.notify(text, kind);
	};
	const updateWidget = (): void => {
		if (disposed || !context || !controller) return;
		if (context.mode !== "tui" || !terminalUI) return;
		try {
			context.ui.setWidget("step-voice", terminalUI.voiceWidgetLines(controller.snapshot(), bridge.agent.snapshot(), context.ui.theme));
			context.ui.setStatus("step-voice", `语音 · ${terminalUI.voiceStateLabel(controller.snapshot())}`);
		} catch { /* Session replacement releases the old context before late UI updates. */ }
	};
	const ensureComposer = (ctx: ExtensionContext): ComposerRegistration | undefined => {
		if (disposed) throw new Error("当前插件会话已关闭，请重新打开会话。");
		const host = getComposerVoiceHost(ctx);
		if (!host) return undefined;
		const sessionId = ctx.sessionManager.getSessionId();
		if (composerRegistration && composerSessionId !== sessionId) throw new Error("语音组件属于旧会话，请先重载插件。");
		if (!composerRegistration) {
			const runtime = createHarnessVoiceRuntime();
			try {
				const registration = host.registerProvider(runtime.conversationProvider, {
					snapshot: runtime.publicConfig, save: runtime.saveCredentials, clear: runtime.clearCredentials,
				});
				if (!registration || typeof registration.command !== "function" || typeof registration.dispose !== "function") {
					throw new Error("宿主输入栏语音接口返回了无效注册结果。");
				}
				composerRuntime = runtime;
				composerSessionId = sessionId;
				composerRegistration = registration;
			} catch (error) { void runtime.dispose().catch(() => {}); throw error; }
		}
		return composerRegistration;
	};


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
		lifecycle++;
		panel?.close(); panel = undefined;
		bridge.setVoicePanelOpen(false);
		const registration = composerRegistration; composerRegistration = undefined;
		const runtime = composerRuntime; composerRuntime = undefined;
		composerSessionId = undefined;
		const composerClose = Promise.all([
			Promise.resolve().then(() => registration?.dispose()),
			Promise.resolve().then(() => runtime?.dispose()),
		]);
		void composerClose.catch(() => {});
		if (starting) await starting.catch(() => {});
		unsubscribe?.(); unsubscribe = undefined;
		const current = controller; controller = undefined;
		const currentServer = server; server = undefined;
		const currentTransport = harnessTransport; harnessTransport = undefined;
		try { await Promise.all([current?.dispose(), composerClose]); }
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

	// ---------------- Terminal status summary ----------------
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

	pi.on("session_start", (_event, ctx) => {
		bindContext(ctx);
		if (ctx.mode === "tui") ensureHarness(ctx);
		else if (ctx.mode === "rpc" && ctx.hasUI) {
			try { ensureComposer(ctx); }
			catch { ctx.ui.notify("输入栏语音组件注册失败，请检查宿主协议实现。", "error"); }
		}
	});
	pi.on("session_shutdown", async () => {
		disposed = true;
		try { await close(); }
		finally {
			try { await unregisterVoiceProvider?.(); }
			finally { try { await harnessRuntime?.dispose(); } finally { bridge.dispose(); } }
		}
	});
	// Terminal panels yield to host task UI; composer focus is always owned by the host.
	const yieldToHost = (): void => { panel?.close(); panel = undefined; };
	pi.on("before_agent_start", yieldToHost);
	pi.on("agent_start", yieldToHost);
	bridge.agent.subscribe(() => updateWidget());

	pi.registerCommand("stepvoice", {
		description: "StepFun voice in StepCode terminal / macOS desktop (/stepvoice setup|panel|start|mute|interrupt|end|stop|status|config)",
		getArgumentCompletions: (prefix) => ACTIONS.filter(value => value.startsWith(prefix.trim())).map(value => ({ value, label: value })),
		handler: async (args, ctx) => {
			bindContext(ctx);
			const action = args.trim().toLowerCase();
			const commandLifecycle = lifecycle;
			if (ctx.mode !== "tui" && (ctx.mode !== "rpc" || !ctx.hasUI)) {
				ctx.ui.notify("语音需要 StepCode 交互终端或桌面/RPC 交互模式。", "error"); return;
			}
			try {
				if (action === "config") { await report(ctx, CONFIG_HELP); return; }
				if (action && !ACTIONS.includes(action)) { await report(ctx, "用法：/stepvoice [setup|panel|start|mute|interrupt|end|stop|status|config]", "warning"); return; }
				if (ctx.mode === "rpc") {
					if (action === "stop") { await close(); return; }
					const registration = ensureComposer(ctx);
					if (!registration) { await report(ctx, COMPOSER_UNAVAILABLE, "warning"); return; }
					await registration.command((!action || action === "panel" ? "open" : action) as ComposerAction);
					return;
				}
				if (action === "status") {
					const state = controller?.snapshot();
					await report(ctx, state ? desktopStatusText(state) : "语音尚未启动。运行 /stepvoice 打开控制。"); return;
				}
				if (action === "stop") { await close(); await report(ctx, "语音服务已关闭。"); return; }
				terminalUI ??= await import("./src/terminal-ui.ts");
				const voice = await ensureController(ctx);
				if (disposed || commandLifecycle !== lifecycle) return;
				if (action === "start") {
					if (!voice.snapshot().config.keyConfigured) { await report(ctx, "还没有配置 API Key。运行 /stepvoice setup 完成接入设置。", "warning"); return; }
					if (disposed || commandLifecycle !== lifecycle) return;
					await voice.start(); updateWidget(); return;
				}
				if (action === "mute") { voice.mute(); updateWidget(); return; }
				if (action === "interrupt") { voice.interrupt(); return; }
				if (action === "end") { lifecycle++; await voice.stop(); updateWidget(); return; }
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
			} catch (error) {
				if (!disposed && commandLifecycle === lifecycle) await report(ctx, error instanceof Error ? error.message : "语音启动失败，请检查接入设置。", "error");
			}
		},
	});
}
