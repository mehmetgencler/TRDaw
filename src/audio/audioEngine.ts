/**
 * Real-Time Web Audio DSP Graph & Transport Engine
 * Full iOS Safari touch-unlock & cross-browser Chrome support.
 */

import { dbToGain, clamp } from './math';
import type { TrackData, MasterState } from '../types/audio';
import { StreamingMixerController, type StreamingMixerTelemetry } from './streamingMixerController';
import type { ParsedWavHeader } from './wavParser';

export interface AudioEngineCallbacks {
  onTimeUpdate: (time: number) => void;
  onMeterUpdate: (trackMeters: Array<{ id: string; peakL: number; peakR: number; gr: number }>, masterMeter: { peakL: number; peakR: number }) => void;
  onEnded: () => void;
  onStateChange: (state: AudioContextState) => void;
  onTelemetryUpdate?: (telemetry: StreamingMixerTelemetry) => void;
}

interface TrackNodes {
  source: AudioBufferSourceNode | null;
  audioElement: HTMLAudioElement | null;
  mediaSourceNode: MediaElementAudioSourceNode | null;
  eqLow: BiquadFilterNode;
  eqMid: BiquadFilterNode;
  eqHigh: BiquadFilterNode;
  compressor: DynamicsCompressorNode;
  panner: StereoPannerNode;
  faderGain: GainNode;
  reverbSendGain: GainNode;
  analyser: AnalyserNode;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterSum: GainNode | null = null;
  private masterEqLow: BiquadFilterNode | null = null;
  private masterEqMid: BiquadFilterNode | null = null;
  private masterEqHigh: BiquadFilterNode | null = null;
  private masterLimiter: DynamicsCompressorNode | null = null;
  private masterFader: GainNode | null = null;
  private masterAnalyser: AnalyserNode | null = null;

  // Reverb bus
  private reverbConvolver: ConvolverNode | null = null;
  private reverbReturnGain: GainNode | null = null;

  private trackNodesMap = new Map<string, TrackNodes>();
  private streamingController: StreamingMixerController | null = null;
  private workletConnectedTracks = new Set<string>();

  private isPlaying = false;
  private startTime = 0;       // AudioContext time when current playback segment started
  private pauseOffset = 0;     // Song position in seconds where playback was started
  private duration = 16.0;
  private isLooping = false;
  private loopStart = 0;
  private loopEnd = 16.0;

  private masterSyncElement: HTMLAudioElement | null = null;
  private activeMediaElements: HTMLAudioElement[] = [];

  private meterRafId: number | null = null;
  private callbacks: AudioEngineCallbacks;

  constructor(callbacks: AudioEngineCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Initializes or resumes the AudioContext on user gesture (iOS Safari requirement)
   */
  public async initContext(): Promise<boolean> {
    if (!this.ctx) {
      const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtxClass({
        latencyHint: 'interactive',
      });

      this.ctx.onstatechange = () => {
        if (this.ctx) {
          this.callbacks.onStateChange(this.ctx.state);
        }
      };

      this.setupMasterGraph();
    }

    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch (err) {
        console.warn('AudioContext resume failed:', err);
      }
    }

    if (!this.streamingController && this.ctx) {
      try {
        this.streamingController = new StreamingMixerController(
          this.ctx,
          ['track-1', 'track-2', 'track-3', 'track-4'],
          {
            onTimeUpdate: (timeSec) => {
              if (this.isPlaying) {
                this.callbacks.onTimeUpdate(timeSec);
              }
            },
            onUnderrun: (trackIndex, projectFrame) => {
              console.warn(`[AudioEngine] Synchronized worklet underrun on track ${trackIndex} at frame ${projectFrame}`);
            },
            onTelemetryUpdate: (telemetry) => {
              if (this.callbacks.onTelemetryUpdate) {
                this.callbacks.onTelemetryUpdate(telemetry);
              }
            },
          }
        );
        await this.streamingController.init();
      } catch (err) {
        console.warn('StreamingMixerController init warning:', err);
      }
    }

    this.callbacks.onStateChange(this.ctx.state);
    return this.ctx.state === 'running';
  }

