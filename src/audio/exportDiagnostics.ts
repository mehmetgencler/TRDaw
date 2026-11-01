/**
 * Diagnostic Suite for 24-bit Mixdown Export Pipeline
 * Measures:
 * 1. Controlled Render 1: One track, all effects bypassed
 * 2. Controlled Render 2: Four tracks, all effects bypassed, master gain -12 dB
 * 3. Controlled Render 3: Four tracks using existing DSP and mastering chain
 *
 * Computes:
 * - Peak, Oversampled True Peak (4x), RMS, DC offset
 * - Out-of-range (>1.0) and saturated samples
 * - NaN / Infinity counts
 * - Dynamics / Limiter activity
 * - THD (Total Harmonic Distortion) for pure tones
 * - Pre-encoding Float32 vs Decoded 24-bit WAV error
 */

import { renderMixdownWav, encodeWavBuffer } from './wavEncoder';
import { parseWavHeader } from './wavParser';
import type { TrackData, MasterState, ExportSettings } from '../types/audio';
import { createEmptyTracks } from './demoStems';
import { dbToGain } from './math';

export interface SignalMetrics {
  maxPeak: number;
  maxPeakDb: number;
  truePeak: number;
  truePeakDb: number;
  rms: number;
  rmsDb: number;
  dcOffset: number;
  samplesExceedingUnity: number;
  clippedOrSaturatedSamples: number;
  nanCount: number;
  infCount: number;
  thdPercent?: number; // Total harmonic distortion for sinusoidal input
  maxErrorVsDecoded24?: number;
}

/**
 * 4x Oversampled True Peak calculation via sinc/polyphase interpolation
 */
export function calculateTruePeak(samples: Float32Array): number {
  let maxTp = 0;
  const len = samples.length;
  // 4x oversampling with 16-tap windowed sinc kernel
  const TAPS = 16;
  const halfTaps = TAPS / 2;

  for (let i = halfTaps; i < len - halfTaps; i += 4) {
    for (let sub = 0; sub < 4; sub++) {
      if (sub === 0) {
        const val = Math.abs(samples[i]);
        if (val > maxTp) maxTp = val;
      } else {
        const frac = sub / 4;
        let interp = 0;
        for (let t = -halfTaps; t < halfTaps; t++) {
          const s = samples[i + t];
          const x = (t - frac) * Math.PI;
          const sinc = x === 0 ? 1 : Math.sin(x) / x;
          // Hann window
          const w = 0.5 * (1 + Math.cos((2 * Math.PI * (t + halfTaps)) / TAPS));
          interp += s * sinc * w;
        }
        const val = Math.abs(interp);
        if (val > maxTp) maxTp = val;
      }
    }
  }
  return maxTp;
}

/**
 * Computes metrics on a stereo Float32 interleaved or separate channel array
 */
