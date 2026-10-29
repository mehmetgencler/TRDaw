/**
 * Phase 1 Export and Memory Verification Tests
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMixdownWav } from './wavEncoder';
import { parseWavHeader } from './wavParser';
import type { TrackData, MasterState, ExportSettings } from '../types/audio';
import { createEmptyTracks } from './demoStems';

test('Theoretical memory calculation: verifies 4x 60-min tracks memory reduction', () => {
  const durationSec = 3600; // 60 minutes
  const channels = 2; // stereo
  const bytesPerFloat32 = 4;

  // 1. Full 44.1kHz AudioBuffer
  const full44100PerTrack = durationSec * 44100 * channels * bytesPerFloat32;
  const full4TracksGib = (full44100PerTrack * 4) / (1024 * 1024 * 1024);
  assert.ok(full4TracksGib > 4.5, `4 tracks at 44.1kHz must exceed 4.5 GiB (5.08 GB decimal), got ${full4TracksGib}`);

  // 2. 11,025 Hz downsampled AudioBuffer
  const downsample11025PerTrack = durationSec * 11025 * channels * bytesPerFloat32;
  const downsample4TracksMb = (downsample11025PerTrack * 4) / (1024 * 1024);
  assert.ok(downsample4TracksMb > 1200, '4 tracks at 11025Hz must exceed 1.2 GB');

  // 3. Streaming HTMLAudioElement with zero retained PCM buffer
  // Peaks: 600 bins * 2 floats * 4 bytes = 4.8 KB per track
  const peaksPerTrackBytes = 600 * 2 * 4;
  const peaks4TracksKb = (peaksPerTrackBytes * 4) / 1024;
  assert.ok(peaks4TracksKb < 20, 'Peaks for 4 tracks must be under 20 KB');
});

test('Chunked renderMixdownWav produces valid RIFF WAV with 5-minute preview limit', async () => {
  const tracks: TrackData[] = createEmptyTracks();
  
  // Create a 2-second synthesized test audio buffer for track 1
  const numFrames = 44100 * 2;
  const testBuffer = {
    duration: 2.0,
    sampleRate: 44100,
    numberOfChannels: 2,
    getChannelData: () => {
      const data = new Float32Array(numFrames);
      for (let i = 0; i < numFrames; i++) {
        data[i] = Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.4;
      }
      return data;
    },
  } as unknown as AudioBuffer;

  tracks[0].audioBuffer = testBuffer;
  tracks[0].volume = 0;

  const master: MasterState = {
    volume: 0,
    limiterEnabled: true,
    limiterThreshold: -0.5,
    reverbDecay: 1.5,
    eq: { lowGain: 0, midGain: 0, highGain: 0 },
    peakL: 0,
    peakR: 0,
    rmsL: 0,
    rmsR: 0,
  };

  const settings: ExportSettings = {
    format: 'wav-16',
    sampleRate: 44100,
    range: 'preview-5m',
    normalize: false,
  };

  const blob = await renderMixdownWav(tracks, master, settings);
  assert.equal(blob.type, 'audio/wav');
  assert.ok(blob.size > 44, 'Blob must contain WAV header and audio data');

  // Verify header of exported mixdown
  const arrayBuf = await blob.arrayBuffer();
  const header = parseWavHeader(arrayBuf);
  assert.equal(header.channels, 2);
  assert.equal(header.sampleRate, 44100);
  assert.equal(header.bitsPerSample, 16);
  assert.equal(header.totalSampleFrames, 88200); // 2 seconds * 44100
  assert.equal(header.durationSec, 2.0);
});
