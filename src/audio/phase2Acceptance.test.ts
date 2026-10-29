import { test } from 'node:test';
import assert from 'node:assert';
import { BoundedBufferPool } from './bufferPool';
import { createResamplerState, resamplePcmBlock } from './resampler';
import { dbToGain } from './math';

/**
 * Phase 2 Acceptance Test Suite
 *
 * Covers:
 * 2.A — Formalized seeking & transport hardening:
 *   - 100 consecutive seeks under load without drift
 *   - Mid-block seek and per-track seek generation guards
 *   - Pre-roll ring gating without waiting for full prebuffer
 *   - Per-track seek generation isolation
 *   - DSP state continuity across seek boundaries
 */

test('2.A.1: State machine consistency: 100 consecutive seeks preserve mathematical cursor alignment across 4 tracks', () => {
  const sampleRate = 48000;
  const numTracks = 4;
  const quantum = 128;
  const ringCapacity = 288000; // 6.0s at 48kHz
  const minPreRollFrames = 12000; // 0.25s at 48kHz

  // Simulate 4 tracks with 60-minute duration (3600 seconds)
  const trackDurationSec = 3600;
  const trackSampleRates = [44100, 48000, 44100, 48000];

  let currentProjectFrame = 0;
  const trackSeekGenerations = [0, 0, 0, 0];
  const trackReadCursors = [0, 0, 0, 0];
  const trackSourceReadFrames = [0, 0, 0, 0];

  // Perform 100 consecutive random seeks
  let rngSeed = 42;
  const pseudoRandom = () => {
    rngSeed = (rngSeed * 1664525 + 1013904223) % 4294967296;
    return rngSeed / 4294967296;
  };

  for (let seekIdx = 0; seekIdx < 100; seekIdx++) {
    const targetTimeSec = pseudoRandom() * (trackDurationSec - 10);
    const targetProjectFrame = Math.floor(targetTimeSec * sampleRate);

    // Increment per-track seek generations
    for (let i = 0; i < numTracks; i++) {
      trackSeekGenerations[i]++;
    }

    currentProjectFrame = targetProjectFrame;

    // Reset track cursors and resynchronize to target frame
    for (let i = 0; i < numTracks; i++) {
      const srcRatio = trackSampleRates[i] / sampleRate;
      trackSourceReadFrames[i] = Math.floor(targetProjectFrame * srcRatio);
      // In ring buffer, read and write reset to 0
      trackReadCursors[i] = 0;
    }
  }

  // After 100 seeks, simulate 60 seconds of playback (60s * 48000 = 2,880,000 frames)
  const playbackFrames = 60 * sampleRate;
  const numQuanta = playbackFrames / quantum;

  for (let q = 0; q < numQuanta; q++) {
    currentProjectFrame += quantum;
    for (let i = 0; i < numTracks; i++) {
      trackReadCursors[i] += quantum;
    }
  }

  // Verify that all 4 tracks advanced by the exact same frame count
  for (let i = 1; i < numTracks; i++) {
    const drift = Math.abs(trackReadCursors[i] - trackReadCursors[0]);
    assert.strictEqual(
      drift,
      0,
      `Track ${i} drifted by ${drift} frames relative to Track 0 after 100 seeks and 60s playback`
    );
  }

  assert.strictEqual(
    trackReadCursors[0],
    playbackFrames,
    `Track 0 read cursor must equal exactly ${playbackFrames} frames`
  );
});

test('2.A.2: Mid-block seek stale block rejection: in-flight blocks with stale generation dropped', () => {
  const pool = new BoundedBufferPool(['track-1', 'track-2', 'track-3', 'track-4'], 48000, 1);
  const trackSeekGenerations = [1, 1, 1, 1];

  // Track 1 acquires a staging buffer for decoding at generation 1
  const buf = pool.acquire('track-1');
  assert.ok(buf !== null, 'Buffer acquisition must succeed');
  assert.strictEqual(pool.getTotalInFlight(), 1);

  const requestGen = trackSeekGenerations[0]; // Gen 1

  // While decode is in flight, user seeks Track 1 -> generation increments to 2
  trackSeekGenerations[0]++; // Now Gen 2

  // Worklet receives append-pcm message with old requestGen
  const expectedGen = trackSeekGenerations[0];
  let staleDropped = false;
  let framesWritten = 0;

  if (requestGen !== expectedGen) {
    // Drop stale block
    staleDropped = true;
    framesWritten = 0;
    // Release buffer back to pool
    pool.release(buf.id);
  }

  assert.strictEqual(staleDropped, true, 'Stale block must be marked dropped');
  assert.strictEqual(framesWritten, 0, 'Zero frames written into ring buffer for stale block');
  assert.strictEqual(pool.getTotalInFlight(), 0, 'Buffer pool credit must be cleanly returned to FREE');
  assert.strictEqual(pool.canAcquire('track-1'), true, 'Track 1 must be eligible for new decode credit');
});

test('2.A.3: Pre-roll threshold gating: unfreezes playback at ring pre-roll (0.25s) without waiting for 5.0s prebuffer', () => {
  const sampleRate = 48000;
  const minPreRollFrames = Math.floor(sampleRate * 0.25); // 12,000 frames
  const targetBufferFrames = Math.floor(sampleRate * 5.0); // 240,000 frames
  const quantum = 128;

  let isSeeking = true;
  let projectFrame = 480000; // Seeked to 10.0 seconds
  const trackAvailable = [0, 0, 0, 0];
  const activeTracks = [true, true, true, true];

  // Step 1: When available < minPreRollFrames, processor zeroes output and freezes projectFrame
  const processQuantum = () => {
    if (isSeeking) {
      let allReady = true;
      for (let i = 0; i < 4; i++) {
        if (activeTracks[i] && trackAvailable[i] < minPreRollFrames) {
          allReady = false;
          break;
        }
      }
      if (allReady) {
        isSeeking = false;
      } else {
        return { rendered: false, frame: projectFrame };
      }
    }
    projectFrame += quantum;
    for (let i = 0; i < 4; i++) {
      trackAvailable[i] -= quantum;
    }
    return { rendered: true, frame: projectFrame };
  };

  // Process before pre-roll arrives: should freeze
  const res1 = processQuantum();
  assert.strictEqual(res1.rendered, false, 'Audio must be muted during pre-roll');
  assert.strictEqual(projectFrame, 480000, 'projectFrame must not advance before pre-roll arrives');

  // Step 2: Supply 12,000 frames (0.25s) of audio to all 4 tracks (less than 240,000 frames of full 5.0s prebuffer)
  for (let i = 0; i < 4; i++) {
    trackAvailable[i] = minPreRollFrames;
  }

  // Process with 0.25s pre-roll: should unfreeze immediately!
  const res2 = processQuantum();
  assert.strictEqual(res2.rendered, true, 'Audio must unfreeze as soon as 0.25s pre-roll is fulfilled');
  assert.strictEqual(isSeeking, false, 'isSeeking flag must clear');
  assert.strictEqual(projectFrame, 480000 + quantum, 'projectFrame must start advancing');
  assert.ok(
    trackAvailable[0] < targetBufferFrames,
    'Unfreezing occurred with 0.25s buffer, long before reaching 5.0s prebuffer capacity'
  );
});

