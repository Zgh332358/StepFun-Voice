import { EventEmitter } from "node:events";
import type { VoiceSessionAPI } from "@step-harness/coding-agent";
import type { HarnessVoiceRuntime } from "./harness-provider.mjs";
import type { VoiceAgentBridge } from "./types.ts";

export class HarnessVoiceTransport extends EventEmitter {
	constructor(options: { voice: VoiceSessionAPI; runtime: HarnessVoiceRuntime; agent: VoiceAgentBridge });
	readyState: number;
	open(): void;
	send(data: string): void;
	close(): void;
	dispose(): Promise<void>;
}
