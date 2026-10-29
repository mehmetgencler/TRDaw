/**
 * Transferable ArrayBuffer Pool with Strict Credit Backpressure
 *
 * Enforces bounded memory limits for PCM streaming independent of track duration.
 *
 * State Transitions:
 * [FREE] --acquire()--> [DECODING] --markInFlight()--> [IN_FLIGHT] --release()--> [FREE]
 *
 * At any point in time, max concurrent non-free buffers S per track is strictly bounded:
 * S_track <= maxInFlightPerTrack (default 1)
 * Total concurrent active buffers across 4 tracks: S <= 4.
 */

export type BufferState = 'FREE' | 'DECODING' | 'IN_FLIGHT';

export interface StagingBuffer {
  id: number;
  trackId: string;
  state: BufferState;
  leftBuffer: ArrayBuffer;
  rightBuffer: ArrayBuffer;
  leftView: Float32Array;
  rightView: Float32Array;
  frameCapacity: number;
}

export class BoundedBufferPool {
  private buffers: StagingBuffer[] = [];
  private trackInFlightCount = new Map<string, number>();
  public readonly framesPerBuffer: number;
  public readonly maxInFlightPerTrack: number;

  constructor(trackIds: string[], framesPerBuffer: number, maxInFlightPerTrack = 1) {
    this.framesPerBuffer = framesPerBuffer;
    this.maxInFlightPerTrack = maxInFlightPerTrack;

    let id = 1;
    for (const trackId of trackIds) {
      this.trackInFlightCount.set(trackId, 0);
      for (let i = 0; i < maxInFlightPerTrack; i++) {
        const leftBuffer = new ArrayBuffer(framesPerBuffer * 4);
        const rightBuffer = new ArrayBuffer(framesPerBuffer * 4);
        this.buffers.push({
          id: id++,
          trackId,
          state: 'FREE',
          leftBuffer,
          rightBuffer,
          leftView: new Float32Array(leftBuffer),
          rightView: new Float32Array(rightBuffer),
          frameCapacity: framesPerBuffer,
        });
      }
    }
  }

  /**
   * Checks if a track has credits available to decode a new block.
   */
  public canAcquire(trackId: string): boolean {
    const inFlight = this.trackInFlightCount.get(trackId) ?? 0;
    return inFlight < this.maxInFlightPerTrack;
  }

  /**
   * Acquires a FREE staging buffer for a given track, transitioning it to DECODING.
   */
  public acquire(trackId: string): StagingBuffer | null {
    if (!this.canAcquire(trackId)) {
      return null;
    }

    const buf = this.buffers.find(b => b.trackId === trackId && b.state === 'FREE');
    if (!buf) return null;

    buf.state = 'DECODING';
    const current = this.trackInFlightCount.get(trackId) ?? 0;
    this.trackInFlightCount.set(trackId, current + 1);
    return buf;
  }

  /**
   * Marks buffer as IN_FLIGHT when transferred to the AudioWorklet.
   */
  public markInFlight(bufferId: number): void {
    const buf = this.buffers.find(b => b.id === bufferId);
    if (buf) {
      buf.state = 'IN_FLIGHT';
    }
  }

  /**
   * Reclaims transferred or detached buffers when processed by the AudioWorklet,
   * returning them to FREE.
   */
  public release(bufferId: number, newLeftBuffer?: ArrayBuffer, newRightBuffer?: ArrayBuffer): void {
    const buf = this.buffers.find(b => b.id === bufferId);
    if (!buf) return;

    if (newLeftBuffer && newRightBuffer) {
      buf.leftBuffer = newLeftBuffer;
      buf.rightBuffer = newRightBuffer;
      buf.leftView = new Float32Array(newLeftBuffer);
      buf.rightView = new Float32Array(newRightBuffer);
    }

    buf.state = 'FREE';
    const current = this.trackInFlightCount.get(buf.trackId) ?? 0;
    this.trackInFlightCount.set(buf.trackId, Math.max(0, current - 1));
  }

  /**
   * Resets all staging buffers for all tracks to FREE.
   */
  public resetAll(): void {
    for (const buf of this.buffers) {
      buf.state = 'FREE';
    }
    for (const key of this.trackInFlightCount.keys()) {
      this.trackInFlightCount.set(key, 0);
    }
  }

  /**
   * Resets staging buffers and in-flight count for a specific track to FREE.
   */
  public flushTrack(trackId: string): void {
    for (const buf of this.buffers) {
      if (buf.trackId === trackId) {
        buf.state = 'FREE';
      }
    }
    this.trackInFlightCount.set(trackId, 0);
  }

  /**
   * Returns current count of in-flight/active buffers across all tracks.
   */
  public getTotalInFlight(): number {
    let total = 0;
    for (const count of this.trackInFlightCount.values()) {
      total += count;
    }
    return total;
  }

  /**
   * Total number of staging buffers created in the pool
   */
  public getPoolCapacity(): number {
    return this.buffers.length;
  }
}

export interface ItemizedMemoryEstimate {
  ringBytes: number;
  stagingBytes: number;
  decoderScratchBytes: number;
  resamplerStateBytes: number;
  totalBytes: number;
  totalMebibytes: number;
}

/**
 * Calculates exact itemized PCM working memory for K tracks, ring duration, and staging capacity.
 */
export function calculatePcmWorkingMemory(
  tracksCount: number,
  sampleRate: number,
  ringDurationSec = 6.0,
  stagingDurationSec = 1.0,
  stagingBuffersInFlight = 1
): ItemizedMemoryEstimate {
  const bytesPerFloat32 = 4;
  const stereoChannels = 2;

  // 1. Ring buffer memory in AudioWorklet: K * C * 4 * Fs * W_ring
  const ringBytes = tracksCount * stereoChannels * bytesPerFloat32 * sampleRate * ringDurationSec;

  // 2. Staging memory in BufferPool: K * C * 4 * Fs * P * S
  const stagingBytes =
    tracksCount * stereoChannels * bytesPerFloat32 * sampleRate * stagingDurationSec * stagingBuffersInFlight;

  // 3. Decoder scratch (WAV slice ArrayBuffer + Float32 decode channels per active track)
  // Each track decodes ~1.0s at Fs: 1.0 * Fs * 2ch * 2bytes (16-bit) + 2 * Fs * 4bytes (Float32)
  const decoderScratchPerTrack = sampleRate * stereoChannels * 2 + sampleRate * stereoChannels * bytesPerFloat32;
  const decoderScratchBytes = tracksCount * decoderScratchPerTrack;

  // 4. Resampler state: 64-phase x 64-tap pre-normalized FIR table (4096 Float32s)
  // plus 64-sample history buffer per stereo channel (64 * 2 * 4 bytes)
  const polyphaseTableBytes = 64 * 64 * bytesPerFloat32; // 16,384 bytes
  const polyphaseHistBytes = 64 * stereoChannels * bytesPerFloat32; // 512 bytes
  const resamplerPerTrack = polyphaseTableBytes + polyphaseHistBytes; // 16,896 bytes
  const resamplerStateBytes = tracksCount * resamplerPerTrack; // 67,584 bytes

  const totalBytes = ringBytes + stagingBytes + decoderScratchBytes + resamplerStateBytes;
  const totalMebibytes = totalBytes / (1024 * 1024);

  return {
    ringBytes,
    stagingBytes,
    decoderScratchBytes,
    resamplerStateBytes,
    totalBytes,
    totalMebibytes,
  };
}