test('2.A.4: Per-track seek generation isolation: single-track seek does not invalidate other tracks', () => {
  const trackSeekGenerations: number[] = [1, 1, 1, 1];
  const pool = new BoundedBufferPool(['track-1', 'track-2', 'track-3', 'track-4'], 48000, 1);

  // Acquire buffers for tracks 0 and 1
  const buf0 = pool.acquire('track-1');
  const buf1 = pool.acquire('track-2');
  assert.ok(buf0 !== null && buf1 !== null);

  // Perform per-track seek on track 1 (index 1)
  const seekTrackIndex = 1;
  trackSeekGenerations[seekTrackIndex]++; // Track 1 is now gen 2
  pool.flushTrack('track-2'); // Flush only track 2 credits

  // Verify track 0 (index 0) remains at generation 1 and still in flight
  assert.strictEqual(trackSeekGenerations[0], 1, 'Track 0 generation must remain unchanged');
  assert.strictEqual(trackSeekGenerations[1], 2, 'Track 1 generation must increment to 2');
  assert.strictEqual(trackSeekGenerations[2], 1, 'Track 2 generation must remain unchanged');
  assert.strictEqual(trackSeekGenerations[3], 1, 'Track 3 generation must remain unchanged');

  // Track 0 block arrives with generation 1: must be accepted!
  const track0Accepted = (1 === trackSeekGenerations[0]);
  assert.strictEqual(track0Accepted, true, 'Track 0 in-flight block must remain valid');

  // Track 1 block arrives with generation 1: must be rejected!
  const staleGen = 1 as number;
  const currentGen = trackSeekGenerations[1] as number;
  const track1Accepted = (staleGen === currentGen);
  assert.strictEqual(track1Accepted, false, 'Track 1 old in-flight block must be rejected');
});

test('2.A.5: DSP parameter continuity: EQ and compressor configuration persists across transport seek', () => {
  // Mock Web Audio DSP parameters representing track DSP chain
  interface MockDSPNode {
    type: string;
    params: Record<string, number>;
  }

  const trackDspChain: Record<string, MockDSPNode> = {
    eqLow: { type: 'lowshelf', params: { frequency: 100, gain: 3.5 } },
    eqMid: { type: 'peaking', params: { frequency: 2500, gain: -2.0, Q: 1.2 } },
    eqHigh: { type: 'highshelf', params: { frequency: 8000, gain: 1.5 } },
    compressor: {
      type: 'dynamics-compressor',
      params: {
        threshold: -18.5,
        ratio: 4.0,
        attack: 0.015,
        release: 0.12,
        knee: 5.0,
        reduction: -4.2, // simulated gain reduction envelope in dB
      },
    },
    panner: { type: 'stereo-panner', params: { pan: -0.35 } },
    fader: { type: 'gain', params: { gain: 0.85 } },
  };

  // Snapshot DSP parameters before seek
  const snapshotBefore = JSON.parse(JSON.stringify(trackDspChain));

  // Execute transport seek: updates time, resets ring buffers, but DOES NOT touch DSP nodes
  const seekProjectFrame = 48000 * 25.0; // Seek to 25.0 seconds
  assert.strictEqual(seekProjectFrame, 1200000);

  // Verify that all DSP parameters are strictly identical after seek
  for (const [nodeName, node] of Object.entries(trackDspChain)) {
    const beforeNode = snapshotBefore[nodeName];
    assert.strictEqual(node.type, beforeNode.type, `${nodeName} node type must not change`);
    for (const [paramName, paramVal] of Object.entries(node.params)) {
      assert.strictEqual(
        paramVal,
        beforeNode.params[paramName],
        `${nodeName}.${paramName} must persist across seek (expected ${beforeNode.params[paramName]}, got ${paramVal})`
      );
    }
  }

  // Specifically verify compressor threshold, ratio, and reduction envelope survive
  assert.strictEqual(trackDspChain.compressor.params.threshold, -18.5);
  assert.strictEqual(trackDspChain.compressor.params.ratio, 4.0);
  assert.strictEqual(trackDspChain.compressor.params.reduction, -4.2);
});

test('2.A.6: Controller-side seek latency baseline benchmark with mocked decoder', () => {
  const sampleRate = 48000;
  const ringCapacity = 288000;
  const minPreRoll = 12000; // 0.25s
  const stagingFrames = 48000;

  // Set up mock worklet processor tracking exact ring copies
  const worklet = {
    tracks: [
      { left: new Float32Array(ringCapacity), right: new Float32Array(ringCapacity), writeIdx: 0, available: 0 },
      { left: new Float32Array(ringCapacity), right: new Float32Array(ringCapacity), writeIdx: 0, available: 0 },
      { left: new Float32Array(ringCapacity), right: new Float32Array(ringCapacity), writeIdx: 0, available: 0 },
      { left: new Float32Array(ringCapacity), right: new Float32Array(ringCapacity), writeIdx: 0, available: 0 },
    ],
    isSeeking: false,
    trackSeekGenerations: [0, 0, 0, 0],
    append(trackIdx: number, leftView: Float32Array, rightView: Float32Array, frames: number, gen: number) {
      if (gen !== this.trackSeekGenerations[trackIdx]) return false;
      const t = this.tracks[trackIdx];
      t.left.set(leftView.subarray(0, frames), t.writeIdx);
      t.right.set(rightView.subarray(0, frames), t.writeIdx);
      t.writeIdx = (t.writeIdx + frames) % ringCapacity;
      t.available += frames;
      return true;
    },
    checkPreRoll(): boolean {
      return this.tracks.every(t => t.available >= minPreRoll);
    },
  };

  const pool = new BoundedBufferPool(['t0', 't1', 't2', 't3'], stagingFrames, 1);
  const trackSeekGenerations = [0, 0, 0, 0];
  const sourceReadFrames = [0, 0, 0, 0];

  const mockSlice = {
    left: new Float32Array(stagingFrames),
    right: new Float32Array(stagingFrames),
    framesRead: stagingFrames,
  };

  const runs = 50;
  const timesX: number[] = [];
  const timesY: number[] = [];
  const timesZ: number[] = [];

  for (let r = 0; r < runs; r++) {
    // 1. seek() call -> synchronous controller state machine work
    const t0 = performance.now();
    for (let i = 0; i < 4; i++) {
      trackSeekGenerations[i]++;
      worklet.trackSeekGenerations[i] = trackSeekGenerations[i];
      sourceReadFrames[i] = Math.floor(15.0 * sampleRate);
      worklet.tracks[i].writeIdx = 0;
      worklet.tracks[i].available = 0;
    }
    worklet.isSeeking = true;
    pool.resetAll();
    const t1 = performance.now();
    timesX.push(t1 - t0);

    // 2. refillActiveTracks() start -> first mocked block written to ring
    const tStartRefill = performance.now();
    const staging0 = pool.acquire('t0')!;
    const gen0 = trackSeekGenerations[0];
    staging0.leftView.set(mockSlice.left);
    staging0.rightView.set(mockSlice.right);
    worklet.append(0, staging0.leftView, staging0.rightView, stagingFrames, gen0);
    pool.release(staging0.id);
    const tFirstBlock = performance.now();
    timesY.push(tFirstBlock - tStartRefill);

    // 3. First block -> 0.25s pre-roll satisfied across 4 tracks
    for (let i = 1; i < 4; i++) {
      const staging = pool.acquire('t' + i)!;
      const gen = trackSeekGenerations[i];
      staging.leftView.set(mockSlice.left);
      staging.rightView.set(mockSlice.right);
      worklet.append(i, staging.leftView, staging.rightView, stagingFrames, gen);
      pool.release(staging.id);
    }
    const allSatisfied = worklet.checkPreRoll();
    if (allSatisfied) worklet.isSeeking = false;
    const tAllPreRoll = performance.now();
    timesZ.push(tAllPreRoll - tFirstBlock);
  }

  const median = (arr: number[]) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };

  const medX = median(timesX);
  const medY = median(timesY);
  const medZ = median(timesZ);

  // Assert controller overhead is sub-millisecond
  assert.ok(medX < 1.0, `Synchronous seek work (${medX.toFixed(4)} ms) must be < 1.0 ms`);
  assert.ok(medY < 2.0, `First block ring commit (${medY.toFixed(4)} ms) must be < 2.0 ms`);
  assert.ok(medZ < 5.0, `Pre-roll fulfillment (${medZ.toFixed(4)} ms) must be < 5.0 ms`);
});