  public getContextState(): AudioContextState {
    return this.ctx ? this.ctx.state : 'suspended';
  }

  /**
   * Constructs the Master Summing, Reverb, EQ, Limiter, and Analyser Nodes
   */
  private setupMasterGraph(): void {
    if (!this.ctx) return;

    this.masterSum = this.ctx.createGain();

    // Reverb send/return architecture
    this.reverbConvolver = this.ctx.createConvolver();
    this.updateReverbImpulse(1.8); // 1.8s default decay
    this.reverbReturnGain = this.ctx.createGain();
    this.reverbReturnGain.gain.value = 0.5;

    // Connect convolver -> return gain -> master sum
    this.reverbConvolver.connect(this.reverbReturnGain);
    this.reverbReturnGain.connect(this.masterSum);

    // Master EQ
    this.masterEqLow = this.ctx.createBiquadFilter();
    this.masterEqLow.type = 'lowshelf';
    this.masterEqLow.frequency.value = 100;
    this.masterEqLow.gain.value = 0;

    this.masterEqMid = this.ctx.createBiquadFilter();
    this.masterEqMid.type = 'peaking';
    this.masterEqMid.frequency.value = 1000;
    this.masterEqMid.Q.value = 0.7;
    this.masterEqMid.gain.value = 0;

    this.masterEqHigh = this.ctx.createBiquadFilter();
    this.masterEqHigh.type = 'highshelf';
    this.masterEqHigh.frequency.value = 8000;
    this.masterEqHigh.gain.value = 0;

    // Master Brickwall Limiter
    this.masterLimiter = this.ctx.createDynamicsCompressor();
    this.masterLimiter.threshold.value = -0.5; // -0.5 dB
    this.masterLimiter.knee.value = 0.0;       // hard knee
    this.masterLimiter.ratio.value = 20.0;     // brickwall limiting
    this.masterLimiter.attack.value = 0.002;   // 2ms attack
    this.masterLimiter.release.value = 0.05;   // 50ms release

    // Master Fader Gain
    this.masterFader = this.ctx.createGain();
    this.masterFader.gain.value = 1.0;

    // Master Analyser
    this.masterAnalyser = this.ctx.createAnalyser();
    this.masterAnalyser.fftSize = 256;
    this.masterAnalyser.smoothingTimeConstant = 0.8;

    // Route: masterSum -> eqLow -> eqMid -> eqHigh -> limiter -> fader -> analyser -> destination
    this.masterSum
      .connect(this.masterEqLow)
      .connect(this.masterEqMid)
      .connect(this.masterEqHigh)
      .connect(this.masterLimiter)
      .connect(this.masterFader)
      .connect(this.masterAnalyser)
      .connect(this.ctx.destination);
  }

