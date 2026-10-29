/**
 * Streaming Mixer Controller
 *
 * Coordinates bounded-memory WAV slice fetching, sample-rate conversion,
 * transferable buffer pool, multi-output vs fallback routing, and telemetry.
 *
 * Employs zero-copy handoff across postMessage with single copy into ring buffer.
 * Enforces seekGeneration monotonic guards to discard stale decode blocks across seek boundaries.
 */

import { STREAMING_MIXER_PROCESSOR_CODE } from './streamingMixerProcessorCode';
import { readWavPcmSlice } from './boundedWavReader';
import { createResamplerState, resamplePcmBlock, type ResamplerState } from './resampler';
import { BoundedBufferPool, calculatePcmWorkingMemory, type ItemizedMemoryEstimate } from './bufferPool';
import { parseWavHeader, type ParsedWavHeader } from './wavParser';
import {
  type ICompressedStreamDecoder,
  MpegStreamDecoder,
  AacStreamDecoder,
  parseMp3Frames,
  parseAdtsFrames,
} from './decoders/compressedDecoder';

export class HotSwapDecodeError extends Error {
  public readonly trackIndex: number;
  public readonly reason: string;
  public readonly originalError?: unknown;

  constructor(trackIndex: number, reason: string, originalError?: unknown) {
    super(`HotSwapDecodeError on track ${trackIndex}: ${reason}`);
    this.name = 'HotSwapDecodeError';
    this.trackIndex = trackIndex;
    this.reason = reason;
    this.originalError = originalError;
  }
}

export interface StreamingTrackSource {
  id: string;
  index: number;
  blob: Blob | null;
  header: ParsedWavHeader | null;
  format?: 'wav' | 'mp3' | 'aac' | null;
  decoder?: ICompressedStreamDecoder | null;
  active: boolean;
  sourceReadFrame: number;
  resamplerState: ResamplerState | null;
  ringAvailableFrames: number;
}

export interface StreamingMixerTelemetry {
  p99BatchMs: number;
  rtfBatch: number;
  p99RefillMs: number;
  totalUnderruns: number;
  workingMemoryMebibytes: number;
  routingMode: 'multi-output' | 'single-output-fallback';
  seekGeneration: number;
  ringCopyUs: number;
}

export interface StreamingMixerCallbacks {
  onTimeUpdate: (timeSec: number, projectFrame: number) => void;
  onUnderrun: (trackIndex: number, projectFrame: number) => void;
  onTelemetryUpdate?: (telemetry: StreamingMixerTelemetry) => void;
}

export class StreamingMixerController {
  private ctx: AudioContext;
  private workletNode: AudioWorkletNode | null = null;
  private isInitialized = false;
  private isPlaying = false;
  private isFallback = false;

  // Fallback 1-output/8-channel routing nodes
  private splitterNode: ChannelSplitterNode | null = null;
  private trackMergers: ChannelMergerNode[] = [];

  private tracks: StreamingTrackSource[] = [];
  private bufferPool: BoundedBufferPool;

  private refillTimerId: number | null = null;
  private callbacks: StreamingMixerCallbacks;

  // Per-track monotonic seek generation guards
  private trackSeekGenerations: number[] = [0, 0, 0, 0];
  private currentProjectFrame = 0;

  // Latency & Real-Time Factor Telemetry
  private batchLatencies: number[] = [];
  private refillLatencies: number[] = [];
  private ringCopyLatenciesUs: number[] = [];
  private totalUnderruns = 0;

  // Configuration Constants
  public readonly ringDurationSec = 6.0;
  public readonly stagingDurationSec = 1.0;
  public readonly lowWaterSec = 2.0;
  public readonly targetBufferSec = 5.0;

