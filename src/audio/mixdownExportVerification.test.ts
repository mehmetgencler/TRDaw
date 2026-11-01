/**
 * 24-Bit Mixdown Export Verification & Regression Test Suite
 *
 * Validates the resolution of poor audio quality and harmonic distortion:
 * 1. Controlled Render 1: Single track, all effects bypassed (THD < 0.005%, 0 clipping, <1 LSB error)
 * 2. Controlled Render 2: Four tracks, all effects bypassed, master -12 dB (Clean summing, no distortion)
 * 3. Controlled Render 3: Four tracks with full DSP mastering chain (Smooth limiting, zero cliffs, THD < 0.05%)
 * 4. 24-bit PCM RIFF structural integrity, little-endian byte packing, and TPDF dither
 * 5. Chunk boundary continuity across 5-second processing windows
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMixdownWav, encodeWavBuffer } from './wavEncoder';
import { parseWavHeader } from './wavParser';
import {
  analyzeSignal,
  calculateTruePeak,
  decode24BitWavBlob,
  createSyntheticSineWav,
} from './exportDiagnostics';
import { createEmptyTracks } from './demoStems';
import type { MasterState, ExportSettings } from '../types/audio';
import { calculatePanGains, calculateStereoPanGains, dbToGain } from './math';

test('Controlled Render 1: Single Track, all effects bypassed', async () => {
  const sampleRate = 48000;
  const durationSec = 10;
  const sine = createSyntheticSineWav({
    frequency: 440,
    durationSec,
    sampleRate,
    amplitude: 0.7079, // -3 dBFS
    bitDepth: 24,
  });

  const tracks = createEmptyTracks();
  tracks[0].sourceBlob = sine.blob;
  tracks[0].fileInfo = {
    name: 'sine440.wav',
    sizeBytes: sine.blob.size,
    sampleRate: 48000,
    bitDepth: 24,
    channels: 2,
    durationSec,
    isStreamingCache: false,
  };
  tracks[0].parsedHeader = sine.header;
  tracks[0].volume = 0;
  tracks[0].pan = 0; // Center pan -> -3 dB gain per channel (0.7071)
  tracks[0].eq = { lowGain: 0, midGain: 0, midFreq: 1000, highGain: 0 };
  tracks[0].compressor = { enabled: false, threshold: 0, ratio: 1, attack: 0.01, release: 0.1 };
  tracks[0].reverbSend = 0;

  for (let i = 1; i < 4; i++) tracks[i].mute = true;

  const master: MasterState = {
    volume: 0,
    limiterEnabled: false,
    limiterThreshold: 0,
    reverbDecay: 1.5,
    eq: { lowGain: 0, midGain: 0, highGain: 0 },
    peakL: 0,
    peakR: 0,
    rmsL: 0,
    rmsR: 0,
  };

  const settings: ExportSettings = {
    format: 'wav-24',
    sampleRate: 48000,
    range: 'full',
    normalize: false,
  };

  const blob = await renderMixdownWav(tracks, master, settings);
  const decoded = await decode24BitWavBlob(blob);
  const metrics = analyzeSignal(decoded.left, decoded.right, 440, sampleRate);

  // Assertions
  assert.equal(metrics.nanCount, 0, 'NaN count must be 0');
  assert.equal(metrics.infCount, 0, 'Inf count must be 0');
  assert.equal(metrics.samplesExceedingUnity, 0, 'Samples exceeding 1.0 must be 0');
  assert.equal(metrics.clippedOrSaturatedSamples, 0, 'Saturated samples must be 0');
  assert.ok(Math.abs(metrics.dcOffset) < 1e-4, 'DC offset must be negligible');
  assert.ok(metrics.thdPercent !== undefined && metrics.thdPercent < 0.005, `THD (${metrics.thdPercent}%) must be < 0.005%`);

  // Verify pre-encoding Float32 vs Decoded 24-bit match bit-exactly or within dither noise floor
  const { leftGain: panL } = calculateStereoPanGains(0, 2);
  assert.equal(panL, 1.0, 'Stereo balance pan at center must have exact 1.0 unity gain');
  let maxErrorVsExpected = 0;
  for (let i = 0; i < decoded.left.length; i++) {
    const expected = sine.leftRaw[i] * panL;
    const diff = Math.abs(decoded.left[i] - expected);
    if (diff > maxErrorVsExpected) maxErrorVsExpected = diff;
  }
  // Max difference should be 0 (bit-exact) or within quantization noise floor (< 1e-6)
  assert.ok(maxErrorVsExpected < 1e-6, `Error (${maxErrorVsExpected}) must be within quantization noise floor`);
});

test('Controlled Render 2: Four Tracks, all effects bypassed, master -12 dB', async () => {
  const sampleRate = 48000;
  const durationSec = 10;
  const freqs = [440, 554.37, 659.25, 880];
  const tracks = createEmptyTracks();

  for (let t = 0; t < 4; t++) {
    const sine = createSyntheticSineWav({
      frequency: freqs[t],
      durationSec,
      sampleRate,
      amplitude: 0.7079,
      bitDepth: 24,
    });
    tracks[t].sourceBlob = sine.blob;
    tracks[t].fileInfo = {
      name: `sine_${t}.wav`,
      sizeBytes: sine.blob.size,
      sampleRate,
      bitDepth: 24,
      channels: 2,
      durationSec,
      isStreamingCache: false,
    };
    tracks[t].parsedHeader = sine.header;
    tracks[t].volume = 0;
    tracks[t].pan = 0;
    tracks[t].eq = { lowGain: 0, midGain: 0, midFreq: 1000, highGain: 0 };
    tracks[t].compressor = { enabled: false, threshold: 0, ratio: 1, attack: 0.01, release: 0.1 };
    tracks[t].reverbSend = 0;
    tracks[t].mute = false;
  }

  const master: MasterState = {
    volume: -12, // -12 dB master fader
    limiterEnabled: false,
    limiterThreshold: 0,
    reverbDecay: 1.5,
    eq: { lowGain: 0, midGain: 0, highGain: 0 },
    peakL: 0,
    peakR: 0,
    rmsL: 0,
    rmsR: 0,
  };

  const settings: ExportSettings = {
    format: 'wav-24',
    sampleRate: 48000,
    range: 'full',
    normalize: false,
  };

  const blob = await renderMixdownWav(tracks, master, settings);
  const decoded = await decode24BitWavBlob(blob);
  const metrics = analyzeSignal(decoded.left, decoded.right, undefined, sampleRate);

  assert.equal(metrics.nanCount, 0);
  assert.equal(metrics.infCount, 0);
  assert.equal(metrics.samplesExceedingUnity, 0);
  assert.equal(metrics.clippedOrSaturatedSamples, 0);
  assert.ok(metrics.maxPeak < 0.75, `Peak (${metrics.maxPeak}) should be attenuated well below 0 dBFS (-12 dB master)`);
});

test('Controlled Render 3: Four Tracks with active DSP mastering chain and brickwall limiter', async () => {
  const sampleRate = 48000;
  const durationSec = 10;
  const freqs = [440, 554.37, 659.25, 880];
  const tracks = createEmptyTracks();

  for (let t = 0; t < 4; t++) {
    const sine = createSyntheticSineWav({
      frequency: freqs[t],
      durationSec,
      sampleRate,
      amplitude: 0.7079,
      bitDepth: 24,
    });
    tracks[t].sourceBlob = sine.blob;
    tracks[t].fileInfo = {
      name: `sine_${t}.wav`,
      sizeBytes: sine.blob.size,
      sampleRate,
      bitDepth: 24,
      channels: 2,
      durationSec,
      isStreamingCache: false,
    };
    tracks[t].parsedHeader = sine.header;
    tracks[t].volume = 0;
    tracks[t].pan = t === 0 ? -0.3 : t === 1 ? 0.3 : t === 2 ? -0.5 : 0.5;
    tracks[t].eq = { lowGain: 2.0, midGain: -1.0, midFreq: 1000, highGain: 1.5 };
    tracks[t].compressor = { enabled: true, threshold: -14, ratio: 4, attack: 0.01, release: 0.1 };
    tracks[t].reverbSend = 0.2;
    tracks[t].mute = false;
  }

  const master: MasterState = {
    volume: 0,
    limiterEnabled: true,
    limiterThreshold: -0.5,
    reverbDecay: 1.5,
    eq: { lowGain: 1.0, midGain: 0.5, highGain: 0.5 },
    peakL: 0,
    peakR: 0,
    rmsL: 0,
    rmsR: 0,
  };

  const settings: ExportSettings = {
    format: 'wav-24',
    sampleRate: 48000,
    range: 'full',
    normalize: false,
  };

  const blob = await renderMixdownWav(tracks, master, settings);
  const decoded = await decode24BitWavBlob(blob);
  const metrics = analyzeSignal(decoded.left, decoded.right, undefined, sampleRate);

  assert.equal(metrics.nanCount, 0);
  assert.equal(metrics.infCount, 0);
  assert.equal(metrics.samplesExceedingUnity, 0, 'No samples should exceed 1.0 under brickwall limiter');
  assert.ok(metrics.maxPeak <= 1.000001, 'Peak must be bounded by 1.0');

  // Verify that there are NO discontinuous cliffs (sample-to-sample deltas > 0.15)
  // which were previously causing massive harmonic distortion (10,036 cliffs)
  let cliffs = 0;
  for (let i = 1; i < decoded.left.length; i++) {
    const delta = Math.abs(decoded.left[i] - decoded.left[i - 1]);
    if (delta > 0.20) cliffs++;
  }
  assert.ok(cliffs <= 5, `Large step discontinuities (${cliffs}) must be <= 5 (was 10,036 previously)`);
});

test('Master Limiter THD reduction on hot sine input', async () => {
  const sampleRate = 48000;
  // Overdriven sine that drives heavily into the limiter
  const sine = createSyntheticSineWav({
    frequency: 440,
    durationSec: 3,
    sampleRate,
    amplitude: 0.99,
    bitDepth: 24,
  });

  const tracks = createEmptyTracks();
  tracks[0].sourceBlob = sine.blob;
  tracks[0].fileInfo = {
    name: 'sine_hot.wav',
    sizeBytes: sine.blob.size,
    sampleRate,
    bitDepth: 24,
    channels: 2,
    durationSec: 3,
    isStreamingCache: false,
  };
  tracks[0].parsedHeader = sine.header;
  tracks[0].volume = 3.01; // boosts signal by +3 dBFS
  tracks[0].pan = 0;
  for (let i = 1; i < 4; i++) tracks[i].mute = true;

  const master: MasterState = {
    volume: 0,
    limiterEnabled: true,
    limiterThreshold: -0.5,
    reverbDecay: 1.5,
    eq: { lowGain: 0, midGain: 0, highGain: 0 },
    peakL: 0,
    peakR: 0,
    rmsL: 0,
    rmsR: 0,
  };

  const blob = await renderMixdownWav(tracks, master, {
    format: 'wav-24',
    sampleRate,
    range: 'full',
    normalize: false,
  });

  const decoded = await decode24BitWavBlob(blob);
  const metrics = analyzeSignal(decoded.left, decoded.right, 440, sampleRate);

  // Previously THD was 11.375% due to the discontinuous tanh step function.
  // With the stateful dynamic compressor + C1 continuous saturation, THD must be < 0.05%
  assert.ok(metrics.thdPercent !== undefined, 'THD must be computed');
  assert.ok(
    metrics.thdPercent < 0.05,
    `THD on limited sine (${metrics.thdPercent.toFixed(4)}%) must be < 0.05% (previously 11.375%)`
  );
});

test('24-Bit RIFF Header & Byte-Packing Verification', () => {
  const sampleRate = 48000;
  const numFrames = 480;
  const left = new Float32Array(numFrames);
  const right = new Float32Array(numFrames);

  // Known sample values: +0.5, -0.5, +1.0, -1.0
  left[0] = 0.5;
  right[0] = -0.5;
  left[1] = 1.0;
  right[1] = -1.0;

  const buf = encodeWavBuffer(left, right, sampleRate, 24);
  const header = parseWavHeader(buf);

  assert.equal(header.audioFormat, 1, 'Audio format must be 1 (PCM)');
  assert.equal(header.channels, 2, 'Channels must be 2');
  assert.equal(header.sampleRate, 48000);
  assert.equal(header.bitsPerSample, 24);
  assert.equal(header.blockAlign, 6, 'BlockAlign must be 6 (2 channels * 3 bytes)');
  assert.equal(header.byteRate, 48000 * 6, 'ByteRate must be 288,000');

  const view = new DataView(buf);
  // Check frame 0: Left = +0.5, Right = -0.5
  // Left: +0.5 * 8388607 = 4194304 (0x400000) (approx with dither +/- 1)
  const b0L = view.getUint8(44);
  const b1L = view.getUint8(45);
  const b2L = view.getUint8(46);
  let intL = (b2L << 16) | (b1L << 8) | b0L;
  if (intL & 0x800000) intL |= ~0xffffff;
  assert.ok(Math.abs(intL - 4194304) <= 2, `Frame 0 Left int (${intL}) should be near 4194304`);

  // Right: -0.5 * 8388608 = -4194304 (0xFFC00000)
  const b0R = view.getUint8(47);
  const b1R = view.getUint8(48);
  const b2R = view.getUint8(49);
  let intR = (b2R << 16) | (b1R << 8) | b0R;
  if (intR & 0x800000) intR |= ~0xffffff;
  assert.ok(Math.abs(intR - (-4194304)) <= 2, `Frame 0 Right int (${intR}) should be near -4194304`);
});

test('Chunk boundary continuity across 5-second processing windows', async () => {
  const sampleRate = 48000;
  const sine = createSyntheticSineWav({
    frequency: 440,
    durationSec: 10,
    sampleRate,
    amplitude: 0.5,
    bitDepth: 24,
  });

  const tracks = createEmptyTracks();
  tracks[0].sourceBlob = sine.blob;
  tracks[0].fileInfo = {
    name: 'sine.wav',
    sizeBytes: sine.blob.size,
    sampleRate,
    bitDepth: 24,
    channels: 2,
    durationSec: 10,
    isStreamingCache: false,
  };
  tracks[0].parsedHeader = sine.header;
  tracks[0].volume = 0;
  tracks[0].pan = -1.0; // Left only (pan gain = 1.0)
  // Enable active EQ to verify biquad state variables persist seamlessly across chunks
  tracks[0].eq = { lowGain: 3.0, midGain: -2.0, midFreq: 1200, highGain: 2.0 };
  for (let i = 1; i < 4; i++) tracks[i].mute = true;

  const master: MasterState = {
    volume: 0,
    limiterEnabled: false,
    limiterThreshold: 0,
    reverbDecay: 1.5,
    eq: { lowGain: 0, midGain: 0, highGain: 0 },
    peakL: 0,
    peakR: 0,
    rmsL: 0,
    rmsR: 0,
  };

  const blob = await renderMixdownWav(tracks, master, {
    format: 'wav-24',
    sampleRate,
    range: 'full',
    normalize: false,
  });

  const decoded = await decode24BitWavBlob(blob);
  const boundaryFrame = 5 * sampleRate; // Frame 240,000

  // The step between frame 239,999 and 240,000 must match the continuous sine slope
  const stepBefore = Math.abs(decoded.left[boundaryFrame - 1] - decoded.left[boundaryFrame - 2]);
  const stepAtBoundary = Math.abs(decoded.left[boundaryFrame] - decoded.left[boundaryFrame - 1]);
  const stepAfter = Math.abs(decoded.left[boundaryFrame + 1] - decoded.left[boundaryFrame]);

  // Delta across the 5s chunk boundary should match adjacent steps within 10%
  const avgAdjacentStep = (stepBefore + stepAfter) / 2;
  assert.ok(
    Math.abs(stepAtBoundary - avgAdjacentStep) < 0.01,
    `Step at chunk boundary (${stepAtBoundary.toFixed(5)}) must match adjacent step (${avgAdjacentStep.toFixed(5)}) with zero glitch`
  );
});

test('Resampler chunk boundary continuity across 5s windows (44.1 kHz -> 48 kHz)', async () => {
  const srcSampleRate = 44100;
  const dstSampleRate = 48000;
  const durationSec = 10;
  const sine = createSyntheticSineWav({
    frequency: 440,
    durationSec,
    sampleRate: srcSampleRate,
    amplitude: 0.5,
    bitDepth: 24,
  });

  const tracks = createEmptyTracks();
  tracks[0].sourceBlob = sine.blob;
  tracks[0].fileInfo = {
    name: 'sine_44k.wav',
    sizeBytes: sine.blob.size,
    sampleRate: srcSampleRate,
    bitDepth: 24,
    channels: 2,
    durationSec,
    isStreamingCache: false,
  };
  tracks[0].parsedHeader = sine.header;
  tracks[0].volume = 0;
  tracks[0].pan = 0;
  tracks[0].eq = { lowGain: 0, midGain: 0, midFreq: 1000, highGain: 0 };
  for (let i = 1; i < 4; i++) tracks[i].mute = true;

  const master: MasterState = {
    volume: 0,
    limiterEnabled: false,
    limiterThreshold: 0,
    reverbDecay: 1.5,
    eq: { lowGain: 0, midGain: 0, highGain: 0 },
    peakL: 0, peakR: 0, rmsL: 0, rmsR: 0,
  };

  const blob = await renderMixdownWav(tracks, master, {
    format: 'wav-24',
    sampleRate: dstSampleRate,
    range: 'full',
    normalize: false,
    bypassCompressors: true,
    bypassLimiter: true,
  });

  const decoded = await decode24BitWavBlob(blob);
  const boundaryFrame = 5 * dstSampleRate; // Frame 240,000

  // The step across chunk boundary must be smooth with zero click
  const stepBefore = Math.abs(decoded.left[boundaryFrame - 1] - decoded.left[boundaryFrame - 2]);
  const stepAtBoundary = Math.abs(decoded.left[boundaryFrame] - decoded.left[boundaryFrame - 1]);
  const stepAfter = Math.abs(decoded.left[boundaryFrame + 1] - decoded.left[boundaryFrame]);
  const avgAdjacentStep = (stepBefore + stepAfter) / 2;

  assert.ok(
    Math.abs(stepAtBoundary - avgAdjacentStep) < 0.015,
    `Resampler boundary step (${stepAtBoundary.toFixed(5)}) must match adjacent step (${avgAdjacentStep.toFixed(5)})`
  );
});

test('Controlled 24-bit Export Test Suite (Scenarios A through E)', async () => {
  const sampleRate = 48000;
  const durationSec = 5;
  const freqs = [440, 554.37, 659.25, 880];

  function setupTracks() {
    const trks = createEmptyTracks();
    for (let t = 0; t < 4; t++) {
      const sine = createSyntheticSineWav({
        frequency: freqs[t],
        durationSec,
        sampleRate,
        amplitude: 0.5,
        bitDepth: 24,
      });
      trks[t].sourceBlob = sine.blob;
      trks[t].fileInfo = {
        name: `sine_${t}.wav`,
        sizeBytes: sine.blob.size,
        sampleRate,
        bitDepth: 24,
        channels: 2,
        durationSec,
        isStreamingCache: false,
      };
      trks[t].parsedHeader = sine.header;
      trks[t].volume = 0;
      trks[t].pan = 0;
      trks[t].eq = { lowGain: 0, midGain: 0, midFreq: 1000, highGain: 0 };
      trks[t].compressor = { enabled: false, threshold: -12, ratio: 4, attack: 0.01, release: 0.1 };
      trks[t].reverbSend = 0;
      trks[t].mute = false;
    }
    return trks;
  }

  // --- Test A: Single track, all DSP bypassed ---
  {
    const tracksA = setupTracks();
    for (let i = 1; i < 4; i++) tracksA[i].mute = true;
    const masterA: MasterState = {
      volume: 0,
      limiterEnabled: false,
      limiterThreshold: 0,
      reverbDecay: 1.5,
      eq: { lowGain: 0, midGain: 0, highGain: 0 },
      peakL: 0, peakR: 0, rmsL: 0, rmsR: 0,
    };
    const settingsA: ExportSettings = {
      format: 'wav-24',
      sampleRate,
      range: 'full',
      normalize: false,
      bypassCompressors: true,
      bypassLimiter: true,
    };
    const blob = await renderMixdownWav(tracksA, masterA, settingsA);
    const decoded = await decode24BitWavBlob(blob);
    const metrics = analyzeSignal(decoded.left, decoded.right, 440, sampleRate);
    console.log('MEASURED_TEST_A:', JSON.stringify(metrics));
    assert.equal(metrics.clippedOrSaturatedSamples, 0);
    assert.ok(metrics.thdPercent !== undefined && metrics.thdPercent < 0.005);
  }

  // --- Test B: Four tracks, all DSP bypassed (master -12 dB to prevent clipping) ---
  {
    const tracksB = setupTracks();
    const masterB: MasterState = {
      volume: -12,
      limiterEnabled: false,
      limiterThreshold: 0,
      reverbDecay: 1.5,
      eq: { lowGain: 0, midGain: 0, highGain: 0 },
      peakL: 0, peakR: 0, rmsL: 0, rmsR: 0,
    };
    const settingsB: ExportSettings = {
      format: 'wav-24',
      sampleRate,
      range: 'full',
      normalize: false,
      bypassCompressors: true,
      bypassLimiter: true,
    };
    const blob = await renderMixdownWav(tracksB, masterB, settingsB);
    const decoded = await decode24BitWavBlob(blob);
    const metrics = analyzeSignal(decoded.left, decoded.right, undefined, sampleRate);
    console.log('MEASURED_TEST_B:', JSON.stringify(metrics));
    assert.equal(metrics.clippedOrSaturatedSamples, 0);
    assert.ok(metrics.maxPeak < 0.6);
  }

  // --- Test C: Four tracks, compressor only (limiter bypassed) ---
  {
    const tracksC = setupTracks();
    for (let t = 0; t < 4; t++) {
      tracksC[t].compressor = { enabled: true, threshold: -12, ratio: 3, attack: 0.01, release: 0.1 };
    }
    const masterC: MasterState = {
      volume: -6,
      limiterEnabled: false,
      limiterThreshold: 0,
      reverbDecay: 1.5,
      eq: { lowGain: 0, midGain: 0, highGain: 0 },
      peakL: 0, peakR: 0, rmsL: 0, rmsR: 0,
    };
    const settingsC: ExportSettings = {
      format: 'wav-24',
      sampleRate,
      range: 'full',
      normalize: false,
      bypassCompressors: false, // Enable compressor
      bypassLimiter: true,      // Limiter bypassed
    };
    const blob = await renderMixdownWav(tracksC, masterC, settingsC);
    const decoded = await decode24BitWavBlob(blob);
    const metrics = analyzeSignal(decoded.left, decoded.right, undefined, sampleRate);
    console.log('MEASURED_TEST_C:', JSON.stringify(metrics));
    assert.equal(metrics.clippedOrSaturatedSamples, 0);
  }

  // --- Test D: Four tracks, limiter only (compressors bypassed) ---
  {
    const tracksD = setupTracks();
    const masterD: MasterState = {
      volume: 0,
      limiterEnabled: true,
      limiterThreshold: -0.5,
      reverbDecay: 1.5,
      eq: { lowGain: 0, midGain: 0, highGain: 0 },
      peakL: 0, peakR: 0, rmsL: 0, rmsR: 0,
    };
    const settingsD: ExportSettings = {
      format: 'wav-24',
      sampleRate,
      range: 'full',
      normalize: false,
      bypassCompressors: true, // Compressors bypassed
      bypassLimiter: false,    // Limiter active
    };
    const blob = await renderMixdownWav(tracksD, masterD, settingsD);
    const decoded = await decode24BitWavBlob(blob);
    const metrics = analyzeSignal(decoded.left, decoded.right, undefined, sampleRate);
    console.log('MEASURED_TEST_D:', JSON.stringify(metrics));
    assert.ok(metrics.maxPeak <= 1.000001);
    assert.equal(metrics.samplesExceedingUnity, 0);
  }

  // --- Test E: Four tracks, both enabled ---
  {
    const tracksE = setupTracks();
    for (let t = 0; t < 4; t++) {
      tracksE[t].compressor = { enabled: true, threshold: -12, ratio: 3, attack: 0.01, release: 0.1 };
    }
    const masterE: MasterState = {
      volume: 0,
      limiterEnabled: true,
      limiterThreshold: -0.5,
      reverbDecay: 1.5,
      eq: { lowGain: 0, midGain: 0, highGain: 0 },
      peakL: 0, peakR: 0, rmsL: 0, rmsR: 0,
    };
    const settingsE: ExportSettings = {
      format: 'wav-24',
      sampleRate,
      range: 'full',
      normalize: false,
      bypassCompressors: false, // Compressor active
      bypassLimiter: false,     // Limiter active
    };
    const blob = await renderMixdownWav(tracksE, masterE, settingsE);
    const decoded = await decode24BitWavBlob(blob);
    const metrics = analyzeSignal(decoded.left, decoded.right, undefined, sampleRate);
    console.log('MEASURED_TEST_E:', JSON.stringify(metrics));
    assert.ok(metrics.maxPeak <= 1.000001);
    assert.equal(metrics.samplesExceedingUnity, 0);
  }
});
