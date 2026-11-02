import type { AgentSnapshot, TerminalVoiceSnapshot } from './types.ts';
export type HUDAction = 'start' | 'mute' | 'interrupt' | 'end' | 'setup';
export interface HUDHooks {
  onAction?(action: HUDAction): void;
  onError?(error: Error): void;
}
export interface DesktopVoiceHUD {
  show(snapshot: TerminalVoiceSnapshot, agent?: AgentSnapshot): Promise<void>;
  update(snapshot: TerminalVoiceSnapshot, agent?: AgentSnapshot): void;
  close(): Promise<void>;
}
export class NativeVoiceHUD implements DesktopVoiceHUD {
  constructor(hooks?: HUDHooks);
  show(snapshot: TerminalVoiceSnapshot, agent?: AgentSnapshot): Promise<void>;
  update(snapshot: TerminalVoiceSnapshot, agent?: AgentSnapshot): void;
  close(): Promise<void>;
}
export function prepareNativeHUD(): Promise<string>;
export function hudState(snapshot: TerminalVoiceSnapshot, agent?: AgentSnapshot): Record<string, unknown>;
