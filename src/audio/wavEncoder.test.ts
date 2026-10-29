import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWavBuffer } from './wavEncoder';
import { parseWavHeader } from './wavParser';

test('encodeWavBuffer produces a valid 16-bit RIFF WAV buffer', () => {
  const sampleRate = 44100;
  const numFrames = 4410; // 0.1 second
  const left = new Float32Array(numFrames);
  const right = new Float32Array(numFrames);

  // Fill with 440 Hz test tone
  for (let i = 0; i < numFrames; i++) {
    left[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5;
    right[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5;
  }

  const encoded = encodeWavBuffer(left, right, sampleRate, 16);
  // Verify with parser
  const parsed = parseWavHeader(encoded);
  assert.equal(parsed.channels, 2);
  assert.equal(parsed.sampleRate, 44100);
  assert.equal(parsed.bitsPerSample, 16);
  assert.equal(parsed.totalSampleFrames, 4410);
  assert.equal(Math.round(parsed.durationSec * 10) / 10, 0.1);
});

test('encodeWavBuffer produces a valid 24-bit RIFF WAV buffer', () => {
  const sampleRate = 48000;
  const numFrames = 4800; // 0.1 second
  const left = new Float32Array(numFrames);
  const right = new Float32Array(numFrames);

  const encoded = encodeWavBuffer(left, right, sampleRate, 24);
  const parsed = parseWavHeader(encoded);
  assert.equal(parsed.channels, 2);
  assert.equal(parsed.sampleRate, 48000);
  assert.equal(parsed.bitsPerSample, 24);
  assert.equal(parsed.blockAlign, 6); // 2 channels * 3 bytes
  assert.equal(parsed.totalSampleFrames, 4800);
});

test('encodeWavBuffer produces a valid 32-bit Float WAV buffer', () => {
  const sampleRate = 48000;
  const numFrames = 2400;
  const left = new Float32Array(numFrames);
  const right = new Float32Array(numFrames);

  const encoded = encodeWavBuffer(left, right, sampleRate, 32);
  const parsed = parseWavHeader(encoded);
  assert.equal(parsed.audioFormat, 3); // 3 = IEEE Float
  assert.equal(parsed.bitsPerSample, 32);
  assert.equal(parsed.blockAlign, 8); // 2 channels * 4 bytes
});