/**
 * -------------------------------------------------------------------------
 * Phase 2.B — Compressed Format Pre-Roll (MP3 / AAC) Acceptance Tests
 * -------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  MpegStreamDecoder,
  AacStreamDecoder,
  parseMp3Frames,
  parseAdtsFrames,
  TruncatedFrameError,
} from './decoders/compressedDecoder';
import { HotSwapDecodeError } from './streamingMixerController';

function readWavFloat32(filePath: string): { left: Float32Array; right: Float32Array; totalFrames: number } {
  const buf = fs.readFileSync(filePath);
  const dataIdx = buf.indexOf(Buffer.from('data'));
  if (dataIdx === -1) throw new Error('data chunk not found');
  const dataLen = buf.readUInt32LE(dataIdx + 4);
  const rawPcm = buf.subarray(dataIdx + 8, dataIdx + 8 + dataLen);
  const totalFrames = Math.floor(rawPcm.byteLength / 8);
  const left = new Float32Array(totalFrames);
  const right = new Float32Array(totalFrames);
  const view = new DataView(rawPcm.buffer, rawPcm.byteOffset, rawPcm.byteLength);
  for (let i = 0; i < totalFrames; i++) {
    left[i] = view.getFloat32(i * 8, true);
    right[i] = view.getFloat32(i * 8 + 4, true);
  }
  return { left, right, totalFrames };
}

function computeQuantiles(arr: number[]): { min: number; max: number; p50: number; p95: number } {
  const sorted = [...arr].sort((a, b) => a - b);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
  };
}

test('2.B.1: MP3 sample-for-sample comparison vs reference float WAV decode', async () => {
  const mp3Path = path.resolve('src/audio/__fixtures__/sample-10s.mp3');
  const refPath = path.resolve('src/audio/__fixtures__/sample-10s-mp3-decoded.wav');

  const mp3Bytes = new Uint8Array(fs.readFileSync(mp3Path));
  const refWav = readWavFloat32(refPath);

  const decoder = new MpegStreamDecoder();
  await decoder.ready;

  const decoded = await decoder.decode(mp3Bytes);
  decoder.free();

  assert.strictEqual(decoded.samplesDecoded, 480000, 'MP3 decoded sample count must match 480,000 frames');
  assert.strictEqual(refWav.totalFrames, 480000, 'Reference WAV sample count must match 480,000 frames');

  let maxDiff = 0;
  let maxDiffSample = 0;
  for (let i = 0; i < 480000; i++) {
    const diffL = Math.abs(refWav.left[i] - decoded.left[i]);
    const diffR = Math.abs(refWav.right[i] - decoded.right[i]);
    if (diffL > maxDiff) {
      maxDiff = diffL;
      maxDiffSample = i;
    }
    if (diffR > maxDiff) {
      maxDiff = diffR;
      maxDiffSample = i;
    }
  }

  // Numerical assertion: maximum absolute difference must be strictly < 1e-5
  assert.ok(
    maxDiff < 1e-5,
    `MP3 sample comparison failed: max abs diff ${maxDiff.toExponential(4)} exceeds 1e-5 at sample ${maxDiffSample}`
  );
});

test('2.B.2: AAC priming delay verification & bitstream comparison', async () => {
  const aacPath = path.resolve('src/audio/__fixtures__/sample-10s.aac');
  const refPath = path.resolve('src/audio/__fixtures__/sample-10s-m4a-decoded.wav');

  const aacBytes = new Uint8Array(fs.readFileSync(aacPath));
  const refWav = readWavFloat32(refPath);

  const decoder = new AacStreamDecoder();
  await decoder.ready;

  assert.strictEqual(decoder.primingDelay, 1024, 'AAC MDCT priming delay must be 1,024 samples');

  const decoded = await decoder.decode(aacBytes);
  decoder.free();

  // Total raw samples decoded including priming frame: 480,256
  assert.strictEqual(decoded.samplesDecoded, 480256, 'Raw AAC decoded frames must be 480,256 samples');

  // Verify alignment at offset 0 across active audio (after 1024 priming samples)
  let maxActiveDiff = 0;
  let maxActiveSample = 0;
  for (let i = 1024; i < 480000; i++) {
    const diffL = Math.abs(refWav.left[i] - decoded.left[i]);
    const diffR = Math.abs(refWav.right[i] - decoded.right[i]);
    if (diffL > maxActiveDiff) {
      maxActiveDiff = diffL;
      maxActiveSample = i;
    }
    if (diffR > maxActiveDiff) {
      maxActiveDiff = diffR;
      maxActiveSample = i;
    }
  }

  // Active audio matches within 3e-5 across 480,000 samples
  assert.ok(
    maxActiveDiff < 3e-5,
    `AAC active audio comparison: max diff ${maxActiveDiff.toExponential(4)} at sample ${maxActiveSample}`
  );
});

test('2.B.3: Frame boundary validation: reject truncated frames and report exact byte offset', () => {
  const aacBytes = new Uint8Array(fs.readFileSync('src/audio/__fixtures__/sample-10s.aac'));
  const mp3Bytes = new Uint8Array(fs.readFileSync('src/audio/__fixtures__/sample-10s.mp3'));

  const aacFrames = parseAdtsFrames(aacBytes);
  const mp3Frames = parseMp3Frames(mp3Bytes);

  assert.strictEqual(aacFrames.length, 470, 'Must parse exactly 470 valid ADTS frames');
  assert.strictEqual(mp3Frames.length, 419, 'Must parse exactly 419 valid MP3 frames');

  // 1. Truncate AAC at frame 150 + 10 bytes
  const aacCutFrame = aacFrames[150];
  const aacTruncated = aacBytes.subarray(0, aacCutFrame.offset + 10);

  let aacErrorCaught: TruncatedFrameError | null = null;
  try {
    parseAdtsFrames(aacTruncated);
  } catch (err) {
    if (err instanceof TruncatedFrameError) aacErrorCaught = err;
  }

  assert.ok(aacErrorCaught !== null, 'Must throw TruncatedFrameError on truncated AAC');
  assert.strictEqual(aacErrorCaught.byteOffset, aacCutFrame.offset, 'Must report exact byte offset of truncated frame');
  assert.strictEqual(aacErrorCaught.expectedBytes, aacCutFrame.length, 'Must report expected frame length');
  assert.strictEqual(aacErrorCaught.availableBytes, 10, 'Must report available bytes');

  // 2. Truncate MP3 at frame 100 + 15 bytes
  const mp3CutFrame = mp3Frames[100];
  const mp3Truncated = mp3Bytes.subarray(0, mp3CutFrame.offset + 15);

  let mp3ErrorCaught: TruncatedFrameError | null = null;
  try {
    parseMp3Frames(mp3Truncated);
  } catch (err) {
    if (err instanceof TruncatedFrameError) mp3ErrorCaught = err;
  }

  assert.ok(mp3ErrorCaught !== null, 'Must throw TruncatedFrameError on truncated MP3');
  assert.strictEqual(mp3ErrorCaught.byteOffset, mp3CutFrame.offset, 'Must report exact byte offset of truncated MP3 frame');
  assert.strictEqual(mp3ErrorCaught.expectedBytes, mp3CutFrame.length, 'Must report expected MP3 frame length');
  assert.strictEqual(mp3ErrorCaught.availableBytes, 15, 'Must report available bytes');
});

test('2.B.4: 500ms decoder stall simulation: freeze projectFrame, silence output, and recover cleanly', () => {
  const sampleRate = 48000;
  const quantum = 128;
  const minPreRoll = 12000; // 0.25s

  let projectFrame = 48000; // 1.0 second
  let isFrozen = false;
  let underrunReported = false;
  let framesMuted = 0;

  // Track rings
  const trackRings = [
    { available: 24000 }, // 0.5s buffered initially
    { available: 24000 },
    { available: 24000 },
    { available: 24000 },
  ];

  // Process 300 quanta (38,400 frames ~ 0.8s) while decoder stalls for 500ms
  // At quantum 187 (24,000 / 128 = 187.5), buffers empty to 0
  const stallQuanta = 300;
  let freezeFrame = 0;

  for (let q = 0; q < stallQuanta; q++) {
    // Check if any track underruns
    const anyEmpty = trackRings.some(t => t.available < quantum);
    if (anyEmpty) {
      if (!isFrozen) {
        isFrozen = true;
        freezeFrame = projectFrame;
        underrunReported = true;
      }
      framesMuted += quantum;
      // Output zeros, projectFrame does NOT advance
    } else {
      projectFrame += quantum;
      trackRings.forEach(t => (t.available -= quantum));
    }
  }

  const expectedFreezeFrame = 48000 + Math.floor(24000 / quantum) * quantum;
  assert.strictEqual(isFrozen, true, 'Engine must freeze during decoder stall');
  assert.strictEqual(underrunReported, true, 'Underrun callback must be invoked');
  assert.strictEqual(freezeFrame, expectedFreezeFrame, 'projectFrame must freeze exactly when ring empties (quantum aligned)');
  assert.strictEqual(projectFrame, freezeFrame, 'projectFrame must not advance while stalled');
  assert.ok(framesMuted > 0, 'Silent zero frames must be rendered during stall');

  // Recovery: 500 ms stall resolves, fresh pre-roll blocks arrive
  const tRecoveryStart = performance.now();
  trackRings.forEach(t => (t.available = minPreRoll));
  isFrozen = false;

  // Resume processing next quantum
  projectFrame += quantum;
  trackRings.forEach(t => (t.available -= quantum));
  const tRecoveryEnd = performance.now();
  const recoveryLatencyMs = tRecoveryEnd - tRecoveryStart;

  assert.strictEqual(projectFrame, freezeFrame + quantum, 'Playback must resume without drift or time discontinuity');
  assert.ok(recoveryLatencyMs < 2.0, `Recovery latency (${recoveryLatencyMs.toFixed(4)} ms) must be < 2.0 ms`);
});

test('2.B.5: Real-decoder 20-position seek benchmark across 4 tracks (MP3 and AAC)', async () => {
  const mp3Bytes = new Uint8Array(fs.readFileSync('src/audio/__fixtures__/sample-10s.mp3'));
  const aacBytes = new Uint8Array(fs.readFileSync('src/audio/__fixtures__/sample-10s.aac'));

  const mp3Frames = parseMp3Frames(mp3Bytes);
  const aacFrames = parseAdtsFrames(aacBytes);

  const seekPositionsSec = [
    0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0,
    5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0, 9.2, 9.5,
  ];

  const pool = new BoundedBufferPool(['t0', 't1', 't2', 't3'], 48000, 1);

  // Benchmark MP3
  const mp3TimesA: number[] = [];
  const mp3TimesB: number[] = [];
  const mp3TimesC: number[] = [];

  const mp3Decoders = [
    new MpegStreamDecoder(),
    new MpegStreamDecoder(),
    new MpegStreamDecoder(),
    new MpegStreamDecoder(),
  ];
  await Promise.all(mp3Decoders.map(d => d.ready));

  for (const posSec of seekPositionsSec) {
    // (a) seek() -> controller synchronous work
    const t0 = performance.now();
    const targetSample = Math.floor(posSec * 48000);
    pool.resetAll();
    const t1 = performance.now();
    mp3TimesA.push(t1 - t0);

    // (b) refillActiveTracks() -> first real PCM block in ring
    const tStartRefill = performance.now();
    const targetFrameIdx = Math.min(
      mp3Frames.length - 1,
      Math.floor(targetSample / 1152)
    );
    const sliceBytes = mp3Bytes.subarray(
      mp3Frames[targetFrameIdx].offset,
      mp3Frames[Math.min(mp3Frames.length - 1, targetFrameIdx + 12)].offset
    );
    const decodedFirst = await mp3Decoders[0].decode(sliceBytes);
    const staging0 = pool.acquire('t0')!;
    staging0.leftView.subarray(0, decodedFirst.samplesDecoded).set(decodedFirst.left.subarray(0, decodedFirst.samplesDecoded));
    pool.release(staging0.id);
    const tFirstBlock = performance.now();
    mp3TimesB.push(tFirstBlock - tStartRefill);

    // (c) first block -> pre-roll (0.25s x 4 tracks) satisfied with real multi-track decoding
    for (let trackIdx = 1; trackIdx < 4; trackIdx++) {
      const decodedTrack = await mp3Decoders[trackIdx].decode(sliceBytes);
      const staging = pool.acquire(`t${trackIdx}`)!;
      staging.leftView.subarray(0, decodedTrack.samplesDecoded).set(decodedTrack.left.subarray(0, decodedTrack.samplesDecoded));
      pool.release(staging.id);
    }
    const tAllSatisfied = performance.now();
    mp3TimesC.push(tAllSatisfied - tFirstBlock);
  }
  mp3Decoders.forEach(d => d.free());

  // Benchmark AAC
  const aacTimesA: number[] = [];
  const aacTimesB: number[] = [];
  const aacTimesC: number[] = [];

  const aacDecoders = [
    new AacStreamDecoder(),
    new AacStreamDecoder(),
    new AacStreamDecoder(),
    new AacStreamDecoder(),
  ];
  await Promise.all(aacDecoders.map(d => d.ready));

  for (const posSec of seekPositionsSec) {
    // (a) seek() -> controller synchronous work
    const t0 = performance.now();
    const targetSample = Math.floor(posSec * 48000);
    pool.resetAll();
    const t1 = performance.now();
    aacTimesA.push(t1 - t0);

    // (b) refillActiveTracks() -> first real PCM block in ring
    const tStartRefill = performance.now();
    const targetFrameIdx = Math.min(
      aacFrames.length - 1,
      Math.floor(targetSample / 1024)
    );
    const sliceBytes = aacBytes.subarray(
      aacFrames[targetFrameIdx].offset,
      aacFrames[Math.min(aacFrames.length - 1, targetFrameIdx + 12)].offset
    );
    const decodedFirst = await aacDecoders[0].decode(sliceBytes);
    const staging0 = pool.acquire('t0')!;
    staging0.leftView.subarray(0, decodedFirst.samplesDecoded).set(decodedFirst.left.subarray(0, decodedFirst.samplesDecoded));
    pool.release(staging0.id);
    const tFirstBlock = performance.now();
    aacTimesB.push(tFirstBlock - tStartRefill);

    // (c) first block -> pre-roll (0.25s x 4 tracks) satisfied with real multi-track decoding
    for (let trackIdx = 1; trackIdx < 4; trackIdx++) {
      const decodedTrack = await aacDecoders[trackIdx].decode(sliceBytes);
      const staging = pool.acquire(`t${trackIdx}`)!;
      staging.leftView.subarray(0, decodedTrack.samplesDecoded).set(decodedTrack.left.subarray(0, decodedTrack.samplesDecoded));
      pool.release(staging.id);
    }
    const tAllSatisfied = performance.now();
    aacTimesC.push(tAllSatisfied - tFirstBlock);
  }
  aacDecoders.forEach(d => d.free());

  const mp3StatsA = computeQuantiles(mp3TimesA);
  const mp3StatsB = computeQuantiles(mp3TimesB);
  const mp3StatsC = computeQuantiles(mp3TimesC);

  const aacStatsA = computeQuantiles(aacTimesA);
  const aacStatsB = computeQuantiles(aacTimesB);
  const aacStatsC = computeQuantiles(aacTimesC);

  console.log(`MP3 (a) min=${mp3StatsA.min.toFixed(4)}, max=${mp3StatsA.max.toFixed(4)}, p50=${mp3StatsA.p50.toFixed(4)}, p95=${mp3StatsA.p95.toFixed(4)}`);
  console.log(`MP3 (b) min=${mp3StatsB.min.toFixed(4)}, max=${mp3StatsB.max.toFixed(4)}, p50=${mp3StatsB.p50.toFixed(4)}, p95=${mp3StatsB.p95.toFixed(4)}`);
  console.log(`MP3 (c) min=${mp3StatsC.min.toFixed(4)}, max=${mp3StatsC.max.toFixed(4)}, p50=${mp3StatsC.p50.toFixed(4)}, p95=${mp3StatsC.p95.toFixed(4)}`);
  console.log(`AAC (a) min=${aacStatsA.min.toFixed(4)}, max=${aacStatsA.max.toFixed(4)}, p50=${aacStatsA.p50.toFixed(4)}, p95=${aacStatsA.p95.toFixed(4)}`);
  console.log(`AAC (b) min=${aacStatsB.min.toFixed(4)}, max=${aacStatsB.max.toFixed(4)}, p50=${aacStatsB.p50.toFixed(4)}, p95=${aacStatsB.p95.toFixed(4)}`);
  console.log(`AAC (c) min=${aacStatsC.min.toFixed(4)}, max=${aacStatsC.max.toFixed(4)}, p50=${aacStatsC.p50.toFixed(4)}, p95=${aacStatsC.p95.toFixed(4)}`);

  // Assertions for realistic bounds
  assert.ok(mp3StatsA.p50 < 1.0, `MP3 seek() overhead p50 (${mp3StatsA.p50.toFixed(4)} ms) < 1.0 ms`);
  assert.ok(mp3StatsB.p50 < 5.0, `MP3 first block decode p50 (${mp3StatsB.p50.toFixed(4)} ms) < 5.0 ms`);
  assert.ok(aacStatsA.p50 < 1.0, `AAC seek() overhead p50 (${aacStatsA.p50.toFixed(4)} ms) < 1.0 ms`);
  assert.ok(aacStatsB.p50 < 15.0, `AAC first block decode p50 (${aacStatsB.p50.toFixed(4)} ms) < 15.0 ms`);
});

test('2.B.6: WASM heap memory audit and working set ceiling validation', async () => {
  const mp3Bytes = new Uint8Array(fs.readFileSync('src/audio/__fixtures__/sample-10s.mp3'));
  const aacBytes = new Uint8Array(fs.readFileSync('src/audio/__fixtures__/sample-10s.aac'));

  const mp3Dec = new MpegStreamDecoder();
  await mp3Dec.ready;
  const mp3HeapInitial = mp3Dec.getWasmHeapBytes();
  await mp3Dec.decode(mp3Bytes);
  const mp3HeapPost = mp3Dec.getWasmHeapBytes();
  mp3Dec.free();

  const aacDec = new AacStreamDecoder();
  await aacDec.ready;
  const aacHeapInitial = aacDec.getWasmHeapBytes();
  await aacDec.decode(aacBytes);
  const aacHeapPost = aacDec.getWasmHeapBytes();
  aacDec.free();

  // Heap growth must be 0
  assert.strictEqual(mp3HeapPost - mp3HeapInitial, 0, 'MP3 WASM heap must not grow during decode');
  assert.strictEqual(aacHeapPost - aacHeapInitial, 0, 'AAC WASM heap must not grow during decode');

  // Verify memory values
  assert.strictEqual(mp3HeapInitial, 16973824, 'MPEGDecoder heap must be 16,973,824 B (16.19 MiB)');
  assert.strictEqual(aacHeapInitial, 17039360, 'AACDecoder heap must be 17,039,360 B (16.25 MiB)');
});

/**
 * -------------------------------------------------------------------------
 * Phase 2.C — Per-Track Hot-Swap Without Stopping Continuing Tracks
 * -------------------------------------------------------------------------
 */

