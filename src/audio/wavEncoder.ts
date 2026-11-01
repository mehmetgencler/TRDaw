/**
 * Canonical RIFF WAV Audio Encoder (16-bit, 24-bit PCM & 32-bit Float)
 * Supports memory-conscious progressive encoding and export mixdown.
 * Features stateful mastering DSP: Biquad EQ, Dynamics Compressor,
 * Brickwall Limiter, Sinc Polyphase Resampler, and TPDF Dither.
 */

import { calculatePanGains, calculateStereoPanGains, dbToGain, clamp } from './math';
import type { TrackData, MasterState, ExportSettings } from '../types/audio';
import {
  createBiquadFilter,
  processBiquadFilter,
  createCompressor,
  processCompressor,
  createMasterLimiter,
  processMasterLimiter,
} from './dsp';
import {
  createResamplerState,
  resamplePcmBlock,
  type ResamplerState,
} from './resampler';

export interface EncodeWavOptions {
  sampleRate: number;
  channels: 1 | 2;
  bitDepth: 16 | 24 | 32;
  floatData?: boolean;
}

/**
 * Encodes audio channels into an ArrayBuffer containing a standard RIFF/WAVE file
 */
export function encodeWavBuffer(
  leftChannel: Float32Array,
  rightChannel: Float32Array,
  sampleRate = 44100,
  bitDepth: 16 | 24 | 32 = 16
): ArrayBuffer {
  const numFrames = leftChannel.length;
  const numChannels = 2;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  // Helper to write ASCII strings
  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  // 'RIFF'
  writeString(0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  // 'WAVE'
  writeString(8, 'WAVE');

  // 'fmt ' chunk
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  const audioFormat = bitDepth === 32 ? 3 : 1; // 1 = PCM, 3 = IEEE Float
  view.setUint16(20, audioFormat, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  // 'data' chunk
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;

  if (bitDepth === 16) {
    for (let i = 0; i < numFrames; i++) {
      // Left channel sample with TPDF dither
      const ditherL = (Math.random() - Math.random()) / 32768;
      const sL = clamp(leftChannel[i] + ditherL, -1.0, 1.0);
      let intL = Math.round(sL < 0 ? sL * 32768 : sL * 32767);
      intL = Math.max(-32768, Math.min(32767, intL));
      view.setInt16(offset, intL, true);
      offset += 2;

      // Right channel sample with TPDF dither
      const ditherR = (Math.random() - Math.random()) / 32768;
      const sR = clamp(rightChannel[i] + ditherR, -1.0, 1.0);
      let intR = Math.round(sR < 0 ? sR * 32768 : sR * 32767);
      intR = Math.max(-32768, Math.min(32767, intR));
      view.setInt16(offset, intR, true);
      offset += 2;
    }
  } else if (bitDepth === 24) {
    for (let i = 0; i < numFrames; i++) {
      // Left channel sample with 24-bit TPDF dither
      const ditherL = (Math.random() - Math.random()) / 8388608;
      const sL = clamp(leftChannel[i] + ditherL, -1.0, 1.0);
      let intL = Math.round(sL < 0 ? sL * 8388608 : Math.min(8388607, sL * 8388608));
      intL = Math.max(-8388608, Math.min(8388607, intL));
      view.setUint8(offset, intL & 0xff);
      view.setUint8(offset + 1, (intL >> 8) & 0xff);
      view.setUint8(offset + 2, (intL >> 16) & 0xff);
      offset += 3;

      // Right channel sample with 24-bit TPDF dither
      const ditherR = (Math.random() - Math.random()) / 8388608;
      const sR = clamp(rightChannel[i] + ditherR, -1.0, 1.0);
      let intR = Math.round(sR < 0 ? sR * 8388608 : Math.min(8388607, sR * 8388608));
      intR = Math.max(-8388608, Math.min(8388607, intR));
      view.setUint8(offset, intR & 0xff);
      view.setUint8(offset + 1, (intR >> 8) & 0xff);
      view.setUint8(offset + 2, (intR >> 16) & 0xff);
      offset += 3;
    }
  } else if (bitDepth === 32) {
    for (let i = 0; i < numFrames; i++) {
      view.setFloat32(offset, leftChannel[i], true);
      offset += 4;
      view.setFloat32(offset, rightChannel[i], true);
      offset += 4;
    }
  }

  return buffer;
}

interface TrackDspState {
  eqLow: ReturnType<typeof createBiquadFilter>;
  eqMid: ReturnType<typeof createBiquadFilter>;
  eqHigh: ReturnType<typeof createBiquadFilter>;
  compressor: ReturnType<typeof createCompressor> | null;
  resampler: ResamplerState | null;
  currentSourceFrame: number;
}

/**
 * Mixes down active tracks into a single WAV Blob using calibrated DSP math.
 * Applies individual track gain, pan, 3-band Biquad EQ, dynamics compressor,
 * master Biquad EQ, brickwall limiter, and volume.
 * Uses bounded 5-second chunk windows with continuous DSP state to prevent
 * memory exhaustion on mobile Safari while guaranteeing pristine audio quality.
 */
export async function renderMixdownWav(
  tracks: TrackData[],
  master: MasterState,
  settings: ExportSettings,
  onProgress?: (percent: number) => void
): Promise<Blob> {
  // Determine mixdown length across active tracks
  let maxDuration = 0;
  for (const track of tracks) {
    const dur = track.fileInfo?.durationSec || (track.audioBuffer ? track.audioBuffer.duration : 0);
    if (dur > maxDuration) {
      maxDuration = dur;
    }
  }

  if (maxDuration === 0) {
    maxDuration = 10; // Default 10 seconds if empty
  }

  // Handle range settings
  let exportStart = 0;
  let exportDuration = maxDuration;

  if (settings.range === 'preview-5m') {
    exportDuration = Math.min(300, maxDuration);
  } else if (settings.range === 'loop' && settings.customStart !== undefined && settings.customEnd !== undefined) {
    exportStart = Math.max(0, settings.customStart);
    exportDuration = Math.max(0.5, settings.customEnd - exportStart);
  }

  // Explicit safety limit for Phase 1 / Phase 1.5 in-memory export
  if (exportDuration > 300) {
    throw new Error(
      `Mixdown export duration (${Math.round(exportDuration)}s) exceeds the 5-minute limit (300 seconds). Full-length 60-minute export requires streaming/server-side export pipeline.`
    );
  }

  const sampleRate = settings.sampleRate;
  const numFrames = Math.max(1, Math.floor(exportDuration * sampleRate));
  const bitDepth = settings.format === 'wav-32f' ? 32 : settings.format === 'wav-24' ? 24 : 16;
  const numChannels = 2;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  // Pre-allocate the single target ArrayBuffer (no intermediate duplicate full arrays)
  const outputBuffer = new ArrayBuffer(totalSize);
  const outView = new DataView(outputBuffer);

  // Helper to write ASCII strings
  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      outView.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  // 1. RIFF Header
  writeString(0, 'RIFF');
  outView.setUint32(4, totalSize - 8, true);
  writeString(8, 'WAVE');

  // 2. fmt chunk
  writeString(12, 'fmt ');
  outView.setUint32(16, 16, true);
  const audioFormat = bitDepth === 32 ? 3 : 1;
  outView.setUint16(20, audioFormat, true);
  outView.setUint16(22, numChannels, true);
  outView.setUint32(24, sampleRate, true);
  outView.setUint32(28, byteRate, true);
  outView.setUint16(32, blockAlign, true);
  outView.setUint16(34, bitDepth, true);

  // 3. data chunk
  writeString(36, 'data');
  outView.setUint32(40, dataSize, true);

  // Check solo status
  const anySolo = tracks.some(t => t.solo);
  const activeTracks = tracks.filter(t => {
    if (!t.audioBuffer && !t.sourceBlob) return false;
    if (t.mute) return false;
    if (anySolo && !t.solo) return false;
    return true;
  });

  const masterGain = dbToGain(master.volume);

  // Instantiate persistent Master DSP chain (persists across all chunk boundaries)
  const masterEqLow = createBiquadFilter('lowshelf', 100, master.eq?.lowGain ?? 0, 0.707, sampleRate);
  const masterEqMid = createBiquadFilter('peaking', 1000, master.eq?.midGain ?? 0, 0.7, sampleRate);
  const masterEqHigh = createBiquadFilter('highshelf', 8000, master.eq?.highGain ?? 0, 0.707, sampleRate);
  const shouldApplyLimiter = !settings.bypassLimiter && Boolean(master.limiterEnabled);
  const masterLimiter = shouldApplyLimiter
    ? createMasterLimiter(master.limiterThreshold ?? -0.5, sampleRate)
    : null;

  // Instantiate persistent Track DSP chains
  const trackDspMap = new Map<string, TrackDspState>();
  for (const track of activeTracks) {
    const trkRate = track.fileInfo?.sampleRate || (track.audioBuffer ? track.audioBuffer.sampleRate : sampleRate);
    const resampler = trkRate !== sampleRate ? createResamplerState(trkRate, sampleRate) : null;

    const eqLow = createBiquadFilter('lowshelf', 100, track.eq?.lowGain ?? 0, 0.707, sampleRate);
    const eqMid = createBiquadFilter('peaking', track.eq?.midFreq ?? 1000, track.eq?.midGain ?? 0, 1.0, sampleRate);
    const eqHigh = createBiquadFilter('highshelf', 8000, track.eq?.highGain ?? 0, 0.707, sampleRate);

    const shouldApplyCompressor = !settings.bypassCompressors && Boolean(track.compressor?.enabled);
    const compressor = shouldApplyCompressor
      ? createCompressor(
          track.compressor.threshold,
          track.compressor.ratio,
          track.compressor.attack,
          track.compressor.release,
          sampleRate
        )
      : null;

    trackDspMap.set(track.id, {
      eqLow,
      eqMid,
      eqHigh,
      compressor,
      resampler,
      currentSourceFrame: Math.floor(exportStart * trkRate),
    });
  }

  // Process in 5-second chunk windows (~240,000 frames @ 48kHz = < 4MB RAM)
  const CHUNK_FRAMES = 5 * sampleRate;
  const numChunks = Math.ceil(numFrames / CHUNK_FRAMES);

  const chunkL = new Float32Array(CHUNK_FRAMES);
  const chunkR = new Float32Array(CHUNK_FRAMES);
  const trkL = new Float32Array(CHUNK_FRAMES);
  const trkR = new Float32Array(CHUNK_FRAMES);

  for (let c = 0; c < numChunks; c++) {
    const chunkStartFrame = c * CHUNK_FRAMES;
    const currentChunkFrames = Math.min(CHUNK_FRAMES, numFrames - chunkStartFrame);
    const chunkTimeStart = exportStart + chunkStartFrame / sampleRate;

    // Clear chunk accumulation buffers
    chunkL.fill(0, 0, currentChunkFrames);
    chunkR.fill(0, 0, currentChunkFrames);

    // Sum active tracks for this 5-second slice
    for (let tIdx = 0; tIdx < activeTracks.length; tIdx++) {
      const track = activeTracks[tIdx];
      const dsp = trackDspMap.get(track.id);
      if (!dsp) continue;

      trkL.fill(0, 0, currentChunkFrames);
      trkR.fill(0, 0, currentChunkFrames);

      const trkChannels = track.fileInfo?.channels || (track.audioBuffer ? track.audioBuffer.numberOfChannels : 2);
      const trackGain = dbToGain(track.volume);
      const { leftGain: panL, rightGain: panR } = calculateStereoPanGains(track.pan, trkChannels);

      // Source Path A: Direct from WAV sourceBlob slice
      if (track.sourceBlob && track.fileInfo) {
        const trkRate = track.fileInfo.sampleRate || 44100;
        const trkBits = track.fileInfo.bitDepth || 16;
        const trkBytesPerSample = trkBits / 8;
        const trkAlign = trkChannels * trkBytesPerSample;
        const dataOffset = track.parsedHeader?.dataChunkOffset ?? 44;

        if (trkRate === sampleRate) {
          // Native sample rate: 1-to-1 exact slice
          const srcStartFrame = dsp.currentSourceFrame;
          const byteStart = dataOffset + srcStartFrame * trkAlign;
          const byteEnd = byteStart + currentChunkFrames * trkAlign;

          if (byteStart < track.sourceBlob.size) {
            const sliceBlob = track.sourceBlob.slice(byteStart, Math.min(track.sourceBlob.size, byteEnd));
            const sliceBuf = await sliceBlob.arrayBuffer();
            const sliceView = new DataView(sliceBuf);
            const sliceFrames = Math.min(currentChunkFrames, Math.floor(sliceBuf.byteLength / trkAlign));

            for (let i = 0; i < sliceFrames; i++) {
              const fOffset = i * trkAlign;
              let sL = 0;
              let sR = 0;

              if (trkBits === 16) {
                sL = sliceView.getInt16(fOffset, true) / 32768;
                sR = trkChannels > 1 && fOffset + 4 <= sliceBuf.byteLength
                  ? sliceView.getInt16(fOffset + 2, true) / 32768
                  : sL;
              } else if (trkBits === 24) {
                const b0 = sliceView.getUint8(fOffset);
                const b1 = sliceView.getUint8(fOffset + 1);
                const b2 = sliceView.getUint8(fOffset + 2);
                let intL = (b2 << 16) | (b1 << 8) | b0;
                if (intL & 0x800000) intL |= ~0xffffff;
                sL = intL / 8388608;

                if (trkChannels > 1 && fOffset + 6 <= sliceBuf.byteLength) {
                  const rb0 = sliceView.getUint8(fOffset + 3);
                  const rb1 = sliceView.getUint8(fOffset + 4);
                  const rb2 = sliceView.getUint8(fOffset + 5);
                  let intR = (rb2 << 16) | (rb1 << 8) | rb0;
                  if (intR & 0x800000) intR |= ~0xffffff;
                  sR = intR / 8388608;
                } else {
                  sR = sL;
                }
              } else if (trkBits === 32) {
                sL = sliceView.getFloat32(fOffset, true);
                sR = trkChannels > 1 && fOffset + 8 <= sliceBuf.byteLength
                  ? sliceView.getFloat32(fOffset + 4, true)
                  : sL;
              }

              trkL[i] = sL;
              trkR[i] = sR;
            }
          }
          dsp.currentSourceFrame += currentChunkFrames;
        } else if (dsp.resampler) {
          // Different sample rate: use stateful polyphase Kaiser sinc resampler
          const srcFramesNeeded = Math.ceil((currentChunkFrames * trkRate) / sampleRate) + 64;
          const srcStartFrame = dsp.currentSourceFrame;
          const byteStart = dataOffset + srcStartFrame * trkAlign;
          const byteEnd = byteStart + srcFramesNeeded * trkAlign;

          if (byteStart < track.sourceBlob.size) {
            const sliceBlob = track.sourceBlob.slice(byteStart, Math.min(track.sourceBlob.size, byteEnd));
            const sliceBuf = await sliceBlob.arrayBuffer();
            const sliceView = new DataView(sliceBuf);
            const sliceFrames = Math.floor(sliceBuf.byteLength / trkAlign);

            const rawL = new Float32Array(sliceFrames);
            const rawR = new Float32Array(sliceFrames);

            for (let i = 0; i < sliceFrames; i++) {
              const fOffset = i * trkAlign;
              let sL = 0;
              let sR = 0;

              if (trkBits === 16) {
                sL = sliceView.getInt16(fOffset, true) / 32768;
                sR = trkChannels > 1 ? sliceView.getInt16(fOffset + 2, true) / 32768 : sL;
              } else if (trkBits === 24) {
                const b0 = sliceView.getUint8(fOffset);
                const b1 = sliceView.getUint8(fOffset + 1);
                const b2 = sliceView.getUint8(fOffset + 2);
                let intL = (b2 << 16) | (b1 << 8) | b0;
                if (intL & 0x800000) intL |= ~0xffffff;
                sL = intL / 8388608;

                if (trkChannels > 1) {
                  const rb0 = sliceView.getUint8(fOffset + 3);
                  const rb1 = sliceView.getUint8(fOffset + 4);
                  const rb2 = sliceView.getUint8(fOffset + 5);
                  let intR = (rb2 << 16) | (rb1 << 8) | rb0;
                  if (intR & 0x800000) intR |= ~0xffffff;
                  sR = intR / 8388608;
                } else {
                  sR = sL;
                }
              } else if (trkBits === 32) {
                sL = sliceView.getFloat32(fOffset, true);
                sR = trkChannels > 1 ? sliceView.getFloat32(fOffset + 4, true) : sL;
              }
              rawL[i] = sL;
              rawR[i] = sR;
            }

            const resampled = resamplePcmBlock(rawL, rawR, sliceFrames, currentChunkFrames, dsp.resampler);
            trkL.set(resampled.outL);
            trkR.set(resampled.outR);
            dsp.currentSourceFrame += resampled.framesConsumed;
          } else {
            dsp.currentSourceFrame += Math.ceil((currentChunkFrames * trkRate) / sampleRate);
          }
        }
      }
      // Source Path B: From track.audioBuffer (procedural demo stems)
      else if (track.audioBuffer) {
        const buf = track.audioBuffer;
        const srcL = buf.getChannelData(0);
        const srcR = buf.numberOfChannels > 1 ? buf.getChannelData(1) : srcL;

        if (buf.sampleRate === sampleRate) {
          const srcStartFrame = dsp.currentSourceFrame;
          for (let i = 0; i < currentChunkFrames; i++) {
            const srcIdx = srcStartFrame + i;
            if (srcIdx < srcL.length) {
              trkL[i] = srcL[srcIdx];
              trkR[i] = srcR[srcIdx];
            }
          }
          dsp.currentSourceFrame += currentChunkFrames;
        } else if (dsp.resampler) {
          const srcFramesNeeded = Math.ceil((currentChunkFrames * buf.sampleRate) / sampleRate) + 64;
          const srcStartFrame = dsp.currentSourceFrame;
          const rawL = new Float32Array(srcFramesNeeded);
          const rawR = new Float32Array(srcFramesNeeded);

          let valid = 0;
          for (let f = 0; f < srcFramesNeeded; f++) {
            const idx = srcStartFrame + f;
            if (idx >= 0 && idx < srcL.length) {
              rawL[f] = srcL[idx];
              rawR[f] = srcR[idx];
              valid++;
            }
          }

          const resampled = resamplePcmBlock(rawL, rawR, valid, currentChunkFrames, dsp.resampler);
          trkL.set(resampled.outL);
          trkR.set(resampled.outR);
          dsp.currentSourceFrame += resampled.framesConsumed;
        }
      }

      // Apply Track 3-Band Biquad Filters (Direct Form II Transposed)
      processBiquadFilter(dsp.eqLow, trkL, trkR, currentChunkFrames);
      processBiquadFilter(dsp.eqMid, trkL, trkR, currentChunkFrames);
      processBiquadFilter(dsp.eqHigh, trkL, trkR, currentChunkFrames);

      // Apply Track Dynamics Compressor
      if (dsp.compressor) {
        processCompressor(dsp.compressor, trkL, trkR, currentChunkFrames);
      }

      // Sum into master accumulation buffers with track gain & pan
      const effectiveGainL = trackGain * panL;
      const effectiveGainR = trackGain * panR;
      for (let i = 0; i < currentChunkFrames; i++) {
        chunkL[i] += trkL[i] * effectiveGainL;
        chunkR[i] += trkR[i] * effectiveGainR;
      }
    }

    // Apply Master 3-Band Biquad EQ (Direct Form II Transposed)
    processBiquadFilter(masterEqLow, chunkL, chunkR, currentChunkFrames);
    processBiquadFilter(masterEqMid, chunkL, chunkR, currentChunkFrames);
    processBiquadFilter(masterEqHigh, chunkL, chunkR, currentChunkFrames);

    // Apply Master Fader Gain
    if (masterGain !== 1.0) {
      for (let i = 0; i < currentChunkFrames; i++) {
        chunkL[i] *= masterGain;
        chunkR[i] *= masterGain;
      }
    }

    // Apply Master Brickwall Limiter (dynamic compression + continuous C1 soft saturation)
    if (masterLimiter) {
      processMasterLimiter(masterLimiter, chunkL, chunkR, currentChunkFrames);
    }

    // Write converted samples directly into the target DataView
    let outByteOffset = 44 + chunkStartFrame * blockAlign;

    if (bitDepth === 16) {
      for (let i = 0; i < currentChunkFrames; i++) {
        const ditherL = (Math.random() - Math.random()) / 32768;
        const sL = clamp(chunkL[i] + ditherL, -1.0, 1.0);
        let intL = Math.round(sL < 0 ? sL * 32768 : sL * 32767);
        intL = Math.max(-32768, Math.min(32767, intL));
        outView.setInt16(outByteOffset, intL, true);
        outByteOffset += 2;

        const ditherR = (Math.random() - Math.random()) / 32768;
        const sR = clamp(chunkR[i] + ditherR, -1.0, 1.0);
        let intR = Math.round(sR < 0 ? sR * 32768 : sR * 32767);
        intR = Math.max(-32768, Math.min(32767, intR));
        outView.setInt16(outByteOffset, intR, true);
        outByteOffset += 2;
      }
    } else if (bitDepth === 24) {
      const isPassThrough =
        Boolean(settings.bypassDither) ||
        (activeTracks.length === 1 &&
          !settings.normalize &&
          masterGain === 1.0 &&
          !masterLimiter &&
          activeTracks[0].volume === 0 &&
          activeTracks[0].pan === 0 &&
          !trackDspMap.get(activeTracks[0].id)?.compressor);

      const applyDither = !isPassThrough;

      for (let i = 0; i < currentChunkFrames; i++) {
        // Left channel: optional 24-bit TPDF dither and canonical little-endian byte packing
        const ditherL = applyDither ? (Math.random() - Math.random()) / 8388608 : 0;
        const sL = clamp(chunkL[i] + ditherL, -1.0, 1.0);
        let intL = Math.round(sL < 0 ? sL * 8388608 : Math.min(8388607, sL * 8388608));
        intL = Math.max(-8388608, Math.min(8388607, intL));
        outView.setUint8(outByteOffset, intL & 0xff);
        outView.setUint8(outByteOffset + 1, (intL >> 8) & 0xff);
        outView.setUint8(outByteOffset + 2, (intL >> 16) & 0xff);
        outByteOffset += 3;

        // Right channel: optional 24-bit TPDF dither and canonical little-endian byte packing
        const ditherR = applyDither ? (Math.random() - Math.random()) / 8388608 : 0;
        const sR = clamp(chunkR[i] + ditherR, -1.0, 1.0);
        let intR = Math.round(sR < 0 ? sR * 8388608 : Math.min(8388607, sR * 8388608));
        intR = Math.max(-8388608, Math.min(8388607, intR));
        outView.setUint8(outByteOffset, intR & 0xff);
        outView.setUint8(outByteOffset + 1, (intR >> 8) & 0xff);
        outView.setUint8(outByteOffset + 2, (intR >> 16) & 0xff);
        outByteOffset += 3;
      }
    } else if (bitDepth === 32) {
      for (let i = 0; i < currentChunkFrames; i++) {
        outView.setFloat32(outByteOffset, chunkL[i], true);
        outByteOffset += 4;
        outView.setFloat32(outByteOffset, chunkR[i], true);
        outByteOffset += 4;
      }
    }

    if (onProgress) {
      onProgress(Math.round(((c + 1) / numChunks) * 100));
    }

    // Cooperative tick to allow browser UI & GC to breathe
    if (c % 10 === 0) {
      await new Promise(r => setTimeout(r, 0));
    }
  }

  return new Blob([outputBuffer], { type: 'audio/wav' });
}
