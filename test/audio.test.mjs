import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamingResampler, floatToPcm16, pcm16ToFloat, rms, ResponseFence } from '../src/audio.mjs';

function chunkedResample(input, rate, block = 128) {
	const resampler = new StreamingResampler(rate, 24000);
	const result = [];
	for (let offset = 0; offset < input.length; offset += block) result.push(...resampler.push(input.subarray(offset, offset + block)));
	return Float32Array.from(result);
}

test('PCM16 uses signed little-endian samples and clips safely', () => {
	const encoded = floatToPcm16(Float32Array.from([-2, -1, -.5, 0, .5, 1, 2, NaN]));
	assert.deepEqual([...encoded], [0, 128, 0, 128, 0, 192, 0, 0, 0, 64, 255, 127, 255, 127, 0, 0]);
	const decoded = pcm16ToFloat(encoded);
	assert.equal(decoded[0], -1); assert.equal(decoded[1], -1); assert.equal(decoded[2], -.5);
	assert.equal(decoded[3], 0); assert.ok(Math.abs(decoded[4] - .5) < .00002); assert.equal(decoded[5], 1);
});

test('PCM decoding respects subarray byte offsets and rejects incomplete samples', () => {
	const bytes = new Uint8Array([4, 5, 0, 128, 255, 127, 6, 7]);
	assert.deepEqual([...pcm16ToFloat(bytes.subarray(2, 6))], [-1, 1]);
	assert.throws(() => pcm16ToFloat(new Uint8Array(3)), /complete samples/);
});

test('48 kHz microphone audio becomes 24 kHz without block boundary drift', () => {
	const input = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i * 2 * Math.PI * 440 / 48000));
	const actual = chunkedResample(input, 48000);
	assert.equal(actual.length, 24000);
	for (let i = 0; i < actual.length; i++) assert.equal(actual[i], input[i * 2]);
});

test('44.1 kHz resampling interpolates continuously across arbitrary input blocks', () => {
	const input = Float32Array.from({ length: 44100 }, (_, i) => i / 44100);
	const batched = new StreamingResampler(44100, 24000).push(input);
	for (const block of [1, 17, 128, 997]) {
		const streamed = chunkedResample(input, 44100, block);
		assert.equal(streamed.length, 24000);
		assert.equal(streamed.length, batched.length);
		for (let i = 0; i < streamed.length; i++) assert.ok(Math.abs(streamed[i] - batched[i]) < 0.00000012, `sample ${i}, block ${block}`);
	}
});

test('resampling retains the final sample needed for the next capture block', () => {
	const resampler = new StreamingResampler(24000, 24000);
	assert.deepEqual([...resampler.push(Float32Array.from([.1, .2]))], [Math.fround(.1)]);
	assert.deepEqual([...resampler.push(Float32Array.from([.3, .4]))], [Math.fround(.2), Math.fround(.3)]);
	assert.throws(() => new StreamingResampler(0), /positive/);
	assert.equal(rms(Float32Array.from([1, -1])), 1); assert.equal(rms([]), 0);
});

test('interrupt fence rejects late response audio and releases a new response', () => {
	const fence = new ResponseFence();
	fence.start('first'); assert.equal(fence.accept('first'), true);
	fence.interrupt(); assert.equal(fence.accept('first'), false); assert.equal(fence.accept(undefined), false);
	assert.equal(fence.start('first'), false); assert.equal(fence.accept(undefined), false);
	fence.start('second'); assert.equal(fence.accept('second'), true); assert.equal(fence.accept(undefined), true);
	assert.equal(fence.accept('first'), false);
	fence.interrupt(); assert.equal(fence.accept('second'), false);
	fence.start('task-result'); assert.equal(fence.accept('task-result'), true);
	fence.reset(); assert.equal(fence.accept(undefined), true);
});
