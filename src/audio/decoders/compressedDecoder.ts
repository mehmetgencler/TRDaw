/**
 * Compressed Format Stream Decoders (MP3 / AAC)
 *
 * Implements bounded, chunked WASM decoding for MP3 (mpg123) and AAC (fdk/helix)
 * with strict frame boundary validation, priming delay accounting, mid-frame
 * truncation detection, and memory tracking.
 */

import { MPEGDecoder } from 'mpg123-decoder';
import { AACDecoder } from '@wasm-audio-decoders/aac';

export class TruncatedFrameError extends Error {
  public readonly format: 'mp3' | 'aac';
  public readonly byteOffset: number;
  public readonly expectedBytes: number;
  public readonly availableBytes: number;

  constructor(
    format: 'mp3' | 'aac',
    byteOffset: number,
    expectedBytes: number,
    availableBytes: number
  ) {
    super(
      `Truncated ${format.toUpperCase()} frame detected at byte offset ${byteOffset}: expected ${expectedBytes} bytes, but only ${availableBytes} bytes remain in the slice`
    );
    this.name = 'TruncatedFrameError';
    this.format = format;
    this.byteOffset = byteOffset;
    this.expectedBytes = expectedBytes;
    this.availableBytes = availableBytes;
  }
}

export interface ParsedFrameInfo {
  offset: number;
  length: number;
  sampleRate: number;
  channels: number;
  samplesPerFrame: number;
}

const MP3_BITRATES = [
  0, 32000, 40000, 48000, 56000, 64000, 80000, 96000,
  112000, 128000, 160000, 192000, 224000, 256000, 320000, 0
];
const MP3_SAMPLE_RATES = [44100, 48000, 32000, 0];

const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
  16000, 12000, 11025, 8000, 7350, 0, 0, 0
];

/**
 * Validates and parses all MP3 frames within a buffer.
 * Throws TruncatedFrameError if a frame header is truncated or payload is cut short.
 */
export function parseMp3Frames(buf: Uint8Array): ParsedFrameInfo[] {
  let offset = 0;
  // Skip ID3v2 header if present (ID3\x03 / ID3\x04)
  if (buf.length >= 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const id3Size =
      ((buf[6] & 0x7F) << 21) |
      ((buf[7] & 0x7F) << 14) |
      ((buf[8] & 0x7F) << 7) |
      (buf[9] & 0x7F);
    offset = 10 + id3Size;
  }

  const frames: ParsedFrameInfo[] = [];

  while (offset < buf.length) {
    if (offset + 4 > buf.length) {
      throw new TruncatedFrameError('mp3', offset, 4, buf.length - offset);
    }

    const b0 = buf[offset];
    const b1 = buf[offset + 1];

    // Frame sync: 11 bits set to 1 (0xFFE0 mask)
    if (b0 !== 0xFF || (b1 & 0xE0) !== 0xE0) {
      offset++;
      continue;
    }

    const version = (b1 >> 3) & 0x03; // 3 = MPEG-1
    const layer = (b1 >> 1) & 0x03;   // 1 = Layer III
    const b2 = buf[offset + 2];
    const bitrateIdx = (b2 >> 4) & 0x0F;
    const sampleRateIdx = (b2 >> 2) & 0x03;
    const padding = (b2 >> 1) & 0x01;
    const b3 = buf[offset + 3];
    const channelMode = (b3 >> 6) & 0x03;
    const channels = channelMode === 3 ? 1 : 2;

    if (
      version !== 3 ||
      layer !== 1 ||
      bitrateIdx === 0 ||
      bitrateIdx === 15 ||
      sampleRateIdx === 3
    ) {
      offset++;
      continue;
    }

    const bitrate = MP3_BITRATES[bitrateIdx];
    const sampleRate = MP3_SAMPLE_RATES[sampleRateIdx];
    const frameLength = Math.floor((144 * bitrate) / sampleRate) + padding;

    if (offset + frameLength > buf.length) {
      throw new TruncatedFrameError('mp3', offset, frameLength, buf.length - offset);
    }

    frames.push({
      offset,
      length: frameLength,
      sampleRate,
      channels,
      samplesPerFrame: 1152,
    });

    offset += frameLength;
  }

  return frames;
}

/**
 * Validates and parses all ADTS AAC frames within a buffer.
 * Throws TruncatedFrameError if an ADTS header is truncated or payload is cut short.
 */
