/**
 * Legacy Playback Drift-Correction & Non-Streaming Unit Tests
 *
 * Validates:
 * 1-3. Legacy multi-HTMLAudioElement drift adjustment simulation
 * 4. Non-WAV compressed file waveform extraction (Task F: does not exercise streaming engine)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractWaveformPeaksFromBlob } from './wavParser';

// Helper to simulate legacy drift correction logic
function calculateDriftAdjustment(trackTime: number, masterTime: number): { action: 'none' | 'rate-nudge' | 'hard-resync'; rate: number } {
  const drift = trackTime - masterTime;
  if (Math.abs(drift) > 0.035 && Math.abs(drift) < 0.150) {
    return { action: 'rate-nudge', rate: drift > 0 ? 0.995 : 1.005 };
  } else if (Math.abs(drift) >= 0.150) {
    return { action: 'hard-resync', rate: 1.0 };
  }
  return { action: 'none', rate: 1.0 };
}

test('Legacy Drift Sync: correctly identifies in-phase alignment (<35ms)', () => {
  const masterTime = 120.500;
  const trackTime = 120.515; // 15ms drift
  const result = calculateDriftAdjustment(trackTime, masterTime);

  assert.equal(result.action, 'none');
  assert.equal(result.rate, 1.0);
});

test('Legacy Drift Sync: applies imperceptible 0.5% rate nudge for moderate drift (35ms - 150ms)', () => {
  const masterTime = 120.500;
  // Ahead by 50ms -> slow down slightly
  const ahead = calculateDriftAdjustment(120.550, masterTime);
  assert.equal(ahead.action, 'rate-nudge');
  assert.equal(ahead.rate, 0.995);

  // Behind by 50ms -> speed up slightly
  const behind = calculateDriftAdjustment(120.450, masterTime);
  assert.equal(behind.action, 'rate-nudge');
  assert.equal(behind.rate, 1.005);
});

test('Legacy Drift Sync: enforces hard re-sync for severe drift (>=150ms)', () => {
  const masterTime = 120.500;
  const stalledTrackTime = 120.250; // 250ms behind
  const result = calculateDriftAdjustment(stalledTrackTime, masterTime);

  assert.equal(result.action, 'hard-resync');
  assert.equal(result.rate, 1.0);
});

test('Non-WAV compressed file waveform extraction generates safe musical envelope without throwing', async () => {
  // Simulate an MP3 file (starts with ID3 or non-RIFF bytes)
  const mp3Bytes = new Uint8Array(1024 * 50); // 50 KB fake MP3
  mp3Bytes[0] = 0x49; mp3Bytes[1] = 0x44; mp3Bytes[2] = 0x33; // 'ID3'
  const blob = new Blob([mp3Bytes], { type: 'audio/mpeg' });

  const peaks = await extractWaveformPeaksFromBlob(blob, 100);
  assert.equal(peaks.length, 200); // 100 bins * 2 (min/max)
  
  // Verify values are bounded between -1.0 and +1.0
  let hasNonZero = false;
  for (let i = 0; i < peaks.length; i++) {
    assert.ok(peaks[i] >= -1.0 && peaks[i] <= 1.0, `Peak out of range: ${peaks[i]}`);
    if (peaks[i] !== 0) hasNonZero = true;
  }
  assert.ok(hasNonZero, 'Peaks should contain non-zero envelope data');
});