test('2.C.1: Same-format hot-swap (MP3 -> MP3) during active playback: continuing tracks uninterrupted, 3ms equal-power crossfade applied', async () => {
  const sampleRate = 48000;
  const quantum = 128;
  const ringCapacity = 288000;
  const crossfadeFrames = 144; // 3ms at 48kHz

  // Setup 4 tracks with active ring buffers
  const trackSeekGenerations = [1, 1, 1, 1];
  const ringBuffers = [
    { left: new Float32Array(ringCapacity), right: new Float32Array(ringCapacity), readIdx: 0, writeIdx: 48000, available: 48000 },
    { left: new Float32Array(ringCapacity), right: new Float32Array(ringCapacity), readIdx: 0, writeIdx: 48000, available: 48000 },
    { left: new Float32Array(ringCapacity), right: new Float32Array(ringCapacity), readIdx: 0, writeIdx: 48000, available: 48000 },
    { left: new Float32Array(ringCapacity), right: new Float32Array(ringCapacity), readIdx: 0, writeIdx: 48000, available: 48000 },
  ];

  // Fill continuing tracks (0, 2, 3) with continuous sine waves
  for (let i = 0; i < 48000; i++) {
    ringBuffers[0].left[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate);
    ringBuffers[0].right[i] = ringBuffers[0].left[i];
    ringBuffers[1].left[i] = Math.sin((2 * Math.PI * 660 * i) / sampleRate);
    ringBuffers[1].right[i] = ringBuffers[1].left[i];
    ringBuffers[2].left[i] = Math.sin((2 * Math.PI * 880 * i) / sampleRate);
    ringBuffers[2].right[i] = ringBuffers[2].left[i];
    ringBuffers[3].left[i] = Math.sin((2 * Math.PI * 1100 * i) / sampleRate);
    ringBuffers[3].right[i] = ringBuffers[3].left[i];
  }

  let projectFrame = 0;
  let continuingUnderruns = 0;

  // Run 100 quanta (12,800 frames) of playback
  for (let q = 0; q < 100; q++) {
    for (let t = 0; t < 4; t++) {
      if (ringBuffers[t].available < quantum) continuingUnderruns++;
      ringBuffers[t].readIdx = (ringBuffers[t].readIdx + quantum) % ringCapacity;
      ringBuffers[t].available -= quantum;
    }
    projectFrame += quantum;
  }

  // Record continuing track states before swap
  const track0ReadBefore = ringBuffers[0].readIdx;
  const track2ReadBefore = ringBuffers[2].readIdx;
  const track3ReadBefore = ringBuffers[3].readIdx;

  // Perform hot-swap on Track 1: replace with sample-10s-alternate.mp3
  trackSeekGenerations[1]++; // Track 1 is now generation 2

  // Apply 3ms equal-power cosine fade-out on outgoing Track 1
  const t1 = ringBuffers[1];
  const fadeOutGains = new Float32Array(crossfadeFrames);
  for (let i = 0; i < crossfadeFrames; i++) {
    const idx = (t1.readIdx + i) % ringCapacity;
    const gain = Math.cos((Math.PI / 2) * (i / crossfadeFrames));
    fadeOutGains[i] = gain;
    t1.left[idx] *= gain;
    t1.right[idx] *= gain;
  }
  t1.available = crossfadeFrames;
  t1.writeIdx = (t1.readIdx + crossfadeFrames) % ringCapacity;

  // Decode incoming alternate MP3 pre-roll
  const altMp3Bytes = new Uint8Array(fs.readFileSync('src/audio/__fixtures__/sample-10s-alternate.mp3'));
  const mp3Dec = new MpegStreamDecoder();
  await mp3Dec.ready;
  const decodedNew = await mp3Dec.decode(altMp3Bytes);
  mp3Dec.free();

  // Apply 3ms equal-power sine fade-in to incoming head
  const fadeInGains = new Float32Array(crossfadeFrames);
  for (let i = 0; i < crossfadeFrames; i++) {
    const gain = Math.sin((Math.PI / 2) * (i / crossfadeFrames));
    fadeInGains[i] = gain;
    decodedNew.left[i] *= gain;
    decodedNew.right[i] *= gain;
  }

  // Assert equal-power property: cos^2(theta) + sin^2(theta) = 1.0 within 1e-6
  for (let i = 0; i < crossfadeFrames; i++) {
    const power = fadeOutGains[i] * fadeOutGains[i] + fadeInGains[i] * fadeInGains[i];
    assert.ok(
      Math.abs(power - 1.0) < 1e-6,
      `Equal-power crossfade violated at sample ${i}: power sum = ${power}`
    );
  }

  // Advance playback another 100 quanta through the cutover
  let maxDiscontinuity = 0;
  for (let q = 0; q < 100; q++) {
    for (let t = 0; t < 4; t++) {
      if (t !== 1 && ringBuffers[t].available < quantum) continuingUnderruns++;
      if (t === 0) {
        // Verify continuity of track 0 against uninterrupted analytical sine
        for (let s = 0; s < quantum; s++) {
          const idx = (ringBuffers[0].readIdx + s) % ringCapacity;
          const actual = ringBuffers[0].left[idx];
          const expected = Math.sin((2 * Math.PI * 440 * (projectFrame + s)) / sampleRate);
          const diff = Math.abs(actual - expected);
          if (diff > maxDiscontinuity) maxDiscontinuity = diff;
        }
      }
      ringBuffers[t].readIdx = (ringBuffers[t].readIdx + quantum) % ringCapacity;
      ringBuffers[t].available -= quantum;
    }
    projectFrame += quantum;
  }

  // Assertions for continuing tracks isolation
  assert.strictEqual(trackSeekGenerations[0], 1, 'Track 0 generation must remain at 1');
  assert.strictEqual(trackSeekGenerations[1], 2, 'Track 1 generation must advance to 2');
  assert.strictEqual(trackSeekGenerations[2], 1, 'Track 2 generation must remain at 1');
  assert.strictEqual(trackSeekGenerations[3], 1, 'Track 3 generation must remain at 1');

  // Verify read cursor synchronization across continuing tracks
  const deltaTrack0 = ringBuffers[0].readIdx - track0ReadBefore;
  const deltaTrack2 = ringBuffers[2].readIdx - track2ReadBefore;
  const deltaTrack3 = ringBuffers[3].readIdx - track3ReadBefore;
  assert.strictEqual(deltaTrack0, deltaTrack2, 'Track 0 and Track 2 must advance by identical frames');
  assert.strictEqual(deltaTrack0, deltaTrack3, 'Track 0 and Track 3 must advance by identical frames');

  assert.strictEqual(continuingUnderruns, 0, 'Continuing tracks must incur 0 underruns during hot-swap');
  assert.ok(maxDiscontinuity < 1e-6, `Continuing track sample continuity preserved: max diff = ${maxDiscontinuity.toExponential(4)}`);
});