export function parseAdtsFrames(buf: Uint8Array): ParsedFrameInfo[] {
  let offset = 0;
  const frames: ParsedFrameInfo[] = [];

  while (offset < buf.length) {
    if (offset + 7 > buf.length) {
      throw new TruncatedFrameError('aac', offset, 7, buf.length - offset);
    }

    const b0 = buf[offset];
    const b1 = buf[offset + 1];

    // ADTS sync: 12 bits 0xFFF (0xFFF0 mask)
    if (b0 !== 0xFF || (b1 & 0xF0) !== 0xF0) {
      offset++;
      continue;
    }

    const sampleRateIdx = (buf[offset + 2] >> 2) & 0x0F;
    const sampleRate = AAC_SAMPLE_RATES[sampleRateIdx] || 48000;
    const channelConfig = ((buf[offset + 2] & 0x01) << 2) | ((buf[offset + 3] >> 6) & 0x03);
    const channels = channelConfig === 1 ? 1 : 2;

    const frameLength =
      ((buf[offset + 3] & 0x03) << 11) |
      (buf[offset + 4] << 3) |
      ((buf[offset + 5] & 0xE0) >> 5);

    if (frameLength < 7) {
      offset++;
      continue;
    }

    if (offset + frameLength > buf.length) {
      throw new TruncatedFrameError('aac', offset, frameLength, buf.length - offset);
    }

    frames.push({
      offset,
      length: frameLength,
      sampleRate,
      channels,
      samplesPerFrame: 1024,
    });

    offset += frameLength;
  }

  return frames;
}

export interface DecodedBlock {
  left: Float32Array;
  right: Float32Array;
  samplesDecoded: number;
}

export interface ICompressedStreamDecoder {
  readonly format: 'mp3' | 'aac';
  readonly primingDelay: number;
  readonly ready: Promise<void>;
  getWasmHeapBytes(): number;
  decode(data: Uint8Array): Promise<DecodedBlock>;
  reset(): Promise<void>;
  free(): void;
}

/**
 * MPEG-1 Layer 3 Streaming WASM Decoder
 * Priming delay: 1105 samples (MPEG-1 Layer III 529 LAME encoder delay + 576 MDCT overlap filter delay)
 */
export class MpegStreamDecoder implements ICompressedStreamDecoder {
  public readonly format = 'mp3' as const;
  public readonly primingDelay = 1105;
  private decoder: MPEGDecoder;
  public readonly ready: Promise<void>;

  constructor() {
    this.decoder = new MPEGDecoder();
    this.ready = this.decoder.ready;
  }

  public getWasmHeapBytes(): number {
    const common = (this.decoder as unknown as { _common?: { wasm?: { HEAP?: ArrayBuffer } } })._common;
    return common?.wasm?.HEAP?.byteLength ?? 0;
  }

  public async decode(data: Uint8Array): Promise<DecodedBlock> {
    await this.ready;
    // Validate frame boundary consistency
    parseMp3Frames(data);

    const result = this.decoder.decode(data);
    const left = result.channelData[0] || new Float32Array(0);
    const right = result.channelData[1] || left;
    return {
      left,
      right,
      samplesDecoded: result.samplesDecoded,
    };
  }

  public async reset(): Promise<void> {
    await this.ready;
    this.decoder.reset();
  }

  public free(): void {
    this.decoder.free();
  }
}

/**
 * Advanced Audio Coding (AAC-LC) Streaming WASM Decoder
 * Priming delay: 1024 samples (1 MDCT frame priming delay, matching ISO/IEC 14496-3 edit list atom)
 */
export class AacStreamDecoder implements ICompressedStreamDecoder {
  public readonly format = 'aac' as const;
  public readonly primingDelay = 1024;
  private decoder: AACDecoder;
  public readonly ready: Promise<void>;

  constructor() {
    this.decoder = new AACDecoder();
    this.ready = this.decoder.ready;
  }

  public getWasmHeapBytes(): number {
    const internal = (this.decoder as unknown as {
      _decoder?: { _common?: { wasm?: { HEAP?: ArrayBuffer } } };
    })._decoder;
    return internal?._common?.wasm?.HEAP?.byteLength ?? 0;
  }

  public async decode(data: Uint8Array): Promise<DecodedBlock> {
    await this.ready;
    // Validate ADTS frame boundaries
    parseAdtsFrames(data);

    const res1 = await this.decoder.decode(data);
    const res2 = await this.decoder.flush();

    const totalSamples = res1.samplesDecoded + res2.samplesDecoded;
    const left = new Float32Array(totalSamples);
    const right = new Float32Array(totalSamples);

    if (res1.samplesDecoded > 0 && res1.channelData[0]) {
      left.set(res1.channelData[0], 0);
      right.set(res1.channelData[1] || res1.channelData[0], 0);
    }

    if (res2.samplesDecoded > 0 && res2.channelData[0]) {
      left.set(res2.channelData[0], res1.samplesDecoded);
      right.set(res2.channelData[1] || res2.channelData[0], res1.samplesDecoded);
    }

    return {
      left,
      right,
      samplesDecoded: totalSamples,
    };
  }

  public async reset(): Promise<void> {
    await this.ready;
    await this.decoder.reset();
  }

  public free(): void {
    this.decoder.free();
  }
}
