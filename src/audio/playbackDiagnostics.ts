/**
 * Playback Lifecycle Diagnostic Instrumentation (M0 - M7 Checkpoints)
 *
 * Tracks application-owned allocated capacity, subsystem breakdowns, buffer credits,
 * and browser memory measurements without introducing large diagnostic buffers.
 */

export type CheckpointId = 'M0' | 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M7';

export interface AllocationBreakdown {
  ringBuffersBytes: number;
  stagingBuffersBytes: number;
  inFlightBuffersBytes: number;
  decoderScratchBytes: number;
  resamplerStateBytes: number;
  wasmHeapBytes: number;
  waveformPeaksBytes: number;
  totalAppOwnedBytes: number;
  totalAppOwnedMiB: number;
}

export interface PlaybackMetrics {
  outstandingRequests: number;
  bufferCreditsAvailable: number;
  pendingBlocksInFlight: number;
  ringAvailableFrames: number[];
  underrunCount: number;
  projectFrame: number;
}

export interface BrowserMemoryObservation {
  jsHeapUsedBytes: number | 'UNAVAILABLE';
  rssBytes: number | 'UNAVAILABLE';
  status: 'MEASURED' | 'UNAVAILABLE';
  note: string;
}

export interface DiagnosticCheckpoint {
  checkpointId: CheckpointId;
  label: string;
  timestampMs: number;
  trackIndex?: number;
  trackCount: number;
  allocations: AllocationBreakdown;
  metrics: PlaybackMetrics;
  browserMemory: BrowserMemoryObservation;
}

export class PlaybackLifecycleDiagnostics {
  private static instance: PlaybackLifecycleDiagnostics | null = null;
  private maxRingEntries = 50;
  private ring: DiagnosticCheckpoint[] = [];
  private ringIdx = 0;
  private totalRecorded = 0;

  // Subsystem accounting constants & live state
  private activeTracksCount = 0;
  private sampleRate = 48000;
  private ringDurationSec = 6.0;
  private stagingDurationSec = 1.0;
  private numChannels = 2;
  private bytesPerSample = 4; // Float32

  // WASM linear heaps
  private wasmHeapBytesPerTrack = [0, 0, 0, 0];

  // Waveform peak arrays (compact 600 bins * 2 * 4 bytes = 4,800 bytes per track)
  private waveformBytesPerTrack = [0, 0, 0, 0];

  // Runtime queues & credits
  private bufferCredits = [1, 1, 1, 1];
  private inFlightBuffers = [0, 0, 0, 0];
  private ringAvailableFrames = [0, 0, 0, 0];
  private underrunCount = 0;
  private projectFrame = 0;

  private constructor() {}

  public static getInstance(): PlaybackLifecycleDiagnostics {
    if (!PlaybackLifecycleDiagnostics.instance) {
      PlaybackLifecycleDiagnostics.instance = new PlaybackLifecycleDiagnostics();
    }
    return PlaybackLifecycleDiagnostics.instance;
  }

  public reset(): void {
    this.ring = [];
    this.ringIdx = 0;
    this.totalRecorded = 0;
    this.activeTracksCount = 0;
    this.wasmHeapBytesPerTrack = [0, 0, 0, 0];
    this.waveformBytesPerTrack = [0, 0, 0, 0];
    this.bufferCredits = [1, 1, 1, 1];
    this.inFlightBuffers = [0, 0, 0, 0];
    this.ringAvailableFrames = [0, 0, 0, 0];
    this.underrunCount = 0;
    this.projectFrame = 0;
  }

  public setSampleRate(sr: number): void {
    this.sampleRate = sr;
  }

  public setTrackWaveform(trackIndex: number, numBins: number): void {
    if (trackIndex >= 0 && trackIndex < 4) {
      this.waveformBytesPerTrack[trackIndex] = numBins * 2 * 4;
    }
  }

  public setTrackWasmHeap(trackIndex: number, bytes: number): void {
    if (trackIndex >= 0 && trackIndex < 4) {
      this.wasmHeapBytesPerTrack[trackIndex] = bytes;
    }
  }

  public updateRuntimeMetrics(
    credits: number[],
    inFlight: number[],
    availableFrames: number[],
    underruns: number,
    frame: number
  ): void {
    this.bufferCredits = [...credits];
    this.inFlightBuffers = [...inFlight];
    this.ringAvailableFrames = [...availableFrames];
    this.underrunCount = underruns;
    this.projectFrame = frame;
  }

