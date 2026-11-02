import type { VoiceProvider } from "@step-harness/coding-agent";
import type { TerminalVoiceConfig } from "./types.ts";
import type { ConversationProvider } from "./composer-contract.ts";

export interface HarnessVoiceRuntime {
	provider: VoiceProvider;
	conversationProvider: ConversationProvider;
	settings: { speakTasks: boolean; speakSummarize: boolean };
	publicConfig(): TerminalVoiceConfig;
	sanitizeEvent(value: unknown): unknown;
	cancelSetup(): void;
	updateConfig(input: Record<string, unknown>): void;
	saveCredentials(channel: string, apiKey?: string, useEnvKey?: boolean): Promise<{ ok: boolean; message: string; file?: string }>;
	clearCredentials(): void;
	dispose(): Promise<void>;
}

export function createHarnessVoiceRuntime(options?: Record<string, unknown>): HarnessVoiceRuntime;