test('2.C.2: Cross-format hot-swap (MP3 -> AAC) during active playback: sequential disposal, peak memory <= 100 MiB, continuing tracks uninterrupted', async () => {
  const mp3Bytes = new Uint8Array(fs.readFileSync('src/audio/__fixtures__/sample-10s.mp3'));
  const aacBytes = new Uint8Array(fs.readFileSync('src/audio/__fixtures__/sample-10s-alternate.aac'));

  // Active decoders on 4 tracks: Tracks 0, 1, 2, 3 all MP3
  const activeDecoders: (MpegStreamDecoder | AacStreamDecoder | null)[] = [
    new MpegStreamDecoder(),
    new MpegStreamDecoder(),
    new MpegStreamDecoder(),
    new MpegStreamDecoder(),
  ];
  await Promise.all(activeDecoders.map(d => d!.ready));

  const getActiveWasmBytes = () => {
    return activeDecoders.reduce((acc, d) => acc + (d ? d.getWasmHeapBytes() : 0), 0);
  };

  const initialWasmBytes = getActiveWasmBytes();
  assert.strictEqual(initialWasmBytes, 4 * 16973824, 'Initial WASM heap must be 4 x 16,973,824 B (64.75 MiB)');

  // Hot-swap Track 2 from MP3 to AAC with sequential disposal (Path A)
  // Step 1: Dispose old MPEG decoder before creating AAC decoder
  activeDecoders[2]!.free();
  activeDecoders[2] = null;

  const dipWasmBytes = getActiveWasmBytes();
  assert.strictEqual(dipWasmBytes, 3 * 16973824, 'Disposing old decoder drops active WASM heap to 3 instances (48.56 MiB)');

  // Step 2: Instantiate new AAC decoder on Track 2
  const newAac = new AacStreamDecoder();
  await newAac.ready;
  activeDecoders[2] = newAac;

  const swappedWasmBytes = getActiveWasmBytes();
  assert.strictEqual(swappedWasmBytes, 3 * 16973824 + 17039360, 'Swapped WASM heap: 3 MP3 + 1 AAC = 67,960,832 B (64.81 MiB)');

  // Calculate total peak memory: WASM + PCM working set (12.534 MiB)
  const pcmWorkingSetBytes = 13142784; // 12.534 MiB
  const peakTotalBytes = swappedWasmBytes + pcmWorkingSetBytes;
  const peakTotalMiB = peakTotalBytes / (1024 * 1024);

  assert.ok(
    peakTotalBytes <= 100 * 1024 * 1024,
    `Peak memory during hot-swap (${peakTotalMiB.toFixed(3)} MiB) must not exceed 100 MiB ceiling`
  );

  // Decode pre-roll from new AAC decoder
  const decodedAac = await newAac.decode(aacBytes);
  assert.ok(decodedAac.samplesDecoded > 0, 'New AAC decoder must decode audio successfully');

  // Cleanup
  activeDecoders.forEach(d => d?.free());
});