  public computeAllocations(trackCount: number): AllocationBreakdown {
    const ringFrames = Math.floor(this.sampleRate * this.ringDurationSec);
    const stagingFrames = Math.floor(this.sampleRate * this.stagingDurationSec);

    // 1. Ring buffers: 4 tracks x 2 channels x ringFrames x 4 bytes
    const ringBuffersBytes = 4 * this.numChannels * ringFrames * this.bytesPerSample;

    // 2. Staging pool: 4 tracks x 1 buffer x 2 channels x stagingFrames x 4 bytes
    const stagingBuffersBytes = 4 * this.numChannels * stagingFrames * this.bytesPerSample;

    // 3. In-flight transferable buffers (subset of staging buffers, not double-counted in total)
    const activeInFlightCount = this.inFlightBuffers.reduce((a, b) => a + b, 0);
    const inFlightBuffersBytes = activeInFlightCount * this.numChannels * stagingFrames * this.bytesPerSample;

    // 4. Decoder scratch: 1-second WAV slice (48,000 frames x 6 bytes for 24-bit stereo = 288,000 bytes per active track)
    const decoderScratchBytes = trackCount * (stagingFrames * 6);

    // 5. Resampler Kaiser polyphase filter tables + history: 4 tracks x 8,192 bytes
    const resamplerStateBytes = 4 * (4096 * 4 + 64 * 4 * 2); // 4 * 8,704 = 34,816 bytes

    // 6. WASM heap linear memory
    const wasmHeapBytes = this.wasmHeapBytesPerTrack.slice(0, trackCount).reduce((a, b) => a + b, 0);

    // 7. Waveform peak data
    const waveformPeaksBytes = this.waveformBytesPerTrack.slice(0, trackCount).reduce((a, b) => a + b, 0);

    const totalAppOwnedBytes =
      ringBuffersBytes +
      stagingBuffersBytes +
      decoderScratchBytes +
      resamplerStateBytes +
      wasmHeapBytes +
      waveformPeaksBytes;

    return {
      ringBuffersBytes,
      stagingBuffersBytes,
      inFlightBuffersBytes,
      decoderScratchBytes,
      resamplerStateBytes,
      wasmHeapBytes,
      waveformPeaksBytes,
      totalAppOwnedBytes,
      totalAppOwnedMiB: Number((totalAppOwnedBytes / (1024 * 1024)).toFixed(3)),
    };
  }

  public readBrowserMemory(): BrowserMemoryObservation {
    // In Node.js environment (automated test runner)
    if (typeof process !== 'undefined' && process.memoryUsage) {
      const mem = process.memoryUsage();
      return {
        jsHeapUsedBytes: mem.heapUsed,
        rssBytes: mem.rss,
        status: 'MEASURED',
        note: 'Node.js test process memoryUsage()',
      };
    }

    // In browser: check if performance.memory exists (Chrome/Blink only)
    const perf = typeof window !== 'undefined' ? (window.performance as unknown as { memory?: { usedJSHeapSize?: number } }) : undefined;
    if (perf && perf.memory && typeof perf.memory.usedJSHeapSize === 'number') {
      return {
        jsHeapUsedBytes: perf.memory.usedJSHeapSize,
        rssBytes: 'UNAVAILABLE',
        status: 'MEASURED',
        note: 'Chromium performance.memory.usedJSHeapSize',
      };
    }

    // On iOS Safari 18.7: performance.memory is deliberately undefined in WebKit
    return {
      jsHeapUsedBytes: 'UNAVAILABLE',
      rssBytes: 'UNAVAILABLE',
      status: 'UNAVAILABLE',
      note: 'UNAVAILABLE: iOS Safari 18.7 does not support performance.memory (requires macOS Safari Web Inspector attached via cable)',
    };
  }

  public record(
    checkpointId: CheckpointId,
    label: string,
    trackCount: number,
    trackIndex?: number
  ): DiagnosticCheckpoint {
    this.activeTracksCount = trackCount;
    const allocations = this.computeAllocations(trackCount);
    const browserMemory = this.readBrowserMemory();

    const entry: DiagnosticCheckpoint = {
      checkpointId,
      label,
      timestampMs: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      trackIndex,
      trackCount,
      allocations,
      metrics: {
        outstandingRequests: this.inFlightBuffers.reduce((a, b) => a + b, 0),
        bufferCreditsAvailable: this.bufferCredits.reduce((a, b) => a + b, 0),
        pendingBlocksInFlight: this.inFlightBuffers.reduce((a, b) => a + b, 0),
        ringAvailableFrames: [...this.ringAvailableFrames],
        underrunCount: this.underrunCount,
        projectFrame: this.projectFrame,
      },
      browserMemory,
    };

    if (this.ring.length < this.maxRingEntries) {
      this.ring.push(entry);
    } else {
      this.ring[this.ringIdx] = entry;
      this.ringIdx = (this.ringIdx + 1) % this.maxRingEntries;
    }
    this.totalRecorded++;

    return entry;
  }

  public getRecentCheckpoints(): DiagnosticCheckpoint[] {
    if (this.ring.length < this.maxRingEntries) {
      return [...this.ring];
    }
    return [...this.ring.slice(this.ringIdx), ...this.ring.slice(0, this.ringIdx)];
  }

  public getLatest(checkpointId?: CheckpointId): DiagnosticCheckpoint | null {
    const list = this.getRecentCheckpoints();
    if (list.length === 0) return null;
    if (!checkpointId) return list[list.length - 1];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].checkpointId === checkpointId) return list[i];
    }
    return null;
  }
}
