/** Stateful linear resampler. The last input sample is retained across render blocks. */
export class StreamingResampler {
	constructor(inputRate, outputRate = 24000) {
		if (!Number.isFinite(inputRate) || inputRate <= 0 || !Number.isFinite(outputRate) || outputRate <= 0) {
			throw new RangeError('Audio sample rates must be positive numbers.');
		}
		this.step = inputRate / outputRate;
		this.buffer = new Float32Array(0);
		this.position = 0;
	}
	push(input) {
		const joined = new Float32Array(this.buffer.length + input.length);
		joined.set(this.buffer);
		joined.set(input, this.buffer.length);
		const result = [];
		while (this.position + 1 < joined.length) {
			const index = Math.floor(this.position);
			const fraction = this.position - index;
			result.push(joined[index] + (joined[index + 1] - joined[index]) * fraction);
			this.position += this.step;
		}
		const consumed = Math.min(Math.floor(this.position), joined.length);
		this.buffer = joined.slice(consumed);
		this.position -= consumed;
		return Float32Array.from(result);
	}
}

export function floatToPcm16(samples) {
	const bytes = new Uint8Array(samples.length * 2);
	const view = new DataView(bytes.buffer);
	for (let index = 0; index < samples.length; index++) {
		const value = Math.max(-1, Math.min(1, Number.isFinite(samples[index]) ? samples[index] : 0));
		view.setInt16(index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
	}
	return bytes;
}

export function pcm16ToFloat(bytes) {
	if (bytes.byteLength % 2 !== 0) throw new RangeError('PCM16 audio must contain complete samples.');
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const samples = new Float32Array(bytes.byteLength / 2);
	for (let index = 0; index < samples.length; index++) {
		const value = view.getInt16(index * 2, true);
		samples[index] = value / (value < 0 ? 32768 : 32767);
	}
	return samples;
}

export function rms(samples) {
	if (!samples.length) return 0;
	let sum = 0;
	for (const sample of samples) sum += sample * sample;
	return Math.sqrt(sum / samples.length);
}

/** Prevent late packets from interrupted responses from reentering the playback queue. */
export class ResponseFence {
	constructor() {
		this.activeId = undefined;
		this.rejected = new Set();
		this.blockAnonymous = false;
	}
	start(id) {
		if (id && this.rejected.has(id)) return false;
		this.activeId = id;
		this.blockAnonymous = false;
		return true;
	}
	interrupt() {
		if (this.activeId) this.rejected.add(this.activeId);
		this.blockAnonymous = true;
	}
	accept(id) {
		if (id && this.rejected.has(id)) return false;
		if (this.blockAnonymous) return Boolean(id && id !== this.activeId);
		return true;
	}
	reset() {
		this.activeId = undefined;
		this.rejected.clear();
		this.blockAnonymous = false;
	}
}