  /**
   * Synthesizes an algorithmic impulse response for the convolver reverb
   */
  public updateReverbImpulse(decaySec: number): void {
    if (!this.ctx || !this.reverbConvolver) return;
    const rate = this.ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * clamp(decaySec, 0.2, 5.0)));
    const impulse = this.ctx.createBuffer(2, length, rate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);

    for (let i = 0; i < length; i++) {
      const t = i / length;
      // Exponential decay envelope
      const env = Math.exp(-t * (4 + (1 / decaySec)));
      left[i] = (Math.random() * 2 - 1) * env;
      right[i] = (Math.random() * 2 - 1) * env;
    }

    this.reverbConvolver.buffer = impulse;
  }

  /**
   * Creates or updates the DSP graph nodes for a track
   */
  public setupTrackNodes(track: TrackData): void {
    if (!this.ctx || !this.masterSum || !this.reverbConvolver) return;

    let nodes = this.trackNodesMap.get(track.id);
    if (!nodes) {
      const eqLow = this.ctx.createBiquadFilter();
      eqLow.type = 'lowshelf';
      eqLow.frequency.value = 100;

      const eqMid = this.ctx.createBiquadFilter();
      eqMid.type = 'peaking';
      eqMid.frequency.value = track.eq.midFreq;
      eqMid.Q.value = 1.0;

      const eqHigh = this.ctx.createBiquadFilter();
      eqHigh.type = 'highshelf';
      eqHigh.frequency.value = 8000;

      const compressor = this.ctx.createDynamicsCompressor();
      compressor.threshold.value = track.compressor.threshold;
      compressor.ratio.value = track.compressor.ratio;
      compressor.attack.value = track.compressor.attack;
      compressor.release.value = track.compressor.release;

      const panner = this.ctx.createStereoPanner();
      panner.pan.value = track.pan;

      const faderGain = this.ctx.createGain();
      const reverbSendGain = this.ctx.createGain();
      reverbSendGain.gain.value = track.reverbSend;

      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.7;

      // Connect DSP chain:
      // [eqLow] -> [eqMid] -> [eqHigh] -> [compressor] -> [panner] -> [faderGain] -> [masterSum] & [analyser]
      //                                                            \-> [reverbSendGain] -> [reverbConvolver]
      eqLow
        .connect(eqMid)
        .connect(eqHigh)
        .connect(compressor)
        .connect(panner);

      panner.connect(faderGain);
      faderGain.connect(this.masterSum);
      faderGain.connect(analyser);

      panner.connect(reverbSendGain);
      reverbSendGain.connect(this.reverbConvolver);

      nodes = {
        source: null,
        audioElement: null,
        mediaSourceNode: null,
        eqLow,
        eqMid,
        eqHigh,
        compressor,
        panner,
        faderGain,
        reverbSendGain,
        analyser,
      };

      this.trackNodesMap.set(track.id, nodes);
    }

    // Connect AudioWorklet output if streamingController is initialized
    if (this.streamingController) {
      const trackIndex = ['track-1', 'track-2', 'track-3', 'track-4'].indexOf(track.id);
      if (trackIndex >= 0 && !this.workletConnectedTracks.has(track.id)) {
        try {
          this.streamingController.connectTrackOutput(trackIndex, nodes.eqLow);
          this.workletConnectedTracks.add(track.id);
        } catch (err) {
          console.warn(`Worklet routing connect error on ${track.id}:`, err);
        }
      }

      // Enforce single playback engine: disconnect and purge any legacy media elements
      if (nodes.audioElement || nodes.mediaSourceNode) {
        this.clearTrackMedia(track.id);
      }
    } else if (track.mediaSourceUrl) {
      this.attachTrackMedia(track.id, track.mediaSourceUrl, track.fileInfo?.durationSec);
    }

    this.applyTrackParams(track);
  }

  /**
   * Configures a WAV/PCM streaming source in the AudioWorklet controller
   */
  public attachStreamingWavTrack(
    index: number,
    trackId: string,
    blob: Blob,
    header: ParsedWavHeader
  ): void {
    if (this.streamingController) {
      this.streamingController.setTrackSource(index, blob, header);
      // Ensure legacy elements are disconnected on this track
      this.clearTrackMedia(trackId);
    }
  }

  /**
   * Retrieves active streaming mixer telemetry (P99 latency, real-time factor, memory)
   */
  public getStreamingTelemetry(): import('./streamingMixerController').StreamingMixerTelemetry | null {
    return this.streamingController ? this.streamingController.getTelemetry() : null;
  }

  /**
   * Configures an HTMLAudioElement streaming source connected to the track DSP chain (<20MB RAM)
   * Strictly disabled when StreamingMixerController is present.
   */
  public attachTrackMedia(trackId: string, mediaUrl: string, durationSec?: number): void {
    if (!this.ctx) return;
    if (this.streamingController) {
      // In streaming mode, AudioWorklet is the only playback engine. Discard legacy media.
      this.clearTrackMedia(trackId);
      return;
    }
    const nodes = this.trackNodesMap.get(trackId);
    if (!nodes) return;

    if (!nodes.audioElement) {
      const audioEl = new Audio();
      audioEl.preload = 'auto';
      audioEl.setAttribute('playsinline', 'true');
      audioEl.crossOrigin = 'anonymous';
      nodes.audioElement = audioEl;

      try {
        nodes.mediaSourceNode = this.ctx.createMediaElementSource(audioEl);
        nodes.mediaSourceNode.connect(nodes.eqLow);
      } catch (err) {
        console.warn('MediaElementAudioSourceNode creation note:', err);
      }
    }

    if (nodes.audioElement.src !== mediaUrl) {
      nodes.audioElement.src = mediaUrl;
      nodes.audioElement.load();
    }

    if (durationSec && durationSec > this.duration) {
      this.duration = durationSec;
    }
  }

  /**
   * Resets and cleans up a track's streaming audio element and revokes any associated object URL
   */
  public clearTrackMedia(trackId: string): void {
    const nodes = this.trackNodesMap.get(trackId);
    if (nodes) {
      if (nodes.source) {
        try {
          nodes.source.stop();
          nodes.source.disconnect();
        } catch {
          // ignore
        }
        nodes.source = null;
      }
      if (nodes.audioElement) {
        try {
          nodes.audioElement.pause();
          const src = nodes.audioElement.src;
          if (src && src.startsWith('blob:')) {
            URL.revokeObjectURL(src);
          }
          nodes.audioElement.src = '';
          nodes.audioElement.load();
        } catch {
          // ignore
        }
        nodes.audioElement = null;
      }
      if (nodes.mediaSourceNode) {
        try {
          nodes.mediaSourceNode.disconnect();
        } catch {
          // ignore
        }
        nodes.mediaSourceNode = null;
      }
    }
  }

  /**
   * Applies updated track parameters to DSP nodes in real time
   */
  public applyTrackParams(track: TrackData, anySolo = false): void {
    const nodes = this.trackNodesMap.get(track.id);
    if (!nodes) return;

    // EQ
    nodes.eqLow.gain.setTargetAtTime(track.eq.lowGain, 0, 0.02);
    nodes.eqMid.gain.setTargetAtTime(track.eq.midGain, 0, 0.02);
    nodes.eqMid.frequency.setTargetAtTime(track.eq.midFreq, 0, 0.02);
    nodes.eqHigh.gain.setTargetAtTime(track.eq.highGain, 0, 0.02);

    // Compressor
    if (track.compressor.enabled) {
      nodes.compressor.threshold.setTargetAtTime(track.compressor.threshold, 0, 0.02);
      nodes.compressor.ratio.setTargetAtTime(track.compressor.ratio, 0, 0.02);
      nodes.compressor.attack.setTargetAtTime(track.compressor.attack, 0, 0.02);
      nodes.compressor.release.setTargetAtTime(track.compressor.release, 0, 0.02);
    } else {
      // Bypass compression by setting ratio to 1
      nodes.compressor.ratio.setTargetAtTime(1, 0, 0.02);
    }

    // Pan
    nodes.panner.pan.setTargetAtTime(track.pan, 0, 0.02);

    // Reverb aux send
    nodes.reverbSendGain.gain.setTargetAtTime(track.reverbSend, 0, 0.02);

    // Fader & Solo/Mute logic
    let targetGain = dbToGain(track.volume);
    if (track.mute) {
      targetGain = 0;
    } else if (anySolo && !track.solo) {
      targetGain = 0;
    }
    nodes.faderGain.gain.setTargetAtTime(targetGain, 0, 0.02);
  }

  /**
   * Applies master bus parameters in real time
   */
  public applyMasterParams(master: MasterState): void {
    if (!this.masterFader || !this.masterEqLow || !this.masterEqMid || !this.masterEqHigh || !this.masterLimiter) {
      return;
    }

    this.masterFader.gain.setTargetAtTime(dbToGain(master.volume), 0, 0.02);
    this.masterEqLow.gain.setTargetAtTime(master.eq.lowGain, 0, 0.02);
    this.masterEqMid.gain.setTargetAtTime(master.eq.midGain, 0, 0.02);
    this.masterEqHigh.gain.setTargetAtTime(master.eq.highGain, 0, 0.02);

    if (master.limiterEnabled) {
      this.masterLimiter.threshold.setTargetAtTime(master.limiterThreshold, 0, 0.02);
      this.masterLimiter.ratio.setTargetAtTime(20, 0, 0.02);
    } else {
      this.masterLimiter.ratio.setTargetAtTime(1, 0, 0.02);
    }
  }

  /**
   * Starts playback across all tracks simultaneously
   */
  public async play(tracks: TrackData[], startOffset?: number): Promise<void> {
    await this.initContext();
    if (!this.ctx) return;

    if (this.isPlaying) {
      this.stopSources();
    }

    if (startOffset !== undefined) {
      this.pauseOffset = clamp(startOffset, 0, this.duration);
    }

    // Determine max song duration across streaming files and audio buffers
    let maxDur = 0;
    for (const t of tracks) {
      const trackDur = t.fileInfo?.durationSec || (t.audioBuffer ? t.audioBuffer.duration : 0);
      if (trackDur > maxDur) {
        maxDur = trackDur;
      }
    }
    if (maxDur > 0) this.duration = maxDur;

    const anySolo = tracks.some(t => t.solo);
    this.startTime = this.ctx.currentTime;
    this.activeMediaElements = [];
    this.masterSyncElement = null;

    const playPromises: Promise<void>[] = [];

    // Initialize & synchronize each track
    tracks.forEach(track => {
      this.setupTrackNodes(track);
      const nodes = this.trackNodesMap.get(track.id);
      if (!nodes) return;

      const offset = this.pauseOffset;

      // Path A: Streaming HTMLAudioElement (used ONLY when AudioWorklet controller is not present)
      if (!this.streamingController && track.mediaSourceUrl && nodes.audioElement) {
        nodes.audioElement.currentTime = offset;
        nodes.audioElement.playbackRate = 1.0;
        this.activeMediaElements.push(nodes.audioElement);
        if (!this.masterSyncElement) {
          this.masterSyncElement = nodes.audioElement;
        }

        playPromises.push(
          nodes.audioElement.play().catch(err => {
            console.warn(`Playback warning on ${track.name}:`, err);
          })
        );
      }
      // Path B: In-memory AudioBuffer (procedural demo stems or short clips)
      else if (track.audioBuffer) {
        const source = this.ctx!.createBufferSource();
        source.buffer = track.audioBuffer;
        source.connect(nodes.eqLow);

        if (this.isLooping) {
          source.loop = true;
          source.loopStart = this.loopStart;
          source.loopEnd = Math.min(this.loopEnd, track.audioBuffer.duration);
        }

        source.start(0, offset);
        nodes.source = source;
      }

      this.applyTrackParams(track, anySolo);
    });

    if (playPromises.length > 0) {
      await Promise.all(playPromises);
    }

    // Path C: AudioWorklet Streaming Mixer (WAV/PCM bounded streaming)
    const hasWorkletTracks = tracks.some(t => !!(t.sourceBlob && t.parsedHeader));
    if (hasWorkletTracks && this.streamingController) {
      tracks.forEach((track, idx) => {
        if (track.sourceBlob && track.parsedHeader) {
          this.streamingController!.setTrackSource(idx, track.sourceBlob, track.parsedHeader);
        }
      });
      this.streamingController.play(this.pauseOffset);
    }

    this.isPlaying = true;
    this.startMeterLoop(tracks);
  }

  /**
   * Pauses playback and saves the current playhead position
   */
  public pause(): void {
    if (!this.isPlaying) return;
    this.pauseOffset = this.getCurrentTime();
    this.stopSources();
    if (this.streamingController) {
      this.streamingController.pause();
    }
    this.isPlaying = false;
    this.stopMeterLoop();
  }

  /**
   * Stops playback and returns playhead to start
   */
  public stop(): void {
    this.stopSources();
    if (this.streamingController) {
      this.streamingController.pause();
      this.streamingController.seek(0);
    }
    this.pauseOffset = 0;
    this.isPlaying = false;
    this.stopMeterLoop();
    this.callbacks.onTimeUpdate(0);
  }

  /**
   * Seeks to a specific timestamp in seconds
   */
  public seek(seconds: number, tracks: TrackData[]): void {
    const clamped = clamp(seconds, 0, this.duration);
    this.pauseOffset = clamped;

    const hasWorkletTracks = tracks.some(t => !!(t.sourceBlob && t.parsedHeader));

    if (hasWorkletTracks && this.streamingController) {
      this.streamingController.seek(clamped);
      this.callbacks.onTimeUpdate(clamped);
      return;
    }

    // Direct seeking on legacy media elements (only when streaming controller is absent)
    this.trackNodesMap.forEach(nodes => {
      if (nodes.audioElement) {
        nodes.audioElement.currentTime = clamped;
        nodes.audioElement.playbackRate = 1.0;
      }
    });

    if (this.isPlaying) {
      this.play(tracks, clamped);
    } else {
      this.callbacks.onTimeUpdate(clamped);
    }
  }

  public setLoop(enabled: boolean, start: number, end: number, tracks?: TrackData[]): void {
    this.isLooping = enabled;
    this.loopStart = start;
    this.loopEnd = end;
    if (this.isPlaying && tracks) {
      this.play(tracks, this.getCurrentTime());
    }
  }

  public getDuration(): number {
    return this.duration;
  }

  public setDuration(seconds: number): void {
    if (seconds > 0) {
      this.duration = seconds;
    }
  }

  public getCurrentTime(): number {
    if (!this.isPlaying) {
      return this.pauseOffset;
    }

    // Read hardware-synced time directly from AudioWorklet if active streaming tracks exist
    if (this.streamingController && this.streamingController.hasActiveTracks() && this.isPlaying) {
      const sampleRate = this.ctx ? this.ctx.sampleRate : 48000;
      let pos = this.streamingController.getCurrentProjectFrame() / sampleRate;
      if (this.isLooping && this.loopEnd > this.loopStart) {
        const loopLen = this.loopEnd - this.loopStart;
        if (pos >= this.loopEnd) {
          pos = this.loopStart + ((pos - this.loopStart) % loopLen);
        }
      } else if (pos >= this.duration) {
        pos = this.duration;
        this.stop();
        this.callbacks.onEnded();
      }
      return pos;
    }

    // Read hardware-synced time from master streaming element if present
    if (this.masterSyncElement && !this.masterSyncElement.paused) {
      let pos = this.masterSyncElement.currentTime;
      if (this.isLooping && this.loopEnd > this.loopStart) {
        if (pos >= this.loopEnd) {
          const loopLen = this.loopEnd - this.loopStart;
          pos = this.loopStart + ((pos - this.loopStart) % loopLen);
        }
      } else if (pos >= this.duration) {
        pos = this.duration;
        this.stop();
        this.callbacks.onEnded();
      }
      return pos;
    }

    if (!this.ctx) return this.pauseOffset;

    const elapsed = this.ctx.currentTime - this.startTime;
    let pos = this.pauseOffset + elapsed;

    if (this.isLooping && this.loopEnd > this.loopStart) {
      const loopLen = this.loopEnd - this.loopStart;
      if (pos >= this.loopEnd) {
        pos = this.loopStart + ((pos - this.loopStart) % loopLen);
      }
    } else if (pos >= this.duration) {
      pos = this.duration;
      this.stop();
      this.callbacks.onEnded();
    }
    return pos;
  }

  private stopSources(): void {
    // Stop buffer sources
    this.trackNodesMap.forEach(nodes => {
      if (nodes.source) {
        try {
          nodes.source.stop();
          nodes.source.disconnect();
        } catch {
          // ignore already stopped source
        }
        nodes.source = null;
      }
      if (nodes.audioElement) {
        nodes.audioElement.pause();
        nodes.audioElement.playbackRate = 1.0;
      }
    });

    this.activeMediaElements = [];
    this.masterSyncElement = null;
  }

  private startMeterLoop(tracks: TrackData[]): void {
    this.stopMeterLoop();

    const trackDataArrays = new Map<string, Uint8Array<ArrayBuffer>>();
    const masterLen = this.masterAnalyser ? this.masterAnalyser.frequencyBinCount : 128;
    const masterData = new Uint8Array(new ArrayBuffer(masterLen));

    tracks.forEach(t => {
      const nodes = this.trackNodesMap.get(t.id);
      if (nodes) {
        trackDataArrays.set(t.id, new Uint8Array(new ArrayBuffer(nodes.analyser.frequencyBinCount)));
      }
    });

    const tick = () => {
      if (!this.isPlaying) return;

      const currentTime = this.getCurrentTime();
      this.callbacks.onTimeUpdate(currentTime);

      // Drift monitoring & sync micro-adjustment across active media elements
      if (this.masterSyncElement && this.activeMediaElements.length > 1 && !this.masterSyncElement.paused) {
        const masterTime = this.masterSyncElement.currentTime;
        for (let i = 0; i < this.activeMediaElements.length; i++) {
          const el = this.activeMediaElements[i];
          if (el === this.masterSyncElement) continue;

          const drift = el.currentTime - masterTime;
          // Sub-perceptual nudge if drift is between 35ms and 150ms
          if (Math.abs(drift) > 0.035 && Math.abs(drift) < 0.150) {
            el.playbackRate = drift > 0 ? 0.995 : 1.005;
          } else if (Math.abs(drift) >= 0.150) {
            // Hard re-sync if stalled
            el.currentTime = masterTime;
            el.playbackRate = 1.0;
          } else if (el.playbackRate !== 1.0) {
            el.playbackRate = 1.0;
          }
        }
      }

      // Compute track meters
      const trackMeters: Array<{ id: string; peakL: number; peakR: number; gr: number }> = [];

      tracks.forEach(t => {
        const nodes = this.trackNodesMap.get(t.id);
        const data = trackDataArrays.get(t.id);
        if (nodes && data) {
          nodes.analyser.getByteTimeDomainData(data);
          let peak = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            const abs = Math.abs(v);
            if (abs > peak) peak = abs;
          }

          // Gain reduction from compressor
          const gr = nodes.compressor.reduction ? Math.abs(nodes.compressor.reduction) : 0;
          trackMeters.push({
            id: t.id,
            peakL: peak,
            peakR: peak,
            gr,
          });
        }
      });

      // Master meter
      let masterPeakL = 0;
      let masterPeakR = 0;
      if (this.masterAnalyser) {
        this.masterAnalyser.getByteTimeDomainData(masterData);
        for (let i = 0; i < masterData.length; i++) {
          const v = (masterData[i] - 128) / 128;
          const abs = Math.abs(v);
          if (abs > masterPeakL) masterPeakL = abs;
        }
        masterPeakR = masterPeakL;
      }

      this.callbacks.onMeterUpdate(trackMeters, { peakL: masterPeakL, peakR: masterPeakR });
      this.meterRafId = requestAnimationFrame(tick);
    };

    this.meterRafId = requestAnimationFrame(tick);
  }

  private stopMeterLoop(): void {
    if (this.meterRafId !== null) {
      cancelAnimationFrame(this.meterRafId);
      this.meterRafId = null;
    }
  }

  public destroy(): void {
    this.stop();
    if (this.streamingController) {
      this.streamingController.destroy();
      this.streamingController = null;
    }
    this.workletConnectedTracks.clear();
    if (this.ctx) {
      try {
        this.ctx.close();
      } catch {
        // ignore
      }
      this.ctx = null;
    }
  }
}