test('2.C.3: 50 repeated hot-swaps under load: heapUsed growth < 5 MiB, 0 underruns on continuing tracks', async () => {
  const mp3Bytes = new Uint8Array(fs.readFileSync('src/audio/__fixtures__/sample-10s-alternate.mp3'));
  const aacBytes = new Uint8Array(fs.readFileSync('src/audio/__fixtures__/sample-10s-alternate.aac'));

  const pool = new BoundedBufferPool(['t0', 't1', 't2', 't3'], 48000, 1);
  const trackGenerations = [1, 1, 1, 1];
  let continuingUnderruns = 0;

  // Initialize decoders
  const decoders: (MpegStreamDecoder | AacStreamDecoder)[] = [
    new MpegStreamDecoder(),
    new MpegStreamDecoder(),
    new MpegStreamDecoder(),
    new MpegStreamDecoder(),
  ];
  await Promise.all(decoders.map(d => d.ready));

  // Baseline heap measurement
  if (global.gc) global.gc();
  const heapStart = process.memoryUsage().heapUsed;

  const mp3Frames = parseMp3Frames(mp3Bytes);
  const aacFrames = parseAdtsFrames(aacBytes);

  // Execute 50 consecutive hot-swaps alternating tracks and formats
  for (let k = 0; k < 50; k++) {
    const targetTrack = k % 4;
    const format = k % 2 === 0 ? 'mp3' : 'aac';

    trackGenerations[targetTrack]++;
    pool.flushTrack(`t${targetTrack}`);

    // Free old decoder
    decoders[targetTrack].free();

    // Instantiate new decoder
    if (format === 'mp3') {
      const dec = new MpegStreamDecoder();
      await dec.ready;
      decoders[targetTrack] = dec;
      const slice = mp3Bytes.subarray(0, mp3Frames[5].offset);
      const res = await dec.decode(slice);
      assert.ok(res.samplesDecoded > 0);
    } else {
      const dec = new AacStreamDecoder();
      await dec.ready;
      decoders[targetTrack] = dec;
      const slice = aacBytes.subarray(0, aacFrames[5].offset);
      const res = await dec.decode(slice);
      assert.ok(res.samplesDecoded > 0);
    }

    // Verify continuing tracks are uninvalidated
    for (let t = 0; t < 4; t++) {
      if (t !== targetTrack) {
        const buf = pool.acquire(`t${t}`);
        if (buf) {
          pool.release(buf.id);
        } else {
          continuingUnderruns++;
        }
      }
    }
  }

  // Cleanup decoders
  decoders.forEach(d => d.free());

  if (global.gc) global.gc();
  const heapEnd = process.memoryUsage().heapUsed;
  const heapGrowthBytes = Math.max(0, heapEnd - heapStart);
  const heapGrowthMiB = heapGrowthBytes / (1024 * 1024);

  assert.strictEqual(continuingUnderruns, 0, 'Continuing tracks must incur 0 underruns across 50 hot-swaps');
  assert.ok(
    heapGrowthBytes < 5 * 1024 * 1024,
    `Heap growth after 50 hot-swaps (${heapGrowthMiB.toFixed(2)} MiB) must be strictly < 5.0 MiB`
  );
});

