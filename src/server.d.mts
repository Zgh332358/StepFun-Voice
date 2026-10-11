import type { VoiceServerHandle, VoiceServerOptions } from "./types.ts";

export function startVoiceServer(options: VoiceServerOptions): Promise<VoiceServerHandle>;
