/**
 * Canonical RIFF WAV Audio Encoder (16-bit, 24-bit PCM & 32-bit Float)
 * Supports memory-conscious progressive encoding and export mixdown.
 */

import { calculatePanGains, dbToGain, clamp } from './math';
import type { TrackData, MasterState, ExportSettings } from '../types/audio';

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
      // Left channel sample
      let sL = clamp(leftChannel[i], -1.0, 1.0);
      let intL = sL < 0 ? sL * 32768 : sL * 32767;
      view.setInt16(offset, intL, true);
      offset += 2;

      // Right channel sample
      let sR = clamp(rightChannel[i], -1.0, 1.0);
      let intR = sR < 0 ? sR * 32768 : sR * 32767;
      view.setInt16(offset, intR, true);
      offset += 2;
    }
  } else if (bitDepth === 24) {
    for (let i = 0; i < numFrames; i++) {
      let sL = clamp(leftChannel[i], -1.0, 1.0);
      let intL = sL < 0 ? Math.floor(sL * 8388608) : Math.floor(sL * 8388607);
      view.setUint8(offset, intL & 0xff);
      view.setUint8(offset + 1, (intL >> 8) & 0xff);
      view.setInt8(offset + 2, (intL >> 16) & 0xff);
      offset += 3;

      let sR = clamp(rightChannel[i], -1.0, 1.0);
      let intR = sR < 0 ? Math.floor(sR * 8388608) : Math.floor(sR * 8388607);
      view.setUint8(offset, intR & 0xff);
      view.setUint8(offset + 1, (intR >> 8) & 0xff);
      view.setInt8(offset + 2, (intR >> 16) & 0xff);
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

/**
 * Mixes down active tracks into a single WAV Blob using calibrated DSP math.
 * Applies individual track gain, pan, EQ gains, mute/solo logic, master limiter, and volume.
 * Uses bounded 5-second chunk windows to prevent memory exhaustion on mobile Safari.
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

  // Pre-allocate the single target ArrayBuffer (no intermediate duplicate float arrays)
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
  const limiterThreshold = dbToGain(master.limiterThreshold);

  // Process in 5-second chunk windows (~220,500 frames = <2MB RAM)
  const CHUNK_FRAMES = 5 * sampleRate;
  const numChunks = Math.ceil(numFrames / CHUNK_FRAMES);

  const chunkL = new Float32Array(CHUNK_FRAMES);
  const chunkR = new Float32Array(CHUNK_FRAMES);

  for (let c = 0; c < numChunks; c++) {
    const chunkStartFrame = c * CHUNK_FRAMES;
    const currentChunkFrames = Math.min(CHUNK_FRAMES, numFrames - chunkStartFrame);
    const chunkTimeStart = exportStart + (chunkStartFrame / sampleRate);

    // Clear chunk accumulation buffers
    chunkL.fill(0, 0, currentChunkFrames);
    chunkR.fill(0, 0, currentChunkFrames);

    // Sum active tracks for this 5-second slice
    for (let tIdx = 0; tIdx < activeTracks.length; tIdx++) {
      const track = activeTracks[tIdx];
      const trackGain = dbToGain(track.volume);
      const { leftGain: panL, rightGain: panR } = calculatePanGains(track.pan);

      const eqLowGain = dbToGain(track.eq.lowGain);
      const eqMidGain = dbToGain(track.eq.midGain);
      const eqHighGain = dbToGain(track.eq.highGain);
      const overallEqGain = (eqLowGain * 0.35) + (eqMidGain * 0.4) + (eqHighGain * 0.25);

      const effectiveGainL = trackGain * panL * overallEqGain * masterGain;
      const effectiveGainR = trackGain * panR * overallEqGain * masterGain;

      // Source Path A: Direct from WAV sourceBlob slice
      if (track.sourceBlob && track.fileInfo) {
        const trkRate = track.fileInfo.sampleRate || 44100;
        const trkBits = track.fileInfo.bitDepth || 16;
        const trkAlign = track.fileInfo.channels * (trkBits / 8);
        const trkBytesPerSample = trkBits / 8;
        const trkChannels = track.fileInfo.channels;
        const dataOffset = 44; // standard WAV header offset

        const srcStartFrame = Math.floor(chunkTimeStart * trkRate);
        const srcEndFrame = Math.floor((chunkTimeStart + (currentChunkFrames / sampleRate)) * trkRate);
        const byteStart = dataOffset + srcStartFrame * trkAlign;
        const byteEnd = dataOffset + srcEndFrame * trkAlign;

        if (byteStart < track.sourceBlob.size) {
          const sliceBlob = track.sourceBlob.slice(byteStart, Math.min(track.sourceBlob.size, byteEnd));
          const sliceBuf = await sliceBlob.arrayBuffer();
          const sliceView = new DataView(sliceBuf);
          const rateRatio = trkRate / sampleRate;

          for (let i = 0; i < currentChunkFrames; i++) {
            const srcIdx = Math.floor(i * rateRatio);
            const frameByteOffset = srcIdx * trkAlign;

            if (frameByteOffset + trkBytesPerSample <= sliceBuf.byteLength) {
              let sL = 0;
              let sR = 0;

              if (trkBits === 16) {
                sL = sliceView.getInt16(frameByteOffset, true) / 32768;
                sR = trkChannels > 1 && frameByteOffset + 4 <= sliceBuf.byteLength
                  ? sliceView.getInt16(frameByteOffset + 2, true) / 32768
                  : sL;
              } else if (trkBits === 24) {
                const b0 = sliceView.getUint8(frameByteOffset);
                const b1 = sliceView.getUint8(frameByteOffset + 1);
                const b2 = sliceView.getInt8(frameByteOffset + 2);
                sL = ((b2 << 16) | (b1 << 8) | b0) / 8388608;

                if (trkChannels > 1 && frameByteOffset + 6 <= sliceBuf.byteLength) {
                  const rb0 = sliceView.getUint8(frameByteOffset + 3);
                  const rb1 = sliceView.getUint8(frameByteOffset + 4);
                  const rb2 = sliceView.getInt8(frameByteOffset + 5);
                  sR = ((rb2 << 16) | (rb1 << 8) | rb0) / 8388608;
                } else {
                  sR = sL;
                }
              } else if (trkBits === 32) {
                sL = sliceView.getFloat32(frameByteOffset, true);
                sR = trkChannels > 1 && frameByteOffset + 8 <= sliceBuf.byteLength
                  ? sliceView.getFloat32(frameByteOffset + 4, true)
                  : sL;
              }

              chunkL[i] += sL * effectiveGainL;
              chunkR[i] += sR * effectiveGainR;
            }
          }
        }
      }
      // Source Path B: From track.audioBuffer (procedural demo stems)
      else if (track.audioBuffer) {
        const buf = track.audioBuffer;
        const srcL = buf.getChannelData(0);
        const srcR = buf.numberOfChannels > 1 ? buf.getChannelData(1) : srcL;
        const rateRatio = buf.sampleRate / sampleRate;

        for (let i = 0; i < currentChunkFrames; i++) {
          const globalFrame = chunkStartFrame + i;
          const globalTime = exportStart + (globalFrame / sampleRate);
          const srcIdx = Math.floor(globalTime * buf.sampleRate);
          if (srcIdx < srcL.length) {
            chunkL[i] += srcL[srcIdx] * effectiveGainL;
            chunkR[i] += srcR[srcIdx] * effectiveGainR;
          }
        }
      }
    }

    // Apply master soft limiter / saturation on this 5-second slice
    for (let i = 0; i < currentChunkFrames; i++) {
      if (Math.abs(chunkL[i]) > limiterThreshold) {
        chunkL[i] = Math.tanh(chunkL[i]);
      }
      if (Math.abs(chunkR[i]) > limiterThreshold) {
        chunkR[i] = Math.tanh(chunkR[i]);
      }
    }

    // Write converted samples directly into the target DataView
    let outByteOffset = 44 + chunkStartFrame * blockAlign;

    if (bitDepth === 16) {
      for (let i = 0; i < currentChunkFrames; i++) {
        let sL = clamp(chunkL[i], -1.0, 1.0);
        let intL = sL < 0 ? sL * 32768 : sL * 32767;
        outView.setInt16(outByteOffset, intL, true);
        outByteOffset += 2;

        let sR = clamp(chunkR[i], -1.0, 1.0);
        let intR = sR < 0 ? sR * 32768 : sR * 32767;
        outView.setInt16(outByteOffset, intR, true);
        outByteOffset += 2;
      }
    } else if (bitDepth === 24) {
      for (let i = 0; i < currentChunkFrames; i++) {
        let sL = clamp(chunkL[i], -1.0, 1.0);
        let intL = sL < 0 ? Math.floor(sL * 8388608) : Math.floor(sL * 8388607);
        outView.setUint8(outByteOffset, intL & 0xff);
        outView.setUint8(outByteOffset + 1, (intL >> 8) & 0xff);
        outView.setInt8(outByteOffset + 2, (intL >> 16) & 0xff);
        outByteOffset += 3;

        let sR = clamp(chunkR[i], -1.0, 1.0);
        let intR = sR < 0 ? Math.floor(sR * 8388608) : Math.floor(sR * 8388607);
        outView.setUint8(outByteOffset, intR & 0xff);
        outView.setUint8(outByteOffset + 1, (intR >> 8) & 0xff);
        outView.setInt8(outByteOffset + 2, (intR >> 16) & 0xff);
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
