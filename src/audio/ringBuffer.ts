/**
 * Single-Producer Single-Consumer Stereo Float32 Circular Ring Buffer
 * Preallocated to fixed capacity (e.g. 6 seconds at output sample rate).
 * Thread-safe for audio worklet or coordinated worker messaging.
 */

export class StereoRingBuffer {
  public readonly capacity: number;
  private readonly leftBuffer: Float32Array;
  private readonly rightBuffer: Float32Array;
  private writeIndex = 0;
  private readIndex = 0;
  private availableFrames = 0;

  constructor(capacityFrames: number) {
    if (capacityFrames <= 0) {
      throw new Error(`Ring buffer capacity must be positive, got ${capacityFrames}`);
    }
    this.capacity = capacityFrames;
    this.leftBuffer = new Float32Array(capacityFrames);
    this.rightBuffer = new Float32Array(capacityFrames);
  }

  /**
   * Number of readable frames currently stored in the ring buffer.
   */
  public getAvailableRead(): number {
    return this.availableFrames;
  }

  /**
   * Number of frames that can still be written before the ring buffer is full.
   */
  public getAvailableWrite(): number {
    return this.capacity - this.availableFrames;
  }

  /**
   * Writes interleaved or planar stereo frames into the ring buffer.
   * Returns actual number of frames written.
   */
  public write(left: Float32Array, right: Float32Array, count?: number): number {
    const toWrite = Math.min(
      count ?? left.length,
      left.length,
      right.length,
      this.getAvailableWrite()
    );

    if (toWrite <= 0) return 0;

    const firstChunk = Math.min(toWrite, this.capacity - this.writeIndex);
    this.leftBuffer.set(left.subarray(0, firstChunk), this.writeIndex);
    this.rightBuffer.set(right.subarray(0, firstChunk), this.writeIndex);

    const secondChunk = toWrite - firstChunk;
    if (secondChunk > 0) {
      this.leftBuffer.set(left.subarray(firstChunk, toWrite), 0);
      this.rightBuffer.set(right.subarray(firstChunk, toWrite), 0);
      this.writeIndex = secondChunk;
    } else {
      this.writeIndex = (this.writeIndex + firstChunk) % this.capacity;
    }

    this.availableFrames += toWrite;
    return toWrite;
  }

  /**
   * Reads frames from the ring buffer into destination arrays.
   * If available frames < requested count, returns frames read (can zero-pad destination).
   */
  public read(outLeft: Float32Array, outRight: Float32Array, count?: number): number {
    const requested = count ?? outLeft.length;
    const toRead = Math.min(requested, outLeft.length, outRight.length, this.availableFrames);

    if (toRead <= 0) {
      outLeft.fill(0, 0, requested);
      outRight.fill(0, requested);
      return 0;
    }

    const firstChunk = Math.min(toRead, this.capacity - this.readIndex);
    outLeft.set(this.leftBuffer.subarray(this.readIndex, this.readIndex + firstChunk), 0);
    outRight.set(this.rightBuffer.subarray(this.readIndex, this.readIndex + firstChunk), 0);

    const secondChunk = toRead - firstChunk;
    if (secondChunk > 0) {
      outLeft.set(this.leftBuffer.subarray(0, secondChunk), firstChunk);
      outRight.set(this.rightBuffer.subarray(0, secondChunk), firstChunk);
      this.readIndex = secondChunk;
    } else {
      this.readIndex = (this.readIndex + firstChunk) % this.capacity;
    }

    this.availableFrames -= toRead;

    // Zero-fill any remaining requested frames if underrun
    if (toRead < requested) {
      outLeft.fill(0, toRead, requested);
      outRight.fill(0, toRead, requested);
    }

    return toRead;
  }

  /**
   * Resets read and write pointers and clears contents.
   */
  public clear(): void {
    this.writeIndex = 0;
    this.readIndex = 0;
    this.availableFrames = 0;
    this.leftBuffer.fill(0);
    this.rightBuffer.fill(0);
  }
}
