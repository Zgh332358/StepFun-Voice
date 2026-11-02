import type { TerminalVoiceConfig } from './types.ts';

/** Proposed opt-in host contract, NOT an API present in released StepCode 0.2.1. */
export const COMPOSER_PROTOCOL = 'stepvoice.composer/1' as const;
export const COMPOSER_UNAVAILABLE = '当前 StepCode 未提供输入栏语音插件接口（stepvoice.composer/1）。不会启动浮窗或麦克风。需要宿主接入此协议；现有听写按钮仍可单独使用。';
export type ComposerAction = 'open' | 'start' | 'mute' | 'interrupt' | 'end' | 'setup' | 'status';
export interface MediaContext {
  sessionId: string;
  voiceSessionId: string;
  generation: number;
  signal: AbortSignal;
  emit(event: VoiceEvent): void;
}
export interface VoiceEvent {
  type: string;
  sessionId?: string;
  voiceSessionId?: string;
  generation?: number;
  sequence?: number;
  source?: string;
  text?: string;
  message?: string;
  audio?: string;
  sampleRate?: number;
  numChannels?: number;
  responseId?: string;
  outputEpoch?: number;
  taskId?: string;
  callId?: string;
  state?: string;
  status?: string;
  muted?: boolean;
  stage?: string;
}
export interface HandoffRequest {
  sessionId: string;
  voiceSessionId: string;
  generation: number;
  callId: string;
  instruction: string;
  delivery: 'steer' | 'followUp';
}
export type HandoffReceipt = { status: 'submitted' | 'queued'; taskId: string; message?: string }
  | { status: 'handled' | 'rejected'; message?: string };
export interface ConversationContext extends MediaContext {
  /** Bound by host to this exact session; must resolve on admission, not completion. */
  requestTask(request: HandoffRequest): Promise<HandoffReceipt>;
  getTaskStatus(): { busy: boolean; pending?: boolean; waitingForApproval?: boolean; status: string };
}
export interface ConversationSession {
  start(): Promise<void>;
  appendAudio(frame: { data: string; sampleRate: 24000; numChannels: 1 }): void;
  setMuted(muted: boolean): void;
  interrupt(): void;
  updateTask(update: { taskId: string; sequence: number; kind: 'started' | 'progress' | 'settled' | 'failed'; text: string }): boolean;
  snapshot(): { state: string; muted: boolean; sessionId: string; voiceSessionId: string; generation: number };
  close(): Promise<void>;
}
export interface ConversationProvider {
  readonly id: string;
  readonly label: string;
  readonly protocol: typeof COMPOSER_PROTOCOL;
  readonly active: boolean;
  readonly capabilities: { inputMode: 'handoff'; realtimeAudio: true; standaloneReadout: true; sampleRate: 24000; numChannels: 1 };
  createSession(context: ConversationContext): ConversationSession;
  speak(text: string, context: MediaContext): Promise<void>;
  interruptReadout(): void;
  dispose(): Promise<void>;
}
export interface ComposerConfiguration {
  snapshot(): TerminalVoiceConfig;
  save(channel: string, apiKey?: string, useEnvKey?: boolean): Promise<{ ok: boolean; message: string }>;
  clear(): void;
}
export interface ComposerRegistration {
  /** Host-owned UI/media controls; open MUST NOT request microphone access. */
  command(action: ComposerAction): Promise<void>;
  /** Remove the UI, stop all local tracks/playback, abort contexts and close sessions. */
  dispose(): Promise<void>;
}
export interface ComposerVoiceHost {
  readonly protocol: typeof COMPOSER_PROTOCOL;
  readonly surface: 'composer';
  registerProvider(provider: ConversationProvider, configuration: ComposerConfiguration): ComposerRegistration;
}
export function getComposerVoiceHost(context: unknown): ComposerVoiceHost | undefined {
  if (!context || typeof context !== 'object' || !('voiceComposer' in context)) return undefined;
  const host = context.voiceComposer;
  if (!host || typeof host !== 'object' || !('protocol' in host) || host.protocol !== COMPOSER_PROTOCOL ||
    !('surface' in host) || host.surface !== 'composer' || !('registerProvider' in host) || typeof host.registerProvider !== 'function') return undefined;
  return host as ComposerVoiceHost;
}
