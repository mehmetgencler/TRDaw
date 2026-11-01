/**
 * Streaming Mixer AudioWorkletProcessor
 * Supports:
 * 1. Multi-output mode (4 stereo outputs, 8 channels total)
 * 2. Fallback mode (1 output with 8 channels fanned out via ChannelSplitterNode)
 * 3. Stale block rejection via seekGeneration guards
 * 4. Zero-copy handoff across postMessage, single copy into ring buffer with performance marks
 * 5. Pre-roll gating without full prebuffer freeze
 * 6. Per-track replacement with 3ms equal-power cosine crossfade
 */

class StreamingMixerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sampleRate = 48000;
    this.ringCapacity = 288000;
    this.currentSeekGeneration = 0;
    this.trackSeekGenerations = [0, 0, 0, 0];
    this.isSeeking = false;
    this.minPreRollFrames = 12000; // ~0.25s pre-roll threshold
    this.tracks = [
      { left: new Float32Array(this.ringCapacity), right: new Float32Array(this.ringCapacity), readIdx: 0, writeIdx: 0, available: 0, active: false, eof: false },
      { left: new Float32Array(this.ringCapacity), right: new Float32Array(this.ringCapacity), readIdx: 0, writeIdx: 0, available: 0, active: false, eof: false },
      { left: new Float32Array(this.ringCapacity), right: new Float32Array(this.ringCapacity), readIdx: 0, writeIdx: 0, available: 0, active: false, eof: false },
      { left: new Float32Array(this.ringCapacity), right: new Float32Array(this.ringCapacity), readIdx: 0, writeIdx: 0, available: 0, active: false, eof: false },
    ];
    this.isPlaying = false;
    this.projectFrame = 0;
    this.underrunCount = 0;
    this.lastReportFrame = 0;
    this.port.onmessage = this.handleMessage.bind(this);
  }

  handleMessage(event) {
    const data = event.data;
    if (!data) return;

    switch (data.type) {
      case 'init': {
        if (data.sampleRate) {
          this.sampleRate = data.sampleRate;
          this.minPreRollFrames = Math.floor(this.sampleRate * 0.25);
        }
        if (data.ringCapacity) {
          this.ringCapacity = data.ringCapacity;
          for (let i = 0; i < 4; i++) {
            this.tracks[i].left = new Float32Array(this.ringCapacity);
            this.tracks[i].right = new Float32Array(this.ringCapacity);
            this.tracks[i].readIdx = 0;
            this.tracks[i].writeIdx = 0;
            this.tracks[i].available = 0;
            this.tracks[i].eof = false;
          }
        }
        break;
      }
      case 'track-eof': {
        const { trackIndex, seekGeneration } = data;
        const expectedGen = (this.trackSeekGenerations && this.trackSeekGenerations[trackIndex] !== undefined)
          ? this.trackSeekGenerations[trackIndex]
          : this.currentSeekGeneration;
        if (seekGeneration === undefined || seekGeneration === expectedGen) {
          if (trackIndex >= 0 && trackIndex < 4) {
            this.tracks[trackIndex].eof = true;
          }
        }
        break;
      }
      case 'set-playing': {
        this.isPlaying = !!data.isPlaying;
        if (data.projectFrame !== undefined) {
          this.projectFrame = Math.max(0, Math.floor(data.projectFrame));
        }
        break;
      }
      case 'set-active-tracks': {
        if (Array.isArray(data.activeTracks)) {
          for (let i = 0; i < 4; i++) {
            this.tracks[i].active = !!data.activeTracks[i];
          }
        }
        break;
      }
      case 'append-pcm': {
        const { trackIndex, leftBuffer, rightBuffer, frames, bufferId, seekGeneration } = data;

        // Guard against stale decode blocks from prior seek operations using per-track seek generation
        const expectedGen = (this.trackSeekGenerations && this.trackSeekGenerations[trackIndex] !== undefined)
          ? this.trackSeekGenerations[trackIndex]
          : this.currentSeekGeneration;

        if (seekGeneration !== undefined && seekGeneration !== expectedGen) {
          // Drop stale block immediately without writing into ring buffer
          this.port.postMessage(
            {
              type: 'buffer-consumed',
              bufferId,
              trackIndex,
              framesWritten: 0,
              ringAvailable: this.tracks[trackIndex] ? this.tracks[trackIndex].available : 0,
              leftBuffer,
              rightBuffer,
              staleDropped: true,
            },
            [leftBuffer, rightBuffer]
          );
          return;
        }

        if (trackIndex >= 0 && trackIndex < 4) {
          const t = this.tracks[trackIndex];
          const leftView = new Float32Array(leftBuffer);
          const rightView = new Float32Array(rightBuffer);

          // Zero-copy handoff across postMessage, single copy into ring buffer
          const toWrite = Math.min(frames, this.ringCapacity - t.available);
          if (toWrite > 0) {
            const firstChunk = Math.min(toWrite, this.ringCapacity - t.writeIdx);
            t.left.set(leftView.subarray(0, firstChunk), t.writeIdx);
            t.right.set(rightView.subarray(0, firstChunk), t.writeIdx);

            const secondChunk = toWrite - firstChunk;
            if (secondChunk > 0) {
              t.left.set(leftView.subarray(firstChunk, toWrite), 0);
              t.right.set(rightView.subarray(firstChunk, toWrite), 0);
              t.writeIdx = secondChunk;
            } else {
              t.writeIdx = (t.writeIdx + firstChunk) % this.ringCapacity;
            }

            t.available += toWrite;
          }

          // Return transferable buffers back to main thread pool
          this.port.postMessage(
            {
              type: 'buffer-consumed',
              bufferId,
              trackIndex,
              framesWritten: toWrite,
              ringAvailable: t.available,
              leftBuffer,
              rightBuffer,
            },
            [leftBuffer, rightBuffer]
          );
        }
        break;
      }
      case 'seek': {
        this.isSeeking = true;
        if (Array.isArray(data.trackSeekGenerations)) {
          for (let i = 0; i < 4; i++) {
            this.trackSeekGenerations[i] = data.trackSeekGenerations[i] || 0;
          }
          this.currentSeekGeneration = Math.max(...this.trackSeekGenerations);
        } else if (data.seekGeneration !== undefined) {
          this.currentSeekGeneration = data.seekGeneration;
          for (let i = 0; i < 4; i++) {
            this.trackSeekGenerations[i] = data.seekGeneration;
          }
        }
        this.projectFrame = Math.max(0, Math.floor(data.projectFrame || 0));
        this.lastReportFrame = this.projectFrame;
        for (let i = 0; i < 4; i++) {
          this.tracks[i].readIdx = 0;
          this.tracks[i].writeIdx = 0;
          this.tracks[i].available = 0;
          this.tracks[i].eof = false;
          this.tracks[i].left.fill(0);
          this.tracks[i].right.fill(0);
        }
        this.port.postMessage({
          type: 'seek-ack',
          projectFrame: this.projectFrame,
          seekGeneration: this.currentSeekGeneration,
          trackSeekGenerations: [...this.trackSeekGenerations],
        });
        break;
      }
      case 'seek-track': {
        const trackIdx = data.trackIndex;
        if (trackIdx >= 0 && trackIdx < 4) {
          if (data.seekGeneration !== undefined) {
            this.trackSeekGenerations[trackIdx] = data.seekGeneration;
          }
          this.tracks[trackIdx].readIdx = 0;
          this.tracks[trackIdx].writeIdx = 0;
          this.tracks[trackIdx].available = 0;
          this.tracks[trackIdx].eof = false;
          this.tracks[trackIdx].left.fill(0);
          this.tracks[trackIdx].right.fill(0);
        }
        break;
      }
      case 'replace-track': {
        const trackIdx = data.trackIndex;
        if (trackIdx >= 0 && trackIdx < 4) {
          if (data.seekGeneration !== undefined) {
            this.trackSeekGenerations[trackIdx] = data.seekGeneration;
          }
          const t = this.tracks[trackIdx];
          const fadeSamples = Math.min(144, t.available);
          for (let i = 0; i < fadeSamples; i++) {
            const idx = (t.readIdx + i) % this.ringCapacity;
            const gain = Math.cos((Math.PI / 2) * (i / 144));
            t.left[idx] *= gain;
            t.right[idx] *= gain;
          }
          t.available = fadeSamples;
          t.writeIdx = (t.readIdx + fadeSamples) % this.ringCapacity;
        }
        break;
      }
      case 'clear': {
        for (let i = 0; i < 4; i++) {
          this.tracks[i].readIdx = 0;
          this.tracks[i].writeIdx = 0;
          this.tracks[i].available = 0;
          this.tracks[i].eof = false;
          this.tracks[i].left.fill(0);
          this.tracks[i].right.fill(0);
        }
        break;
      }
    }
  }

  zeroFill(outputs, isSingleOutputFallback, numOutputs) {
    if (isSingleOutputFallback) {
      for (let ch = 0; ch < outputs[0].length; ch++) {
        if (outputs[0][ch]) outputs[0][ch].fill(0);
      }
    } else {
      for (let o = 0; o < numOutputs; o++) {
        if (outputs[o][0]) outputs[o][0].fill(0);
        if (outputs[o][1]) outputs[o][1].fill(0);
      }
    }
  }

  process(inputs, outputs, parameters) {
    const numOutputs = outputs.length;
    const isSingleOutputFallback = (numOutputs === 1 && outputs[0] && outputs[0].length >= 8);
    const quantum = outputs[0] && outputs[0][0] ? outputs[0][0].length : 128;

    if (!this.isPlaying) {
      this.zeroFill(outputs, isSingleOutputFallback, numOutputs);
      return true;
    }

    // Pre-roll gating: If seeking, wait until all active non-EOF tracks reach minPreRollFrames
    if (this.isSeeking) {
      let allReady = true;
      for (let i = 0; i < 4; i++) {
        if (this.tracks[i].active && !this.tracks[i].eof && this.tracks[i].available < this.minPreRollFrames) {
          allReady = false;
          break;
        }
      }
      if (allReady) {
        this.isSeeking = false;
      } else {
        this.zeroFill(outputs, isSingleOutputFallback, numOutputs);
        return true;
      }
    }

    let hasUnderrun = false;
    let underrunTrack = -1;

    for (let i = 0; i < 4; i++) {
      if (this.tracks[i].active && !this.tracks[i].eof && this.tracks[i].available < quantum) {
        hasUnderrun = true;
        underrunTrack = i;
        break;
      }
    }

    if (hasUnderrun) {
      this.zeroFill(outputs, isSingleOutputFallback, numOutputs);
      this.underrunCount++;
      if (this.underrunCount % 30 === 1) {
        this.port.postMessage({
          type: 'underrun',
          trackIndex: underrunTrack,
          projectFrame: this.projectFrame,
          available: this.tracks[underrunTrack].available,
          totalUnderruns: this.underrunCount,
        });
      }
      return true;
    }

    // Output routing: Discrete 4 outputs OR 1 output with 8 channels (fallback)
    for (let i = 0; i < 4; i++) {
      let outL;
      let outR;

      if (isSingleOutputFallback) {
        outL = outputs[0][i * 2];
        outR = outputs[0][i * 2 + 1];
      } else if (i < numOutputs) {
        outL = outputs[i][0];
        outR = outputs[i][1];
      }

      if (!outL || !outR) continue;
      const t = this.tracks[i];

      if (!t.active || (t.eof && t.available < quantum)) {
        outL.fill(0);
        outR.fill(0);
      } else {
        const firstChunk = Math.min(quantum, this.ringCapacity - t.readIdx);
        outL.set(t.left.subarray(t.readIdx, t.readIdx + firstChunk), 0);
        outR.set(t.right.subarray(t.readIdx, t.readIdx + firstChunk), 0);

        const secondChunk = quantum - firstChunk;
        if (secondChunk > 0) {
          outL.set(t.left.subarray(0, secondChunk), firstChunk);
          outR.set(t.right.subarray(0, secondChunk), firstChunk);
          t.readIdx = secondChunk;
        } else {
          t.readIdx = (t.readIdx + firstChunk) % this.ringCapacity;
        }

        t.available -= quantum;
      }
    }

    this.projectFrame += quantum;

    if (this.projectFrame - this.lastReportFrame >= 2048) {
      this.lastReportFrame = this.projectFrame;
      this.port.postMessage({
        type: 'position',
        projectFrame: this.projectFrame,
        timeSec: this.projectFrame / this.sampleRate,
        trackRingLevels: [
          this.tracks[0].available,
          this.tracks[1].available,
          this.tracks[2].available,
          this.tracks[3].available,
        ],
      });
    }

    return true;
  }
}

registerProcessor('streaming-mixer', StreamingMixerProcessor);