  constructor(ctx: AudioContext, trackIds: string[], callbacks: StreamingMixerCallbacks) {
    this.ctx = ctx;
    this.callbacks = callbacks;

    const sampleRate = ctx.sampleRate || 48000;
    const stagingFrames = Math.floor(sampleRate * this.stagingDurationSec);

    // Initialize 4 tracks
    for (let i = 0; i < 4; i++) {
      const id = trackIds[i] || `track-${i + 1}`;
      this.tracks.push({
        id,
        index: i,
        blob: null,
        header: null,
        format: null,
        decoder: null,
        active: false,
        sourceReadFrame: 0,
        resamplerState: null,
        ringAvailableFrames: 0,
      });
    }

    this.bufferPool = new BoundedBufferPool(
      this.tracks.map(t => t.id),
      stagingFrames,
      1 // max 1 in-flight staging buffer per track (S_track <= 1, S_total <= 4)
    );
  }

  /**
   * Functional DC-offset probe for multi-output AudioWorklet support in WebKit / Safari (Task C).
   * Renders 1 quantum with distinct DC offsets on outputs 0..3 for both Left and Right channels:
   * Out 0: [0.10, 0.15], Out 1: [0.20, 0.25], Out 2: [0.30, 0.35], Out 3: [0.40, 0.45].
   * Routes through 4 ChannelSplitterNode(2) instances into ChannelMergerNode(8) to ensure
   * neither channel is silent, clamped, or downmixed.
   */
  public static async probeMultiOutput(ctx: AudioContext): Promise<boolean> {
    if (typeof window === 'undefined') return false;

    const OfflineCtxClass =
      window.OfflineAudioContext ||
      (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;

    if (!OfflineCtxClass) {
      console.warn('[MultiOutputProbe] OfflineAudioContext unavailable; defaulting to fallback');
      return false;
    }

    try {
      const sampleRate = ctx.sampleRate || 48000;
      const probeCtx = new OfflineCtxClass(8, 128, sampleRate);

      const probeCode = `
class MultiOutputProbeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rendered = false;
  }
  process(inputs, outputs) {
    if (!this.rendered) {
      for (let i = 0; i < Math.min(4, outputs.length); i++) {
        const valL = 0.10 * (i + 1);
        const valR = 0.10 * (i + 1) + 0.05;
        if (outputs[i] && outputs[i][0]) outputs[i][0].fill(valL);
        if (outputs[i] && outputs[i][1]) outputs[i][1].fill(valR);
      }
      this.rendered = true;
    }
    return true;
  }
}
registerProcessor('multi-output-probe-processor', MultiOutputProbeProcessor);
`;
      const blob = new Blob([probeCode], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      try {
        await probeCtx.audioWorklet.addModule(blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }

      const probeNode = new AudioWorkletNode(probeCtx, 'multi-output-probe-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 4,
        outputChannelCount: [2, 2, 2, 2],
      });

      if (probeNode.numberOfOutputs < 4) {
        console.warn(`[MultiOutputProbe] Failed: node instantiated with only ${probeNode.numberOfOutputs} outputs`);
        return false;
      }

      const merger = probeCtx.createChannelMerger(8);

      // Route each stereo output through a 2-channel splitter into discrete merger inputs
      // to avoid mono downmixing and verify both Left and Right channels
      for (let i = 0; i < 4; i++) {
        const splitter = probeCtx.createChannelSplitter(2);
        probeNode.connect(splitter, i, 0);
        splitter.connect(merger, 0, i * 2);     // Left channel -> Merger 2*i
        splitter.connect(merger, 1, i * 2 + 1); // Right channel -> Merger 2*i + 1
      }

      merger.connect(probeCtx.destination);

      const rendered = await probeCtx.startRendering();

      // Validate all 8 channels across all 4 stereo outputs
      const expected = [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45];
      for (let ch = 0; ch < 8; ch++) {
        const data = rendered.getChannelData(ch);
        const readVal = data[0];
        if (Math.abs(readVal - expected[ch]) > 0.02) {
          const outIdx = Math.floor(ch / 2);
          const chName = ch % 2 === 0 ? 'Left' : 'Right';
          console.warn(
            `[MultiOutputProbe] MULTI_OUTPUT_UNSUPPORTED: Output ${outIdx} ${chName} channel expected DC ${expected[ch]}, read ${readVal}`
          );
          return false;
        }
      }

      return true;
    } catch (err) {
      console.warn('[MultiOutputProbe] MULTI_OUTPUT_UNSUPPORTED: Probe threw exception:', err);
      return false;
    }
  }

  /**
   * Initializes the AudioWorklet module and constructs the routing graph.
   * If forceFallback is true or if multi-output is rejected by the browser,
   * falls back to 1 output with 8 channels routed through ChannelSplitterNode.
   */
  public async init(options?: { forceFallback?: boolean }): Promise<boolean> {
    if (this.isInitialized && this.workletNode) return true;

    try {
      // 1. Try loading worklet script from static public URL
      let loaded = false;
      try {
        await this.ctx.audioWorklet.addModule('/worklets/streaming-mixer-processor.js');
        loaded = true;
      } catch (err) {
        console.warn('Static worklet script load failed, falling back to Blob URL:', err);
      }

      // 2. Fallback to Blob URL if static file failed or running under constrained origin
      if (!loaded) {
        const blob = new Blob([STREAMING_MIXER_PROCESSOR_CODE], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        try {
          await this.ctx.audioWorklet.addModule(blobUrl);
          loaded = true;
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
      }

      const sampleRate = this.ctx.sampleRate;
      const ringCapacity = Math.floor(sampleRate * this.ringDurationSec);

      // Determine routing mode
      let useFallback = !!options?.forceFallback;
      if (!useFallback) {
        const canMulti = await StreamingMixerController.probeMultiOutput(this.ctx);
        if (!canMulti) {
          useFallback = true;
        }
      }

      this.isFallback = useFallback;

      if (this.isFallback) {
        // Fallback Mode: 1 output with 8 channels fanned out via ChannelSplitter
        this.workletNode = new AudioWorkletNode(this.ctx, 'streaming-mixer', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [8],
        });

        this.splitterNode = this.ctx.createChannelSplitter(8);
        this.workletNode.connect(this.splitterNode);

        this.trackMergers = [];
        for (let i = 0; i < 4; i++) {
          const merger = this.ctx.createChannelMerger(2);
          this.splitterNode.connect(merger, i * 2, 0); // Left channel
          this.splitterNode.connect(merger, i * 2 + 1, 1); // Right channel
          this.trackMergers.push(merger);
        }
      } else {
        // Multi-Output Mode: 4 discrete stereo outputs
        this.workletNode = new AudioWorkletNode(this.ctx, 'streaming-mixer', {
          numberOfInputs: 0,
          numberOfOutputs: 4,
          outputChannelCount: [2, 2, 2, 2],
        });
      }

      this.workletNode.port.onmessage = this.handleWorkletMessage.bind(this);

      // Send initial configuration to worklet
      this.workletNode.port.postMessage({
        type: 'init',
        sampleRate,
        ringCapacity,
      });

      this.isInitialized = true;
      this.startRefillLoop();
      return true;
    } catch (err) {
      console.error('StreamingMixerController init failed:', err);
      return false;
    }
  }

  /**
   * Connects a track's stereo audio stream to the given destination node,
   * abstracting multi-output vs fallback single-output topologies.
   */
  public connectTrackOutput(trackIndex: number, destination: AudioNode): void {
    if (this.isFallback) {
      if (this.trackMergers[trackIndex]) {
        this.trackMergers[trackIndex].connect(destination);
      }
    } else if (this.workletNode) {
      this.workletNode.connect(destination, trackIndex, 0);
    }
  }

  public isFallbackMode(): boolean {
    return this.isFallback;
  }

  public getRoutingMode(): 'multi-output' | 'single-output-fallback' {
    return this.isFallback ? 'single-output-fallback' : 'multi-output';
  }

  public getSeekGeneration(trackIndex?: number): number {
    if (trackIndex !== undefined && trackIndex >= 0 && trackIndex < 4) {
      return this.trackSeekGenerations[trackIndex];
    }
    return Math.max(...this.trackSeekGenerations);
  }

  public getWorkletNode(): AudioWorkletNode | null {
    return this.workletNode;
  }

  /**
   * Sets or updates audio source for a given track index (0 to 3)
   */
  public setTrackSource(index: number, blob: Blob | null, header: ParsedWavHeader | null): void {
    if (index < 0 || index >= 4) return;
    const t = this.tracks[index];
    t.blob = blob;
    t.header = header;
    t.active = !!(blob && header);
    t.sourceReadFrame = 0;
    t.ringAvailableFrames = 0;

    if (header) {
      t.resamplerState = createResamplerState(header.sampleRate, this.ctx.sampleRate);
    } else {
      t.resamplerState = null;
    }

    if (this.workletNode) {
      this.workletNode.port.postMessage({
        type: 'set-active-tracks',
        activeTracks: this.tracks.map(trk => trk.active),
      });
    }
  }

  /**
   * Starts or resumes playback
   */
  public play(startOffsetSec = 0): void {
    if (!this.workletNode) return;
    this.isPlaying = true;

    const sampleRate = this.ctx.sampleRate;
    const startProjectFrame = Math.floor(startOffsetSec * sampleRate);

    this.workletNode.port.postMessage({
      type: 'set-playing',
      isPlaying: true,
      projectFrame: startProjectFrame,
    });
  }

  /**
   * Pauses playback
   */
  public pause(): void {
    if (!this.workletNode) return;
    this.isPlaying = false;
    this.workletNode.port.postMessage({
      type: 'set-playing',
      isPlaying: false,
    });
  }

  /**
   * Seeks to a project time in seconds, increments per-track seekGenerations,
   * clears ring buffers, resets buffer pool credits, and resets resampler states.
   */
  public seek(timeSec: number): void {
    if (!this.workletNode) return;

    // Increment per-track monotonic seek generations to invalidate in-flight tasks
    for (let i = 0; i < 4; i++) {
      this.trackSeekGenerations[i]++;
    }

    const sampleRate = this.ctx.sampleRate;
    const targetProjectFrame = Math.floor(timeSec * sampleRate);

    // Reset buffer pool and track source read positions
    this.bufferPool.resetAll();

    for (const t of this.tracks) {
      t.ringAvailableFrames = 0;
      if (t.header) {
        const srcRatio = t.header.sampleRate / sampleRate;
        t.sourceReadFrame = Math.min(
          t.header.totalSampleFrames,
          Math.floor(targetProjectFrame * srcRatio)
        );
        t.resamplerState = createResamplerState(t.header.sampleRate, sampleRate);
      }
    }

    this.workletNode.port.postMessage({
      type: 'seek',
      projectFrame: targetProjectFrame,
      seekGeneration: Math.max(...this.trackSeekGenerations),
      trackSeekGenerations: [...this.trackSeekGenerations],
    });

    // Immediately trigger background refill so ring buffers repopulate without 50ms scheduling delay
    void this.refillActiveTracks();
  }

  /**
   * Seeks an individual track without invalidating or interrupting other tracks.
   */
  public seekTrack(trackIndex: number, timeSec: number): void {
    if (!this.workletNode || trackIndex < 0 || trackIndex >= 4) return;

    this.trackSeekGenerations[trackIndex]++;
    const track = this.tracks[trackIndex];
    const sampleRate = this.ctx.sampleRate;
    const targetProjectFrame = Math.floor(timeSec * sampleRate);

    // Flush only this track's staging buffer credits
    this.bufferPool.flushTrack(track.id);
    track.ringAvailableFrames = 0;

    if (track.header) {
      const srcRatio = track.header.sampleRate / sampleRate;
      track.sourceReadFrame = Math.min(
        track.header.totalSampleFrames,
        Math.floor(targetProjectFrame * srcRatio)
      );
      track.resamplerState = createResamplerState(track.header.sampleRate, sampleRate);
    }

    this.workletNode.port.postMessage({
      type: 'seek-track',
      trackIndex,
      seekGeneration: this.trackSeekGenerations[trackIndex],
    });

    void this.refillActiveTracks();
  }

  public getCurrentProjectFrame(): number {
    return this.currentProjectFrame;
  }

  /**
   * Replaces an individual track's audio source during active playback without stopping continuing tracks (Phase 2.C).
   * Applies 3 ms equal-power crossfade (cos fade-out, sin fade-in), per-track seekGeneration increment,
   * isolation of continuing tracks, and typed HotSwapDecodeError handling.
   */
  public async replaceTrack(trackIndex: number, newBlob: Blob): Promise<void> {
    if (trackIndex < 0 || trackIndex >= 4) {
      throw new Error(`Invalid trackIndex ${trackIndex}: must be between 0 and 3`);
    }

    const track = this.tracks[trackIndex];
    const sampleRate = this.ctx.sampleRate;

    // 1. Advance single-track seek generation to isolate and drop stale decode blocks
    this.trackSeekGenerations[trackIndex]++;
    const targetGen = this.trackSeekGenerations[trackIndex];

    // 2. Instruct worklet to apply 3ms equal-power cosine fade-out to outgoing track audio
    if (this.workletNode) {
      this.workletNode.port.postMessage({
        type: 'replace-track',
        trackIndex,
        seekGeneration: targetGen,
      });
    }

    // 3. Flush buffer pool staging credits for this track
    this.bufferPool.flushTrack(track.id);
    track.ringAvailableFrames = 0;

    // 4. Dispose old decoder (Design Path A: dispose-and-recreate, maintaining <= 77.534 MiB)
    if (track.decoder) {
      try {
        track.decoder.free();
      } catch {
        // ignore
      }
      track.decoder = null;
    }
    track.header = null;
    track.resamplerState = null;

    // 5. Read blob and validate format/header
    let rawBytes: Uint8Array;
    try {
      const arrayBuf = await newBlob.arrayBuffer();
      rawBytes = new Uint8Array(arrayBuf);
    } catch (err: unknown) {
      track.active = false;
      throw new HotSwapDecodeError(trackIndex, 'Failed to read Blob arrayBuffer', err);
    }

    if (rawBytes.length < 16) {
      track.active = false;
      throw new HotSwapDecodeError(trackIndex, `Corrupted or truncated file: length ${rawBytes.length} < 16 bytes`);
    }

    // Format detection
    const isWav = rawBytes[0] === 0x52 && rawBytes[1] === 0x49 && rawBytes[2] === 0x46 && rawBytes[3] === 0x46; // RIFF
    const isMp3 = (rawBytes[0] === 0x49 && rawBytes[1] === 0x44 && rawBytes[2] === 0x33) ||
                  (rawBytes[0] === 0xFF && (rawBytes[1] & 0xE0) === 0xE0);
    const isAac = (rawBytes.length >= 8 && rawBytes[4] === 0x66 && rawBytes[5] === 0x74 && rawBytes[6] === 0x79 && rawBytes[7] === 0x70) ||
                  (rawBytes[0] === 0xFF && (rawBytes[1] & 0xF6) === 0xF0);

    let decodedLeft: Float32Array;
    let decodedRight: Float32Array;
    let decodedCount = 0;

    try {
      if (isWav) {
        track.format = 'wav';
        const parsedHeader = parseWavHeader(rawBytes.buffer.slice(0) as ArrayBuffer);
        track.header = parsedHeader;
        track.resamplerState = createResamplerState(parsedHeader.sampleRate, sampleRate);
        track.blob = newBlob;

        const currentFrame = this.currentProjectFrame || 0;
        const srcRatio = parsedHeader.sampleRate / sampleRate;
        track.sourceReadFrame = Math.min(
          parsedHeader.totalSampleFrames,
          Math.floor(currentFrame * srcRatio)
        );

        const preRollFrames = Math.floor(sampleRate * 0.25);
        const sourceNeeded = Math.ceil(preRollFrames * srcRatio) + 4;
        const slice = await readWavPcmSlice(newBlob, parsedHeader, track.sourceReadFrame, sourceNeeded);
        track.sourceReadFrame += slice.framesRead;

        const resampled = resamplePcmBlock(
          slice.left,
          slice.right,
          slice.framesRead,
          preRollFrames,
          track.resamplerState
        );
        decodedLeft = resampled.outL;
        decodedRight = resampled.outR;
        decodedCount = preRollFrames;
      } else if (isMp3) {
        track.format = 'mp3';
        parseMp3Frames(rawBytes);
        const decoder = new MpegStreamDecoder();
        await decoder.ready;
        track.decoder = decoder;
        track.blob = newBlob;

        const res = await decoder.decode(rawBytes);
        decodedLeft = res.left;
        decodedRight = res.right;
        decodedCount = res.samplesDecoded;
      } else if (isAac) {
        track.format = 'aac';
        parseAdtsFrames(rawBytes);
        const decoder = new AacStreamDecoder();
        await decoder.ready;
        track.decoder = decoder;
        track.blob = newBlob;

        const res = await decoder.decode(rawBytes);
        decodedLeft = res.left;
        decodedRight = res.right;
        decodedCount = res.samplesDecoded;
      } else {
        throw new Error('Unrecognized or corrupted audio format');
      }
    } catch (err: unknown) {
      track.active = false;
      if (track.decoder) {
        track.decoder.free();
        track.decoder = null;
      }
      if (this.workletNode) {
        this.workletNode.port.postMessage({
          type: 'set-active-tracks',
          activeTracks: this.tracks.map(t => t.active),
        });
      }
      throw new HotSwapDecodeError(trackIndex, (err as Error)?.message || 'Decode error during hot-swap', err);
    }

    // 6. Apply 3 ms equal-power sine fade-in to the incoming audio
    const fadeLen = Math.min(144, decodedCount);
    for (let i = 0; i < fadeLen; i++) {
      const gain = Math.sin((Math.PI / 2) * (i / 144));
      decodedLeft[i] *= gain;
      decodedRight[i] *= gain;
    }

    // 7. Acquire staging buffer and transfer pre-roll into worklet ring buffer
    const staging = this.bufferPool.acquire(track.id);
    if (staging && this.workletNode) {
      const framesToSend = Math.min(decodedCount, staging.leftView.length);
      staging.leftView.subarray(0, framesToSend).set(decodedLeft.subarray(0, framesToSend));
      staging.rightView.subarray(0, framesToSend).set(decodedRight.subarray(0, framesToSend));

      this.bufferPool.markInFlight(staging.id);
      this.workletNode.port.postMessage(
        {
          type: 'append-pcm',
          trackIndex,
          bufferId: staging.id,
          frames: framesToSend,
          leftBuffer: staging.leftBuffer,
          rightBuffer: staging.rightBuffer,
          seekGeneration: targetGen,
        },
        [staging.leftBuffer, staging.rightBuffer]
      );
      track.ringAvailableFrames += framesToSend;
    }

    track.active = true;
    if (this.workletNode) {
      this.workletNode.port.postMessage({
        type: 'set-active-tracks',
        activeTracks: this.tracks.map(t => t.active),
      });
    }

    void this.refillActiveTracks();
  }

  /**
   * Handles incoming messages from the AudioWorkletProcessor
   */
  private handleWorkletMessage(event: MessageEvent): void {
    const data = event.data;
    if (!data) return;

    switch (data.type) {
      case 'position': {
        this.currentProjectFrame = data.projectFrame;
        this.callbacks.onTimeUpdate(data.timeSec, data.projectFrame);
        if (Array.isArray(data.trackRingLevels)) {
          for (let i = 0; i < 4; i++) {
            if (this.tracks[i]) {
              this.tracks[i].ringAvailableFrames = data.trackRingLevels[i] || 0;
            }
          }
        }
        break;
      }

      case 'underrun': {
        this.totalUnderruns++;
        this.callbacks.onUnderrun(data.trackIndex, data.projectFrame);
        break;
      }

      case 'buffer-consumed': {
        const { bufferId, trackIndex, ringAvailable, leftBuffer, rightBuffer } = data;
        if (trackIndex >= 0 && trackIndex < 4) {
          this.tracks[trackIndex].ringAvailableFrames = ringAvailable;
        }
        // Reclaim transferred ArrayBuffers into pool
        this.bufferPool.release(bufferId, leftBuffer, rightBuffer);
        break;
      }
    }
  }

  /**
   * Background refill scheduler
   */
  private startRefillLoop(): void {
    if (this.refillTimerId !== null) return;

    const interval = 50; // Check ring levels every 50ms
    const scheduleNext = () => {
      this.refillTimerId = window.setTimeout(async () => {
        const refillStart = performance.now();
        await this.refillActiveTracks();
        const refillDuration = performance.now() - refillStart;
        this.refillLatencies.push(refillDuration);
        if (this.refillLatencies.length > 100) this.refillLatencies.shift();

        scheduleNext();
      }, interval);
    };

    scheduleNext();
  }

  /**
   * Refills ring buffers for tracks that are below target refill capacity.
   * Discards stale decoded blocks if a seek occurred while reading the WAV slice.
   */
  public async refillActiveTracks(): Promise<void> {
    if (!this.workletNode) return;

    const sampleRate = this.ctx.sampleRate;
    const targetFrames = Math.floor(sampleRate * this.targetBufferSec);
    const stagingFrames = Math.floor(sampleRate * this.stagingDurationSec);

    for (const track of this.tracks) {
      if (!track.active || !track.blob || !track.header || !track.resamplerState) {
        continue;
      }

      // Check if ring buffer needs data
      if (track.ringAvailableFrames >= targetFrames) {
        continue;
      }

      // Check if track has available buffer pool credit
      if (!this.bufferPool.canAcquire(track.id)) {
        continue;
      }

      const staging = this.bufferPool.acquire(track.id);
      if (!staging) continue;

      // Tag request with track-specific seekGeneration
      const requestGen = this.trackSeekGenerations[track.index];
      const batchStart = performance.now();

      // Calculate how many source frames we need for 1.0 second of target audio
      const srcRatio = track.header.sampleRate / sampleRate;
      const sourceFramesNeeded = Math.ceil(stagingFrames * srcRatio) + 4; // lookahead for seamless interpolation

      try {
        const slice = await readWavPcmSlice(
          track.blob,
          track.header,
          track.sourceReadFrame,
          sourceFramesNeeded
        );

        // Guard: check if seek occurred while reading the disk slice
        if (requestGen !== this.trackSeekGenerations[track.index]) {
          // Discard stale decode block and release staging buffer back to pool
          this.bufferPool.release(staging.id);
          return;
        }

        track.sourceReadFrame += slice.framesRead;

        // Anti-aliasing Kaiser FIR resampling into target staging buffer
        const { outL, outR } = resamplePcmBlock(
          slice.left,
          slice.right,
          slice.framesRead,
          stagingFrames,
          track.resamplerState
        );

        // Measure ring-copy preparation performance
        const copyMarkStart = performance.now();
        staging.leftView.set(outL);
        staging.rightView.set(outR);
        const copyMarkDurationUs = (performance.now() - copyMarkStart) * 1000;
        this.ringCopyLatenciesUs.push(copyMarkDurationUs);
        if (this.ringCopyLatenciesUs.length > 100) this.ringCopyLatenciesUs.shift();

        // Mark in-flight and transfer buffers to AudioWorklet (zero-copy handoff across postMessage)
        this.bufferPool.markInFlight(staging.id);
        this.workletNode.port.postMessage(
          {
            type: 'append-pcm',
            trackIndex: track.index,
            bufferId: staging.id,
            frames: stagingFrames,
            leftBuffer: staging.leftBuffer,
            rightBuffer: staging.rightBuffer,
            seekGeneration: requestGen,
          },
          [staging.leftBuffer, staging.rightBuffer]
        );

        track.ringAvailableFrames += stagingFrames;

        const batchElapsed = performance.now() - batchStart;
        this.batchLatencies.push(batchElapsed);
        if (this.batchLatencies.length > 100) this.batchLatencies.shift();

        this.emitTelemetry();
      } catch (err) {
        console.error(`Refill error on track ${track.index}:`, err);
        this.bufferPool.release(staging.id);
      }
    }
  }

  /**
   * Computes P99 latencies, real-time factor, and itemized working memory stats
   */
  public getTelemetry(): StreamingMixerTelemetry {
    const sortedBatch = [...this.batchLatencies].sort((a, b) => a - b);
    const p99BatchMs = sortedBatch.length > 0
      ? sortedBatch[Math.floor(sortedBatch.length * 0.99)]
      : 0;

    const sortedRefill = [...this.refillLatencies].sort((a, b) => a - b);
    const p99RefillMs = sortedRefill.length > 0
      ? sortedRefill[Math.floor(sortedRefill.length * 0.99)]
      : 0;

    const pSec = this.stagingDurationSec;
    const rtfBatch = p99BatchMs > 0 ? pSec / (p99BatchMs / 1000) : 999;

    const sortedCopy = [...this.ringCopyLatenciesUs].sort((a, b) => a - b);
    const ringCopyUs = sortedCopy.length > 0
      ? sortedCopy[Math.floor(sortedCopy.length * 0.5)]
      : 0;

    const mem = calculatePcmWorkingMemory(4, this.ctx.sampleRate, this.ringDurationSec, this.stagingDurationSec);

    return {
      p99BatchMs,
      rtfBatch,
      p99RefillMs,
      totalUnderruns: this.totalUnderruns,
      workingMemoryMebibytes: mem.totalMebibytes,
      routingMode: this.getRoutingMode(),
      seekGeneration: Math.max(...this.trackSeekGenerations),
      ringCopyUs,
    };
  }

  public getItemizedMemory(): ItemizedMemoryEstimate {
    return calculatePcmWorkingMemory(4, this.ctx.sampleRate, this.ringDurationSec, this.stagingDurationSec);
  }

  private emitTelemetry(): void {
    if (this.callbacks.onTelemetryUpdate) {
      this.callbacks.onTelemetryUpdate(this.getTelemetry());
    }
  }

  public destroy(): void {
    if (this.refillTimerId !== null) {
      clearTimeout(this.refillTimerId);
      this.refillTimerId = null;
    }
    if (this.workletNode) {
      try {
        this.workletNode.disconnect();
      } catch {
        // ignore
      }
      this.workletNode = null;
    }
    if (this.splitterNode) {
      try {
        this.splitterNode.disconnect();
      } catch {
        // ignore
      }
      this.splitterNode = null;
    }
    for (const merger of this.trackMergers) {
      try {
        merger.disconnect();
      } catch {
        // ignore
      }
    }
    this.trackMergers = [];
    for (const t of this.tracks) {
      if (t.decoder) {
        try {
          t.decoder.free();
        } catch {
          // ignore
        }
        t.decoder = null;
      }
    }
    this.bufferPool.resetAll();
    this.isInitialized = false;
  }
}