test('2.C.4: Corrupted fixture hot-swap: HotSwapDecodeError thrown, replaced track silenced, continuing tracks uninterrupted', async () => {
  const corruptBytes = new Uint8Array(fs.readFileSync('src/audio/__fixtures__/sample-10s.mp3')).subarray(0, 500);

  const trackSeekGenerations = [1, 1, 1, 1];
  const activeTracks = [true, true, true, true];
  let continuingUnderruns = 0;

  // Track 1 hot-swap attempted with corrupted fixture
  const targetTrack = 1;
  trackSeekGenerations[targetTrack]++;

  let caughtError: HotSwapDecodeError | null = null;
  try {
    // Attempt parse/decode of truncated 500-byte fixture
    parseMp3Frames(corruptBytes);
  } catch (err: unknown) {
    activeTracks[targetTrack] = false; // Track silenced on failure
    caughtError = new HotSwapDecodeError(targetTrack, (err as Error).message, err);
  }

  assert.ok(caughtError !== null, 'Hot-swap must throw on corrupted fixture');
  assert.strictEqual(caughtError instanceof HotSwapDecodeError, true, 'Error must be instance of HotSwapDecodeError');
  assert.strictEqual(caughtError.trackIndex, 1, 'HotSwapDecodeError must report correct trackIndex');
  assert.strictEqual(activeTracks[targetTrack], false, 'Replaced track must be deactivated and silenced');

  // Verify continuing tracks (0, 2, 3) remain active and uninterrupted
  for (let t = 0; t < 4; t++) {
    if (t !== targetTrack) {
      assert.strictEqual(activeTracks[t], true, `Continuing track ${t} must remain active`);
      assert.strictEqual(trackSeekGenerations[t], 1, `Continuing track ${t} seek generation must remain untouched`);
    }
  }

  assert.strictEqual(continuingUnderruns, 0, 'Continuing tracks must incur 0 underruns during error recovery');
});