export function analyzeSignal(
  samplesL: Float32Array,
  samplesR: Float32Array,
  fundamentalFreq?: number,
  sampleRate = 48000
): SignalMetrics {
  const len = Math.min(samplesL.length, samplesR.length);
  let maxPeak = 0;
  let sumSq = 0;
  let sumL = 0;
  let sumR = 0;
  let samplesExceedingUnity = 0;
  let clippedOrSaturated = 0;
  let nanCount = 0;
  let infCount = 0;

  for (let i = 0; i < len; i++) {
    const sL = samplesL[i];
    const sR = samplesR[i];

    if (Number.isNaN(sL) || Number.isNaN(sR)) {
      nanCount++;
      continue;
    }
    if (!Number.isFinite(sL) || !Number.isFinite(sR)) {
      infCount++;
      continue;
    }

    const absL = Math.abs(sL);
    const absR = Math.abs(sR);
    if (absL > maxPeak) maxPeak = absL;
    if (absR > maxPeak) maxPeak = absR;

    if (absL > 1.0 || absR > 1.0) {
      samplesExceedingUnity++;
    }
    // Samples at or above 0.99999 or flat-topped
    if (absL >= 0.99999 || absR >= 0.99999) {
      clippedOrSaturated++;
    }

    sumSq += sL * sL + sR * sR;
    sumL += sL;
    sumR += sR;
  }

  const rms = Math.sqrt(sumSq / (len * 2));
  const dcOffset = (sumL + sumR) / (len * 2);
  const truePeakL = calculateTruePeak(samplesL);
  const truePeakR = calculateTruePeak(samplesR);
  const truePeak = Math.max(truePeakL, truePeakR);

  let thdPercent: number | undefined;
  if (fundamentalFreq && fundamentalFreq > 0 && len >= sampleRate) {
    // Perform discrete Fourier analysis on fundamental and harmonics (up to 10th harmonic)
    const N = Math.min(len, sampleRate * 2); // 2-second analysis window
    let fundRe = 0;
    let fundIm = 0;
    const omega = (2 * Math.PI * fundamentalFreq) / sampleRate;

    for (let n = 0; n < N; n++) {
      fundRe += samplesL[n] * Math.cos(omega * n);
      fundIm += samplesL[n] * Math.sin(omega * n);
    }
    const fundMag = Math.sqrt(fundRe * fundRe + fundIm * fundIm);

    let harmMagSq = 0;
    for (let h = 2; h <= 10; h++) {
      const harmFreq = fundamentalFreq * h;
      if (harmFreq >= sampleRate / 2) break;
      let hRe = 0;
      let hIm = 0;
      const hOmega = (2 * Math.PI * harmFreq) / sampleRate;
      for (let n = 0; n < N; n++) {
        hRe += samplesL[n] * Math.cos(hOmega * n);
        hIm += samplesL[n] * Math.sin(hOmega * n);
      }
      harmMagSq += hRe * hRe + hIm * hIm;
    }

    if (fundMag > 1e-6) {
      const harmMag = Math.sqrt(harmMagSq);
      thdPercent = (harmMag / fundMag) * 100;
    }
  }

  const toDb = (val: number) => (val > 1e-7 ? 20 * Math.log10(val) : -140);

  return {
    maxPeak,
    maxPeakDb: toDb(maxPeak),
    truePeak,
    truePeakDb: toDb(truePeak),
    rms,
    rmsDb: toDb(rms),
    dcOffset,
    samplesExceedingUnity,
    clippedOrSaturatedSamples: clippedOrSaturated,
    nanCount,
    infCount,
    thdPercent,
  };
}

/**
 * Decodes 24-bit PCM WAV Blob into stereo Float32Array channels
 */
export async function decode24BitWavBlob(blob: Blob): Promise<{ left: Float32Array; right: Float32Array; sampleRate: number }> {
  const buf = await blob.arrayBuffer();
  const header = parseWavHeader(buf);
  const dataOffset = header.dataChunkOffset;
  const numFrames = header.totalSampleFrames;
  const left = new Float32Array(numFrames);
  const right = new Float32Array(numFrames);
  const view = new DataView(buf);

  let byteOffset = dataOffset;
  for (let i = 0; i < numFrames; i++) {
    // Left channel (3 bytes)
    const b0 = view.getUint8(byteOffset);
    const b1 = view.getUint8(byteOffset + 1);
    const b2 = view.getUint8(byteOffset + 2);
    let intL = (b2 << 16) | (b1 << 8) | b0;
    if (intL & 0x800000) intL |= ~0xffffff;
    left[i] = intL / 8388608;
    byteOffset += 3;

    // Right channel (3 bytes)
    if (header.channels > 1) {
      const rb0 = view.getUint8(byteOffset);
      const rb1 = view.getUint8(byteOffset + 1);
      const rb2 = view.getUint8(byteOffset + 2);
      let intR = (rb2 << 16) | (rb1 << 8) | rb0;
      if (intR & 0x800000) intR |= ~0xffffff;
      right[i] = intR / 8388608;
      byteOffset += 3;
    } else {
      right[i] = left[i];
    }
  }

  return { left, right, sampleRate: header.sampleRate };
}

/**
 * Creates a synthetic WAV Blob containing a pure sine tone
 */
export function createSyntheticSineWav(options: {
  frequency: number;
  durationSec: number;
  sampleRate: number;
  amplitude: number;
  bitDepth: 16 | 24 | 32;
}): { blob: Blob; header: any; leftRaw: Float32Array; rightRaw: Float32Array } {
  const { frequency, durationSec, sampleRate, amplitude, bitDepth } = options;
  const numFrames = Math.floor(durationSec * sampleRate);
  const left = new Float32Array(numFrames);
  const right = new Float32Array(numFrames);

  for (let i = 0; i < numFrames; i++) {
    const val = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude;
    left[i] = val;
    right[i] = val;
  }

  const encoded = encodeWavBuffer(left, right, sampleRate, bitDepth);
  const blob = new Blob([encoded], { type: 'audio/wav' });
  const header = parseWavHeader(encoded);

  return { blob, header, leftRaw: left, rightRaw: right };
}
