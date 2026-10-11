import type { ExtensionAPI, ExtensionContext } from "@step-harness/coding-agent";
import { createVoiceAgentBridge } from "./src/bridge.ts";
import { TerminalVoicePanel, voiceStateLabel, voiceWidgetLines } from "./src/terminal-ui.ts";
import type { TerminalVoiceController, VoiceServerHandle } from "./src/types.ts";

const CONFIG_HELP = [
	"在启动 Step Code 的终端设置：",
	"export STEP_API_KEY='你的 StepFun 开放平台 Key'",
	"也支持 STEPFUN_API_KEY。设置后重新启动 Step Code，再运行 /voice。",
	"不读取 .env 或登录凭据文件；Step Plan / OAuth 与平台 Key 独立。",
	"可选：STEP_VOICE_REALTIME_MODEL、STEP_VOICE_TTS_MODEL、STEP_VOICE_VOICE。",
].join("\n");

/** Native voice controls live in the existing Step Code terminal. */
export default function stepVoice(pi: ExtensionAPI): void {
	const bridge = createVoiceAgentBridge(pi);
	let context: ExtensionContext | undefined;
	let server: VoiceServerHandle | undefined;
	let controller: TerminalVoiceController | undefined;
	let starting: Promise<TerminalVoiceController> | undefined;
	let panel: TerminalVoicePanel | undefined;
	let unsubscribe: (() => void) | undefined;
	let disposed = false;

	const bindContext = (ctx: ExtensionContext): void => {
		context = ctx;
		bridge.setContext(ctx);
	};

	const updateWidget = (): void => {
		if (disposed || !context || !controller || context.mode !== "tui") return;
		try {
			context.ui.setWidget("step-voice", voiceWidgetLines(controller.snapshot(), bridge.agent.snapshot(), context.ui.theme));
			context.ui.setStatus("step-voice", `语音 · ${voiceStateLabel(controller.snapshot())}`);
		} catch {
			// Session replacement releases the old context before any late UI update.
		}
	};

	const ensureController = async (ctx: ExtensionContext): Promise<TerminalVoiceController> => {
		if (disposed) throw new Error("当前语音插件已随旧会话关闭，请在新会话运行 /voice。");
		bindContext(ctx);
		if (controller) return controller;
		if (!starting) {
			starting = (async () => {
				const { startVoiceServer } = await import("./src/server.mjs");
				const { createTerminalVoiceController } = await import("./src/terminal-controller.ts");
				server = await startVoiceServer({ cwd: ctx.cwd, agent: bridge.agent, mode: "stepaudio" });
				const created = createTerminalVoiceController({ url: server.url });
				try {
					await created.connect();
					if (disposed) throw new Error("Step Code 会话已经关闭。");
					controller = created;
					unsubscribe = created.subscribe(() => updateWidget());
					updateWidget();
					return created;
				} catch (error) {
					await created.dispose().catch(() => {});
					await server?.close();
					server = undefined;
					throw error;
				}
			})();
		}
		const pending = starting;
		if (!pending) throw new Error("本地语音服务未能启动。");
		try { return await pending; }
		finally { starting = undefined; }
	};

	const close = async (): Promise<void> => {
		panel?.close();
		panel = undefined;
		bridge.setVoicePanelOpen(false);
		if (starting) await starting.catch(() => {});
		unsubscribe?.();
		unsubscribe = undefined;
		const current = controller;
		controller = undefined;
		try { await current?.dispose(); }
		finally {
			try { await server?.close(); }
			finally {
				server = undefined;
				try {
					context?.ui.setWidget("step-voice", undefined);
					context?.ui.setStatus("step-voice", undefined);
				} catch {}
			}
		}
	};

	pi.on("session_start", (_event, ctx) => bindContext(ctx));
	pi.on("session_shutdown", async () => {
		disposed = true;
		await close();
		bridge.dispose();
	});

	// The host counts ui.custom as a UI prompt for its entire lifetime. Close it
	// before an agent run, so nested permission selectors retain keyboard focus.
	const yieldToHost = (): void => { panel?.close(); panel = undefined; };
	pi.on("before_agent_start", yieldToHost);
	pi.on("agent_start", yieldToHost);
	bridge.agent.subscribe(() => updateWidget());

	pi.registerCommand("voice", {
		description: "StepFun voice in the Step Code terminal (/voice start|mute|interrupt|end|stop|status|config)",
		getArgumentCompletions: (prefix) => ["start", "mute", "interrupt", "end", "stop", "status", "config"]
			.filter((value) => value.startsWith(prefix.trim()))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			bindContext(ctx);
			const action = args.trim().toLowerCase();
			if (ctx.mode !== "tui") { ctx.ui.notify("语音插件需要 Step Code 交互终端模式。", "error"); return; }
			if (action === "config") { ctx.ui.notify(CONFIG_HELP, "info"); return; }
			if (action === "status") {
				ctx.ui.notify(controller ? `Step Voice：${voiceStateLabel(controller.snapshot())}\n${bridge.agent.snapshot().status}` : "语音尚未启动。运行 /voice 打开终端面板。", "info");
				return;
			}
			if (action === "stop") { await close(); ctx.ui.notify("语音服务已关闭。", "info"); return; }
			if (action && !["start", "mute", "interrupt", "end"].includes(action)) {
				ctx.ui.notify("用法：/voice [start|mute|interrupt|end|stop|status|config]", "warning"); return;
			}
			try {
				const voice = await ensureController(ctx);
				if (action === "start") {
					if (!voice.snapshot().config.keyConfigured) { ctx.ui.notify(CONFIG_HELP, "warning"); return; }
					await voice.start(); updateWidget(); return;
				}
				if (action === "mute") { voice.mute(); updateWidget(); return; }
				if (action === "interrupt") { voice.interrupt(); return; }
				if (action === "end") { await voice.stop(); updateWidget(); return; }
				if (!ctx.isIdle()) {
					updateWidget();
					ctx.ui.notify("Step Code 正在工作，语音控件保留在终端。可用 /voice mute、/voice interrupt、/voice end 控制；任务结束后 /voice 打开面板。", "info");
					return;
				}
				if (panel) { ctx.ui.notify("语音面板已经打开。Esc 收起可返回 Step Code。", "info"); return; }
				bridge.setVoicePanelOpen(true);
				try {
					await ctx.ui.custom<"hide" | "end">((tui, theme, _kb, done) => {
						panel = new TerminalVoicePanel(tui, theme, voice, () => bridge.agent.snapshot(), done);
						return panel;
					}, {
						overlay: true,
						overlayOptions: { width: "92%", maxHeight: "92%", anchor: "center", margin: 1 },
					});
				} finally {
					panel = undefined;
					bridge.setVoicePanelOpen(false);
					updateWidget();
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : "语音启动失败，请检查终端环境变量。", "error");
			}
		},
	});
}
