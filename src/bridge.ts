import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@step-harness/coding-agent";
import type { AgentSnapshot, VoiceAgentBridge, VoiceAgentEvent } from "./types.ts";

const MAX_TEXT_LENGTH = 24_000;

/** Only spoken/displayable text is forwarded. Thinking and tool arguments stay in the host. */
function assistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const value = message as { role?: string; content?: unknown };
	if (value.role !== "assistant" || !Array.isArray(value.content)) return "";
	return value.content
		.filter((part): part is { type: "text"; text: string } =>
			Boolean(part && part.type === "text" && typeof part.text === "string"),
		)
		.map((part) => part.text)
		.join("\n")
		.slice(-MAX_TEXT_LENGTH);
}

export function createVoiceAgentBridge(pi: ExtensionAPI, { taskStartTimeoutMs = 45000 } = {}): {
	agent: VoiceAgentBridge;
	setContext(context: ExtensionContext): void;
	setVoicePanelOpen(open: boolean): void;
	dispose(): void;
} {
	let context: ExtensionContext | undefined;
	let disposed = false;
	let status = "等待语音任务";
	let lastResponse = "";
	let lastError = "";
	let cancelled = false;
	let requestId: string | undefined;
	const pendingRequestIds = new Set<string>();
	const startTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const clearStartTimers = (): void => {
		for (const timer of startTimers.values()) clearTimeout(timer);
		startTimers.clear();
	};
	let activeRun = false;
	let waitingPrompts = 0;
	let voicePanelOpen = false;
	let ignoredVoicePrompts = 0;
	let activeTools = new Set<string>();
	let lastTextAt = 0;
	const listeners = new Set<(event: VoiceAgentEvent) => void>();

	const requireContext = (): ExtensionContext => {
		if (disposed || !context) throw new Error("当前 Step Code 会话已关闭。请重新运行 /voice。");
		return context;
	};

	const snapshot = (): AgentSnapshot => {
		if (disposed || !context) {
			return {
				sessionId: "",
				cwd: "",
				busy: false,
				pending: false,
				waitingForApproval: false,
				status: "语音桥接已关闭",
				lastResponse,
			};
		}
		return {
			sessionId: context.sessionManager.getSessionId(),
			sessionName: context.sessionManager.getSessionName(),
			cwd: context.cwd,
			busy: !context.isIdle(),
			pending: context.hasPendingMessages(),
			waitingForApproval: waitingPrompts > 0,
			model: context.model ? `${context.model.provider}/${context.model.id}` : undefined,
			status,
			lastResponse,
		};
	};

	const emit = (event: Omit<VoiceAgentEvent, "snapshot">): void => {
		if (disposed) return;
		const update: VoiceAgentEvent = { snapshot: snapshot(), requestId, ...event };
		for (const listener of listeners) {
			try {
				listener(update);
			} catch {
				// A closed voice connection must not interrupt the host agent.
			}
		}
	};

	const setContext = (ctx: ExtensionContext): void => {
		if (!disposed) context = ctx;
	};

	const watchStart = (id: string): void => {
		const timer = setTimeout(() => {
			startTimers.delete(id);
			if (disposed || !context || !pendingRequestIds.has(id)) return;
			// Queued work can legitimately wait on a running task or permission.
			// A pending flag alone is NOT evidence that the host started execution.
			if (!context.isIdle() || waitingPrompts > 0) { watchStart(id); return; }
			pendingRequestIds.delete(id);
			status = "未观察到 Step Code 开始执行；请核对主终端";
			emit({ type: "agent.error", requestId: id, requestIds: [id], isError: true,
				text: "任务已尝试提交，但 Step Code 尚未开始执行。请查看主终端的登录、模型或权限提示；接受结果不确定，未自动重试。" });
			if (requestId === id) requestId = undefined;
		}, taskStartTimeoutMs);
		timer.unref?.();
		startTimers.set(id, timer);
	};

	const agent: VoiceAgentBridge = {
		snapshot,
		submit(text, delivery = "followUp") {
			const ctx = requireContext();
			const prompt = text;
			if (!prompt.trim()) throw new Error("请说出要交给 Step Code 的任务。");
			if (prompt.length > MAX_TEXT_LENGTH) throw new Error("语音任务过长，请拆成几段后发送。");
			if (delivery !== "steer" && delivery !== "followUp") throw new Error("无效的任务发送方式。");
			if (!ctx.model) throw new Error("Step Code 尚未选择模型。请在终端配置模型后重试。");
			const previousRequestId = requestId;
			const id = randomUUID();
			requestId = id;
			pendingRequestIds.add(id);
			const queued = !ctx.isIdle();
			if (!queued) lastResponse = "";
			lastError = "";
			cancelled = false;
			status = queued ? (delivery === "steer" ? "已排入补充指令" : "已排入后续任务") : "已发送语音任务";
			watchStart(id);
			// This API returns void; only host events confirm that execution started.
			try {
				pi.sendUserMessage(prompt, { deliverAs: delivery, expandPromptTemplates: false });
			} catch (error) {
				clearTimeout(startTimers.get(id)); startTimers.delete(id);
				pendingRequestIds.delete(id);
				status = "提交 Step Code 失败或结果不确定，未自动重试";
				emit({ type: "agent.error", requestId: id, isError: true, text: `${status}：${error instanceof Error ? error.message : String(error)}` });
				requestId = previousRequestId;
				throw error;
			}
			emit({ type: "agent.status" });
			return { requestId: id, queued };
		},
		cancel() {
			const ctx = requireContext();
			if (ctx.isIdle()) return;
			cancelled = true;
			status = "正在停止当前任务";
			ctx.abort();
			emit({ type: "agent.status" });
		},
		subscribe(listener) {
			if (disposed) throw new Error("语音桥接已关闭。");
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};

	pi.on("session_start", (_event, ctx) => {
		setContext(ctx);
		status = ctx.isIdle() ? "等待语音任务" : "Step Code 正在工作";
		lastResponse = "";
		lastError = "";
		cancelled = false;
		activeRun = false;
		waitingPrompts = 0;
		voicePanelOpen = false;
		ignoredVoicePrompts = 0;
		activeTools = new Set();
		requestId = undefined;
		pendingRequestIds.clear();
		clearStartTimers();
	});

	pi.on("agent_start", (_event, ctx) => {
		setContext(ctx);
		activeRun = true;
		clearStartTimers();
		lastTextAt = 0;
		lastResponse = "";
		lastError = "";
		cancelled = false;
		status = "Step Code 正在思考";
		emit({ type: "agent.status" });
	});

	pi.on("message_update", (event, ctx) => {
		setContext(ctx);
		const text = assistantText(event.message);
		if (!text || text === lastResponse) return;
		lastResponse = text;
		const now = Date.now();
		if (now - lastTextAt >= 100) {
			lastTextAt = now;
			emit({ type: "agent.text", text });
		}
	});

	pi.on("message_end", (event, ctx) => {
		setContext(ctx);
		if (event.message.role !== "assistant") return;
		lastResponse = assistantText(event.message);
		if (event.message.stopReason === "error") {
			lastError = event.message.errorMessage || "Step Code 执行失败，请查看终端。";
			status = "Step Code 执行出错";
			emit({ type: "agent.error", text: lastError, isError: true });
		} else if (event.message.stopReason === "aborted") {
			cancelled = true;
			status = "当前任务已停止";
		}
		emit({ type: "agent.text", text: lastResponse });
	});

	pi.on("tool_execution_start", (event, ctx) => {
		setContext(ctx);
		activeTools.add(event.toolCallId);
		status = `正在执行 ${event.toolName}`;
		emit({ type: "agent.tool", toolName: event.toolName });
	});

	pi.on("tool_execution_end", (event, ctx) => {
		setContext(ctx);
		activeTools.delete(event.toolCallId);
		status = event.isError ? `${event.toolName} 返回错误，Step Code 正在处理` : "Step Code 正在继续处理";
		emit({ type: "agent.tool", toolName: event.toolName, isError: event.isError });
	});

	pi.on("ui_prompt_start", (event, ctx) => {
		setContext(ctx);
		if (event.kind === "custom" && voicePanelOpen) {
			ignoredVoicePrompts += 1;
			return;
		}
		waitingPrompts += 1;
		status = `请在 Step Code 终端处理${event.kind === "confirm" ? "权限确认" : "交互问题"}`;
		emit({ type: "agent.status" });
	});

	pi.on("ui_prompt_end", (event, ctx) => {
		setContext(ctx);
		if (event.kind === "custom" && ignoredVoicePrompts > 0) {
			ignoredVoicePrompts -= 1;
			return;
		}
		waitingPrompts = Math.max(0, waitingPrompts - 1);
		status = activeTools.size > 0 ? "Step Code 正在执行工具" : "Step Code 正在继续处理";
		emit({ type: "agent.status" });
	});

	pi.on("agent_end", (_event, ctx) => {
		setContext(ctx);
		activeTools.clear();
		if (cancelled) status = "当前任务已停止";
		else if (!lastError) status = "正在确认是否还有后续任务";
		emit({ type: "agent.status" });
	});

	pi.on("agent_settled", (_event, ctx) => {
		setContext(ctx);
		if (!activeRun) return;
		activeRun = false;
		activeTools.clear();
		waitingPrompts = 0;
		if (lastError) {
			status = "Step Code 执行出错";
		} else if (cancelled) {
			status = "当前任务已停止";
		} else {
			status = "Step Code 已完成当前任务";
		}
		emit({
			type: "agent.complete",
			text: cancelled ? "当前任务已停止。" : lastResponse || lastError,
			isError: Boolean(lastError) || cancelled,
			requestIds: [...pendingRequestIds],
		});
		pendingRequestIds.clear();
		clearStartTimers();
		requestId = undefined;
	});

	return {
		agent,
		setContext,
		setVoicePanelOpen(open) {
			voicePanelOpen = open;
		},
		dispose() {
			disposed = true;
			clearStartTimers();
			pendingRequestIds.clear();
			context = undefined;
			listeners.clear();
		},
	};
}
