export type VoiceDelivery = "steer" | "followUp";

export interface AgentSnapshot {
	sessionId: string;
	sessionName?: string;
	cwd: string;
	busy: boolean;
	pending: boolean;
	waitingForApproval: boolean;
	model?: string;
	status: string;
	lastResponse: string;
}

export interface VoiceAgentEvent {
	type: "agent.status" | "agent.text" | "agent.tool" | "agent.complete" | "agent.error";
	snapshot: AgentSnapshot;
	text?: string;
	toolName?: string;
	isError?: boolean;
	requestId?: string;
	/** Requests covered by one fully settled host run, including queued refinements. */
	requestIds?: string[];
}

/** Dispatches work through the host agent, preserving its existing permissions. */
export interface VoiceAgentBridge {
	snapshot(): AgentSnapshot;
	submit(text: string, delivery?: VoiceDelivery): { requestId: string; queued: boolean };
	cancel(): void;
	subscribe(listener: (event: VoiceAgentEvent) => void): () => void;
}

export interface VoiceServerHandle {
	url: string;
	close(): Promise<void>;
}

export interface VoiceServerOptions {
	cwd: string;
	agent: VoiceAgentBridge;
	mode?: "stepaudio";
}

export interface TerminalVoiceConfig {
	baseUrl: string;
	realtimeModel: string;
	ttsModel: string;
	voice: string;
	keyConfigured: boolean;
}

export interface TerminalVoiceSnapshot {
	connection: "disconnected" | "connecting" | "connected";
	voice: "stopped" | "connecting" | "ready" | "error";
	startupPhase?: "idle" | "preparing-audio" | "opening-microphone" | "connecting-model" | "ready" | "stopping" | "error";
	muted: boolean;
	micLevel: number;
	speaking: boolean;
	config: TerminalVoiceConfig;
	agentConnected: boolean;
	agent?: AgentSnapshot;
	transcripts: { id: string; role: "user" | "assistant"; text: string; final: boolean; source?: string }[];
	activity: { id: number; text: string; kind: string; time: number }[];
	notice?: { kind: string; text: string };
	lastAgentText: string;
}

/** Native microphone/playback and relay transport are owned by the controller. */
export interface TerminalVoiceController {
	connect(): Promise<void>;
	start(): Promise<void>;
	mute(value?: boolean): void;
	setMuted(value: boolean): void;
	interrupt(): void;
	stop(): Promise<void>;
	sendText(text: string): void;
	submitTask(text: string, delivery?: VoiceDelivery): void;
	cancelTask(): void;
	reloadConfigFromEnvironment(env?: NodeJS.ProcessEnv): void | Promise<void>;
	snapshot(): TerminalVoiceSnapshot;
	subscribe(listener: (snapshot: TerminalVoiceSnapshot, event?: unknown) => void): () => void;
	dispose(): Promise<void>;
	close(): Promise<void>;
}
