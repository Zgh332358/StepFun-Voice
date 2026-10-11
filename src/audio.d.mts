export class StreamingResampler {
	constructor(inputRate: number, outputRate?: number);
	push(input: Float32Array): Float32Array;
}
export function floatToPcm16(samples: Float32Array): Uint8Array;
export function pcm16ToFloat(bytes: Uint8Array): Float32Array;
export function rms(samples: Float32Array | number[]): number;
export class ResponseFence {
	activeId: string | undefined;
	start(id?: string): boolean;
	interrupt(): void;
	accept(id?: string): boolean;
	reset(): void;
}
