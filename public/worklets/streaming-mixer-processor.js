/**
 * Streaming Mixer AudioWorkletProcessor
 * 4 Stereo Outputs (8 audio channels total), shared transport frame counter,
 * synchronized underrun freeze and recovery, and zero full-track PCM retention.
 */

class StreamingMixerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // 4 Stereo Ring Buffers
    // Default capacity: 6 seconds at 48kHz = 288,000 frames
    this.sampleRate = 48000;
    this.ringCapacity = 288000;
    this.tracks = [
      { left: new Float32Array(this.ringCapacity), right: new Float32Array(this.ringCapacity), readIdx: 0, writeIdx: 0, available: 0, active: false },
      { left: new Float32Array(this.ringCapacity), right: new Float32Array(this.ringCapacity), readIdx: 0, writeIdx: 0, available: 0, active: false },
      { left: new Float32Array(this.ringCapacity), right: new Float32Array(this.ringCapacity), readIdx: 0, writeIdx: 0, available: 0, active: false },
      { left: new Float32Array(this.ringCapacity), right: new Float32Array(this.ringCapacity), readIdx: 0, writeIdx: 0, available: 0, active: false },
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
        }
        if (data.ringCapacity) {
          this.ringCapacity = data.ringCapacity;
          for (let i = 0; i < 4; i++) {
            this.tracks[i].left = new Float32Array(this.ringCapacity);
            this.tracks[i].right = new Float32Array(this.ringCapacity);
            this.tracks[i].readIdx = 0;
            this.tracks[i].writeIdx = 0;
            this.tracks[i].available = 0;
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
        const { trackIndex, leftBuffer, rightBuffer, frames, bufferId } = data;
        if (trackIndex >= 0 && trackIndex < 4) {
          const t = this.tracks[trackIndex];
          const leftView = new Float32Array(leftBuffer);
          const rightView = new Float32Array(rightBuffer);

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

          // Return transferable ArrayBuffers back to main thread to maintain zero allocations
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
        this.projectFrame = Math.max(0, Math.floor(data.projectFrame || 0));
        for (let i = 0; i < 4; i++) {
          this.tracks[i].readIdx = 0;
          this.tracks[i].writeIdx = 0;
          this.tracks[i].available = 0;
          this.tracks[i].left.fill(0);
          this.tracks[i].right.fill(0);
        }
        this.port.postMessage({ type: 'seek-ack', projectFrame: this.projectFrame });
        break;
      }

      case 'clear': {
        for (let i = 0; i < 4; i++) {
          this.tracks[i].readIdx = 0;
          this.tracks[i].writeIdx = 0;
          this.tracks[i].available = 0;
          this.tracks[i].left.fill(0);
          this.tracks[i].right.fill(0);
        }
        break;
      }
    }
  }

  process(inputs, outputs, parameters) {
    const numOutputs = outputs.length;

    // Handle arbitrary quantum size (usually 128)
    const quantum = outputs[0] && outputs[0][0] ? outputs[0][0].length : 128;

    if (!this.isPlaying) {
      for (let o = 0; o < numOutputs; o++) {
        if (outputs[o][0]) outputs[o][0].fill(0);
        if (outputs[o][1]) outputs[o][1].fill(0);
      }
      return true;
    }

    // Check if any active track is in an underrun state
    let hasUnderrun = false;
    let underrunTrack = -1;

    for (let i = 0; i < 4; i++) {
      if (this.tracks[i].active && this.tracks[i].available < quantum) {
        hasUnderrun = true;
        underrunTrack = i;
        break;
      }
    }

    // Underrun: silence all 4 outputs, freeze projectFrame counter, report diagnostics
    if (hasUnderrun) {
      for (let o = 0; o < numOutputs; o++) {
        if (outputs[o][0]) outputs[o][0].fill(0);
        if (outputs[o][1]) outputs[o][1].fill(0);
      }

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

      // Do NOT increment projectFrame during underrun
      return true;
    }

    // All active tracks have valid audio frames: stream synchronously to outputs
    for (let i = 0; i < Math.min(4, numOutputs); i++) {
      const outL = outputs[i][0];
      const outR = outputs[i][1];
      const t = this.tracks[i];

      if (!outL || !outR) continue;

      if (!t.active) {
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

    // Advance project frame counter synchronously across all tracks
    this.projectFrame += quantum;

    // Periodic time progress reporting (~every 2048 frames / ~42ms at 48kHz)
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
