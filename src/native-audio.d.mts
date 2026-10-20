export interface NativeAudioHooks {
  onAudio?: (base64PCM: string) => void;
  onLevel?: (level: number) => void;
  onPlayback?: (active: boolean) => void;
  onError?: (error: Error) => void;
  onNotice?: (message: string) => void;
  onClosed?: () => void;
  onStatus?: (status: 'preparing' | 'permission' | 'ready') => void;
}
export function findCsc(env?: Record<string, string | undefined>, exists?: (path: string) => boolean): string | undefined;
export function prepareNativeAudio(): Promise<string>;
export class NativeAudioEngine {
  constructor(hooks?: NativeAudioHooks, options?: { binaryPath?: string; prepareImpl?: () => Promise<string>; spawnImpl?: any; readyTimeoutMs?: number });
  start(): Promise<void>;
  play(audio: string, sampleRate?: number): void;
  clear(): void;
  setMuted(muted: boolean): void;
  stop(): Promise<void>;
}