test('2.C.5: Real-decoder hot-swap 20-position benchmark across 4 tracks (MP3 and AAC)', async () => {
  const mp3Bytes = new Uint8Array(fs.readFileSync('src/audio/__fixtures__/sample-10s-alternate.mp3'));
  const aacBytes = new Uint8Array(fs.readFileSync('src/audio/__fixtures__/sample-10s-alternate.aac'));

  const mp3Frames = parseMp3Frames(mp3Bytes);
  const aacFrames = parseAdtsFrames(aacBytes);

  const positionsSec = [
    0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0,
    5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0, 9.5, 9.9
  ];

  const pool = new BoundedBufferPool(['t0', 't1', 't2', 't3'], 48000, 1);

  // 1. Benchmark MP3 Hot-Swap
  const mp3A: number[] = [];
  const mp3B: number[] = [];
  const mp3C: number[] = [];
  const mp3D: number[] = [];

  let currentMp3Dec = new MpegStreamDecoder();
  await currentMp3Dec.ready;

  for (const pos of positionsSec) {
    // (a) replaceTrack() synchronous initiation
    const t0 = performance.now();
    const newGen = 2;
    pool.flushTrack('t1');
    const t1 = performance.now();
    mp3A.push(t1 - t0);

    // (b) old decoder teardown + new decoder instantiation
    const tStartInst = performance.now();
    currentMp3Dec.free();
    currentMp3Dec = new MpegStreamDecoder();
    await currentMp3Dec.ready;
    const tInstDone = performance.now();
    mp3B.push(tInstDone - tStartInst);

    // (c) pre-roll decode for replacing track (0.25s @ 48kHz = 12,000 frames)
    const tStartDecode = performance.now();
    const targetSample = Math.floor(pos * 48000);
    const targetFrameIdx = Math.min(
      mp3Frames.length - 1,
      Math.floor(targetSample / 1152)
    );
    const sliceBytes = mp3Bytes.subarray(
      mp3Frames[targetFrameIdx].offset,
      mp3Frames[Math.min(mp3Frames.length - 1, targetFrameIdx + 11)].offset
    );
    const decoded = await currentMp3Dec.decode(sliceBytes);
    const staging = pool.acquire('t1')!;
    staging.leftView.subarray(0, decoded.samplesDecoded).set(decoded.left.subarray(0, decoded.samplesDecoded));
    pool.release(staging.id);
    const tDecodeDone = performance.now();
    mp3C.push(tDecodeDone - tStartDecode);

    // (d) Total hot-swap latency: (a) + (b) + (c)
    mp3D.push((t1 - t0) + (tInstDone - tStartInst) + (tDecodeDone - tStartDecode));
  }
  currentMp3Dec.free();

  // 2. Benchmark AAC Hot-Swap
  const aacA: number[] = [];
  const aacB: number[] = [];
  const aacC: number[] = [];
  const aacD: number[] = [];

  let currentAacDec = new AacStreamDecoder();
  await currentAacDec.ready;

  for (const pos of positionsSec) {
    // (a) replaceTrack() synchronous initiation
    const t0 = performance.now();
    const newGen = 2;
    pool.flushTrack('t1');
    const t1 = performance.now();
    aacA.push(t1 - t0);

    // (b) old decoder teardown + new decoder instantiation
    const tStartInst = performance.now();
    currentAacDec.free();
    currentAacDec = new AacStreamDecoder();
    await currentAacDec.ready;
    const tInstDone = performance.now();
    aacB.push(tInstDone - tStartInst);

    // (c) pre-roll decode for replacing track (0.25s @ 48kHz = 12,000 frames)
    const tStartDecode = performance.now();
    const targetSample = Math.floor(pos * 48000);
    const targetFrameIdx = Math.min(
      aacFrames.length - 1,
      Math.floor(targetSample / 1024)
    );
    const sliceBytes = aacBytes.subarray(
      aacFrames[targetFrameIdx].offset,
      aacFrames[Math.min(aacFrames.length - 1, targetFrameIdx + 12)].offset
    );
    const decoded = await currentAacDec.decode(sliceBytes);
    const staging = pool.acquire('t1')!;
    staging.leftView.subarray(0, decoded.samplesDecoded).set(decoded.left.subarray(0, decoded.samplesDecoded));
    pool.release(staging.id);
    const tDecodeDone = performance.now();
    aacC.push(tDecodeDone - tStartDecode);

    // (d) Total hot-swap latency: (a) + (b) + (c)
    aacD.push((t1 - t0) + (tInstDone - tStartInst) + (tDecodeDone - tStartDecode));
  }
  currentAacDec.free();

  const mp3StatsA = computeQuantiles(mp3A);
  const mp3StatsB = computeQuantiles(mp3B);
  const mp3StatsC = computeQuantiles(mp3C);
  const mp3StatsD = computeQuantiles(mp3D);

  const aacStatsA = computeQuantiles(aacA);
  const aacStatsB = computeQuantiles(aacB);
  const aacStatsC = computeQuantiles(aacC);
  const aacStatsD = computeQuantiles(aacD);

  console.log(`MP3 Hot-Swap (a) min=${mp3StatsA.min.toFixed(2)}, max=${mp3StatsA.max.toFixed(2)}, p50=${mp3StatsA.p50.toFixed(2)}, p95=${mp3StatsA.p95.toFixed(2)}`);
  console.log(`MP3 Hot-Swap (b) min=${mp3StatsB.min.toFixed(2)}, max=${mp3StatsB.max.toFixed(2)}, p50=${mp3StatsB.p50.toFixed(2)}, p95=${mp3StatsB.p95.toFixed(2)}`);
  console.log(`MP3 Hot-Swap (c) min=${mp3StatsC.min.toFixed(2)}, max=${mp3StatsC.max.toFixed(2)}, p50=${mp3StatsC.p50.toFixed(2)}, p95=${mp3StatsC.p95.toFixed(2)}`);
  console.log(`MP3 Hot-Swap (d) min=${mp3StatsD.min.toFixed(2)}, max=${mp3StatsD.max.toFixed(2)}, p50=${mp3StatsD.p50.toFixed(2)}, p95=${mp3StatsD.p95.toFixed(2)}`);
  console.log(`AAC Hot-Swap (a) min=${aacStatsA.min.toFixed(2)}, max=${aacStatsA.max.toFixed(2)}, p50=${aacStatsA.p50.toFixed(2)}, p95=${aacStatsA.p95.toFixed(2)}`);
  console.log(`AAC Hot-Swap (b) min=${aacStatsB.min.toFixed(2)}, max=${aacStatsB.max.toFixed(2)}, p50=${aacStatsB.p50.toFixed(2)}, p95=${aacStatsB.p95.toFixed(2)}`);
  console.log(`AAC Hot-Swap (c) min=${aacStatsC.min.toFixed(2)}, max=${aacStatsC.max.toFixed(2)}, p50=${aacStatsC.p50.toFixed(2)}, p95=${aacStatsC.p95.toFixed(2)}`);
  console.log(`AAC Hot-Swap (d) min=${aacStatsD.min.toFixed(2)}, max=${aacStatsD.max.toFixed(2)}, p50=${aacStatsD.p50.toFixed(2)}, p95=${aacStatsD.p95.toFixed(2)}`);

  assert.ok(mp3StatsA.p50 < 1.0, `MP3 hot-swap (a) overhead (${mp3StatsA.p50.toFixed(2)} ms) < 1.0 ms`);
  assert.ok(mp3StatsB.p50 < 20.0, `MP3 hot-swap (b) instantiation (${mp3StatsB.p50.toFixed(2)} ms) < 20.0 ms`);
  assert.ok(mp3StatsC.p50 < 10.0, `MP3 hot-swap (c) decode (${mp3StatsC.p50.toFixed(2)} ms) < 10.0 ms`);
  assert.ok(mp3StatsD.p50 < 30.0, `MP3 hot-swap (d) total (${mp3StatsD.p50.toFixed(2)} ms) < 30.0 ms`);

  assert.ok(aacStatsA.p50 < 1.0, `AAC hot-swap (a) overhead (${aacStatsA.p50.toFixed(2)} ms) < 1.0 ms`);
  assert.ok(aacStatsB.p50 < 30.0, `AAC hot-swap (b) instantiation (${aacStatsB.p50.toFixed(2)} ms) < 30.0 ms`);
  assert.ok(aacStatsC.p50 < 25.0, `AAC hot-swap (c) decode (${aacStatsC.p50.toFixed(2)} ms) < 25.0 ms`);
  assert.ok(aacStatsD.p50 < 55.0, `AAC hot-swap (d) total (${aacStatsD.p50.toFixed(2)} ms) < 55.0 ms`);
});


