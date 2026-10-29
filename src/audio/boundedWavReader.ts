/**
 * Bounded-Memory WAV/PCM Slice Reader
 * Reads strictly bounded sample windows from massive WAV files (up to multi-gigabytes)
 * using Blob.slice() without loading complete audio files into memory.
 */

import { parseWavHeader, type ParsedWavHeader } from './wavParser';

export class UnsupportedWavFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedWavFormatError';
  }
}

export interface DecodedPcmSlice {
  left: Float32Array;
  right: Float32Array;
  framesRead: number;
  startFrame: number;
}

/**
 * Parses RIFF WAV header using a minimal 64KB initial slice.
 */
export async function readWavHeaderFromBlob(blob: Blob): Promise<ParsedWavHeader> {
  const headerSliceSize = Math.min(blob.size, 65536);
  const sliceBuffer = await blob.slice(0, headerSliceSize).arrayBuffer();
  return parseWavHeader(sliceBuffer, blob.size);
}

/**
 * Reads and decodes a specific frame interval [startFrame, startFrame + frameCount) from a WAV Blob.
 * Only the requested slice bytes are read into RAM and converted to Float32.
 * Unsupported formats (e.g. 8-bit unsigned PCM or non-PCM audio) throw UnsupportedWavFormatError.
 */
export async function readWavPcmSlice(
  blob: Blob,
  header: ParsedWavHeader,
  startFrame: number,
  frameCount: number
): Promise<DecodedPcmSlice> {
  if (header.bitsPerSample === 8) {
    throw new UnsupportedWavFormatError('8-bit unsigned PCM is not supported');
  }

  if (header.audioFormat !== 1 && header.audioFormat !== 3) {
    throw new UnsupportedWavFormatError(
      `Unsupported WAV audio format code: ${header.audioFormat} (only PCM=1 and IEEE_FLOAT=3 supported)`
    );
  }

  const left = new Float32Array(frameCount);
  const right = new Float32Array(frameCount);

  if (startFrame >= header.totalSampleFrames || frameCount <= 0) {
    return { left, right, framesRead: 0, startFrame };
  }

  const validStartFrame = Math.max(0, startFrame);
  const availableFrames = Math.max(0, header.totalSampleFrames - validStartFrame);
  const framesToRead = Math.min(frameCount, availableFrames);

  const byteStart = header.dataChunkOffset + validStartFrame * header.blockAlign;
  const byteEnd = byteStart + framesToRead * header.blockAlign;

  const sliceBlob = blob.slice(byteStart, byteEnd);
  const sliceBuffer = await sliceBlob.arrayBuffer();
  const view = new DataView(sliceBuffer);

  const channels = header.channels;
  const bitsPerSample = header.bitsPerSample;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = header.blockAlign;

  for (let f = 0; f < framesToRead; f++) {
    const frameOffset = f * blockAlign;
    if (frameOffset + blockAlign > sliceBuffer.byteLength) break;

    // Decode Channel 0 (Left)
    let sampleL = 0;
    if (bitsPerSample === 16) {
      sampleL = view.getInt16(frameOffset, true) / 32768;
    } else if (bitsPerSample === 24) {
      const b0 = view.getUint8(frameOffset);
      const b1 = view.getUint8(frameOffset + 1);
      const b2 = view.getInt8(frameOffset + 2);
      const int24 = (b2 << 16) | (b1 << 8) | b0;
      sampleL = int24 / 8388608;
    } else if (bitsPerSample === 32) {
      if (header.audioFormat === 3) {
        sampleL = view.getFloat32(frameOffset, true);
      } else {
        sampleL = view.getInt32(frameOffset, true) / 2147483648;
      }
    }

    // Decode Channel 1 (Right or mono duplicated)
    let sampleR = sampleL;
    if (channels >= 2) {
      const rightOffset = frameOffset + bytesPerSample;
      if (bitsPerSample === 16) {
        sampleR = view.getInt16(rightOffset, true) / 32768;
      } else if (bitsPerSample === 24) {
        const b0 = view.getUint8(rightOffset);
        const b1 = view.getUint8(rightOffset + 1);
        const b2 = view.getInt8(rightOffset + 2);
        const int24 = (b2 << 16) | (b1 << 8) | b0;
        sampleR = int24 / 8388608;
      } else if (bitsPerSample === 32) {
        if (header.audioFormat === 3) {
          sampleR = view.getFloat32(rightOffset, true);
        } else {
          sampleR = view.getInt32(rightOffset, true) / 2147483648;
        }
      }
    }

    left[f] = sampleL;
    right[f] = sampleR;
  }

  return {
    left,
    right,
    framesRead: framesToRead,
    startFrame: validStartFrame,
  };
}
