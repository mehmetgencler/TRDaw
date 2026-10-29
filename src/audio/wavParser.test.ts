import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWavHeader } from './wavParser';

function createMockWavBuffer(
  sampleRate = 44100,
  channels = 2,
  bitsPerSample = 16,
  numFrames = 44100,
  dataSizeOverride?: number
): ArrayBuffer {
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = dataSizeOverride !== undefined ? dataSizeOverride : numFrames * blockAlign;
  const actualBufferFrames = dataSizeOverride !== undefined ? Math.min(numFrames, 100) : numFrames;
  const totalSize = 44 + actualBufferFrames * blockAlign;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  // 'RIFF'
  view.setUint8(0, 0x52); view.setUint8(1, 0x49); view.setUint8(2, 0x46); view.setUint8(3, 0x46);
  view.setUint32(4, 44 + dataSize - 8, true);
  // 'WAVE'
  view.setUint8(8, 0x57); view.setUint8(9, 0x41); view.setUint8(10, 0x56); view.setUint8(11, 0x45);

  // 'fmt '
  view.setUint8(12, 0x66); view.setUint8(13, 0x6d); view.setUint8(14, 0x74); view.setUint8(15, 0x20);
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM format = 1
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byteRate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // 'data'
  view.setUint8(36, 0x64); view.setUint8(37, 0x61); view.setUint8(38, 0x74); view.setUint8(39, 0x61);
  view.setUint32(40, dataSize, true);

  return buffer;
}

test('parseWavHeader correctly parses standard 16-bit 44.1kHz stereo WAV header', () => {
  const buffer = createMockWavBuffer(44100, 2, 16, 88200); // 2 seconds
  const header = parseWavHeader(buffer);

  assert.equal(header.audioFormat, 1);
  assert.equal(header.channels, 2);
  assert.equal(header.sampleRate, 44100);
  assert.equal(header.bitsPerSample, 16);
  assert.equal(header.blockAlign, 4);
  assert.equal(header.dataChunkOffset, 44);
  assert.equal(header.totalSampleFrames, 88200);
  assert.equal(header.durationSec, 2);
});

test('parseWavHeader correctly parses 24-bit 48kHz WAV header', () => {
  const buffer = createMockWavBuffer(48000, 2, 24, 48000); // 1 second
  const header = parseWavHeader(buffer);

  assert.equal(header.channels, 2);
  assert.equal(header.sampleRate, 48000);
  assert.equal(header.bitsPerSample, 24);
  assert.equal(header.blockAlign, 6);
  assert.equal(header.durationSec, 1);
});

test('parseWavHeader rejects invalid RIFF magic header', () => {
  const invalidBuffer = new ArrayBuffer(50);
  assert.throws(() => parseWavHeader(invalidBuffer), /Missing RIFF magic bytes/);
});

test('parseWavHeader correctly calculates duration for 1GB file from header slice with totalFileSize', () => {
  const ONE_GIGABYTE = 1024 * 1024 * 1024;
  // Simulating 64KB slice from a 1GB WAV file where the header specifies 1GB dataChunkSize
  const sliceBuffer = createMockWavBuffer(48000, 2, 24, 100, ONE_GIGABYTE - 44);
  
  const header = parseWavHeader(sliceBuffer, ONE_GIGABYTE);
  // Block align = 2 * (24 / 8) = 6 bytes
  // Available data bytes = 1,073,741,824 - 44 = 1,073,741,780 bytes
  // Sample frames = 1,073,741,780 / 6 = 178,956,963
  // Duration = 178,956,963 / 48000 = ~3728.27 seconds (~62.1 minutes)
  assert.equal(header.channels, 2);
  assert.equal(header.sampleRate, 48000);
  assert.equal(header.bitsPerSample, 24);
  assert.equal(header.blockAlign, 6);
  assert.ok(header.durationSec > 3700, `DurationSec should be > 3700s, got ${header.durationSec}`);
});

test('parseWavHeader handles 0xFFFFFFFF streaming/RF64 data chunk size correctly', () => {
  const ONE_GIGABYTE = 1024 * 1024 * 1024;
  // Simulating 64KB slice with 0xFFFFFFFF streaming chunk
  const sliceBuffer = createMockWavBuffer(48000, 2, 24, 100, 0xFFFFFFFF);
  
  const header = parseWavHeader(sliceBuffer, ONE_GIGABYTE);
  assert.equal(header.channels, 2);
  assert.equal(header.sampleRate, 48000);
  assert.ok(header.durationSec > 3700, `DurationSec should fall back to maxAvailable, got ${header.durationSec}`);
});

