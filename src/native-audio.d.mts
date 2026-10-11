export interface NativeAudioHooks {
  onAudio?: (base64PCM: string) => void;
  onLevel?: (level: number) => void;
  onPlayback?: (active: boolean) => void;
  onError?: (error: Error) => void;
  onNotice?: (message: string) => void;
  onClosed?: () => void;
}
export function prepareNativeAudio(): Promise<string>;
export class NativeAudioEngine {
  constructor(hooks?: NativeAudioHooks, options?: { binaryPath?: string; spawnImpl?: any; readyTimeoutMs?: number });
  start(): Promise<void>;
  play(audio: string, sampleRate?: number): void;
  clear(): void;
  setMuted(muted: boolean): void;
  stop(): Promise<void>;
}
