import test from 'node:test';
import assert from 'node:assert/strict';
import { dbToGain, gainToDb, calculatePanGains, clamp, formatTimecode, formatBarsBeats, formatFileSize } from './math';

test('dbToGain converts decibels accurately', () => {
  // 0 dB is linear unity gain 1.0
  assert.equal(Math.round(dbToGain(0) * 1000) / 1000, 1.0);
  // +6 dB is roughly 1.995 (double amplitude)
  assert.equal(Math.round(dbToGain(6) * 100) / 100, 2.0);
  // -6 dB is roughly 0.501
  assert.equal(Math.round(dbToGain(-6) * 100) / 100, 0.5);
  // -60 dB or less maps to 0 (silence threshold)
  assert.equal(dbToGain(-60), 0);
  assert.equal(dbToGain(-90), 0);
});

test('gainToDb converts linear gain back to decibels', () => {
  assert.equal(Math.round(gainToDb(1.0)), 0);
  assert.equal(Math.round(gainToDb(2.0)), 6);
  assert.equal(Math.round(gainToDb(0.5)), -6);
  assert.equal(gainToDb(0), -60);
});

test('calculatePanGains implements constant-power panning', () => {
  // Center (pan = 0): both channels ~0.707 (-3dB)
  const center = calculatePanGains(0);
  assert.equal(Math.round(center.leftGain * 1000) / 1000, 0.707);
  assert.equal(Math.round(center.rightGain * 1000) / 1000, 0.707);
  // Constant power sum of squares: left^2 + right^2 approx 1.0
  const power = center.leftGain * center.leftGain + center.rightGain * center.rightGain;
  assert.equal(Math.round(power * 1000) / 1000, 1.0);

  // Full Left (pan = -1)
  const left = calculatePanGains(-1);
  assert.equal(Math.round(left.leftGain * 1000) / 1000, 1.0);
  assert.equal(Math.round(left.rightGain * 1000) / 1000, 0.0);

  // Full Right (pan = 1)
  const right = calculatePanGains(1);
  assert.equal(Math.round(right.leftGain * 1000) / 1000, 0.0);
  assert.equal(Math.round(right.rightGain * 1000) / 1000, 1.0);
});

test('clamp confines numbers to ranges', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-3, 0, 10), 0);
  assert.equal(clamp(15, 0, 10), 10);
});

test('formatTimecode renders MM:SS.mmm format correctly', () => {
  assert.equal(formatTimecode(0), '00:00.000');
  assert.equal(formatTimecode(65.5), '01:05.500');
  assert.equal(formatTimecode(123.456), '02:03.456');
});

test('formatBarsBeats renders Bar.Beat.Tick musical time', () => {
  assert.equal(formatBarsBeats(0, 120), '001.1.00');
  // At 120 bpm, 1 beat is 0.5s. 2 seconds is 4 beats = start of Bar 2
  assert.equal(formatBarsBeats(2.0, 120), '002.1.00');
});

test('formatFileSize formats bytes to human readable text', () => {
  assert.equal(formatFileSize(1024), '1.00 KB');
  assert.equal(formatFileSize(1048576), '1.00 MB');
  assert.equal(formatFileSize(1073741824), '1.00 GB');
});
