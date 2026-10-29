/**
 * Procedural Audio Stem Generator for WaveForge Studio
 * Generates 4 musical stems using Web Audio synthesis:
 * Track 1: Drums (Kick, Snare, Hi-hats)
 * Track 2: Sub Bass (Warm 808 / Analog Bassline)
 * Track 3: Synth Keys (Neo-soul Chords)
 * Track 4: Arpeggio Lead & FX (Melodic Lead line)
 */

import type { TrackData } from '../types/audio';

export function createDemoStems(ctx: AudioContext): TrackData[] {
  const sampleRate = ctx.sampleRate || 44100;
  const bpm = 120;
  const beatsPerSecond = bpm / 60;
  const totalBars = 8;
  const beatsPerBar = 4;
  const totalBeats = totalBars * beatsPerBar;
  const duration = totalBeats / beatsPerSecond; // 16.0 seconds
  const totalFrames = Math.floor(duration * sampleRate);

  // 1. Drums Buffer
  const drumsBuffer = ctx.createBuffer(2, totalFrames, sampleRate);
  const drumsL = drumsBuffer.getChannelData(0);
  const drumsR = drumsBuffer.getChannelData(1);

  // 2. Bass Buffer
  const bassBuffer = ctx.createBuffer(2, totalFrames, sampleRate);
  const bassL = bassBuffer.getChannelData(0);
  const bassR = bassBuffer.getChannelData(1);

  // 3. Keys Buffer
  const keysBuffer = ctx.createBuffer(2, totalFrames, sampleRate);
  const keysL = keysBuffer.getChannelData(0);
  const keysR = keysBuffer.getChannelData(1);

  // 4. Lead Buffer
  const leadBuffer = ctx.createBuffer(2, totalFrames, sampleRate);
  const leadL = leadBuffer.getChannelData(0);
  const leadR = leadBuffer.getChannelData(1);

  // Helper to synthesize a kick drum hit
  const addKick = (startSec: number) => {
    const startFrame = Math.floor(startSec * sampleRate);
    const hitLen = Math.floor(0.35 * sampleRate);
    for (let f = 0; f < hitLen && startFrame + f < totalFrames; f++) {
      const t = f / sampleRate;
      const freq = 130 * Math.exp(-t * 22) + 45;
      const env = Math.exp(-t * 12);
      const val = Math.sin(2 * Math.PI * freq * t) * env * 0.85;
      drumsL[startFrame + f] += val;
      drumsR[startFrame + f] += val;
    }
  };

  // Helper to synthesize a punchy snare hit
  const addSnare = (startSec: number) => {
    const startFrame = Math.floor(startSec * sampleRate);
    const hitLen = Math.floor(0.25 * sampleRate);
    for (let f = 0; f < hitLen && startFrame + f < totalFrames; f++) {
      const t = f / sampleRate;
      const toneFreq = 180 * Math.exp(-t * 18);
      const tone = Math.sin(2 * Math.PI * toneFreq * t) * Math.exp(-t * 15) * 0.4;
      const noise = (Math.random() * 2 - 1) * Math.exp(-t * 12) * 0.45;
      drumsL[startFrame + f] += tone + noise;
      drumsR[startFrame + f] += tone + noise;
    }
  };

  // Helper to synthesize a crisp hi-hat
  const addHiHat = (startSec: number, velocity = 0.25, pan = 0.2) => {
    const startFrame = Math.floor(startSec * sampleRate);
    const hitLen = Math.floor(0.08 * sampleRate);
    for (let f = 0; f < hitLen && startFrame + f < totalFrames; f++) {
      const t = f / sampleRate;
      const noise = (Math.random() * 2 - 1) * Math.exp(-t * 40) * velocity;
      drumsL[startFrame + f] += noise * (1 - pan);
      drumsR[startFrame + f] += noise * (1 + pan);
    }
  };

  // Synthesize Drum Pattern across 16 seconds
  const beatSec = 60 / bpm;
  for (let b = 0; b < totalBeats; b++) {
    const beatTime = b * beatSec;
    const beatInBar = b % 4;

    // Kick on 1 and 3 (and syncopated ghost kick on 2.5 on alternate bars)
    if (beatInBar === 0 || beatInBar === 2) {
      addKick(beatTime);
    }
    if ((b % 8 === 6 || b % 8 === 7) && beatInBar === 1) {
      addKick(beatTime + beatSec * 0.5);
    }

    // Snare on 2 and 4
    if (beatInBar === 1 || beatInBar === 3) {
      addSnare(beatTime);
    }

    // 16th-note Hi-hats
    addHiHat(beatTime, 0.28, -0.15);
    addHiHat(beatTime + beatSec * 0.25, 0.16, 0.15);
    addHiHat(beatTime + beatSec * 0.5, 0.24, -0.15);
    addHiHat(beatTime + beatSec * 0.75, 0.18, 0.15);
  }

  // Bass Notes (A minor progression: A1 -> F1 -> C2 -> G1)
  const bassNotes = [
    55, 55, 55, 58, 43.65, 43.65, 43.65, 49,
    65.4, 65.4, 65.4, 73.4, 49, 49, 52, 55
  ]; // frequencies for 16 half-bars
  const halfBarSec = beatSec * 2;

  for (let hb = 0; hb < totalBars * 2; hb++) {
    const noteFreq = bassNotes[hb % bassNotes.length];
    const startSec = hb * halfBarSec;
    const startFrame = Math.floor(startSec * sampleRate);
    const noteFrames = Math.floor((halfBarSec * 0.9) * sampleRate);

    for (let f = 0; f < noteFrames && startFrame + f < totalFrames; f++) {
      const t = f / sampleRate;
      const env = Math.min(1, t * 50) * Math.exp(-t * 1.2);
      // Fundamental sine + warm 2nd harmonic
      const val = (Math.sin(2 * Math.PI * noteFreq * t) * 0.6 +
                   Math.sin(2 * Math.PI * noteFreq * 2 * t) * 0.25) * env;
      bassL[startFrame + f] += val;
      bassR[startFrame + f] += val;
    }
  }

  // Keys Chords (Am9, Fmaj7, Cmaj7, G6)
  const chordProgressions = [
    [220, 261.63, 329.63, 392, 493.88], // Am9 (A, C, E, G, B)
    [174.61, 220, 261.63, 329.63, 392], // Fmaj7 (F, A, C, E, G)
    [261.63, 329.63, 392, 493.88, 523.25], // Cmaj7 (C, E, G, B, C)
    [196, 246.94, 293.66, 329.63, 392]  // G6 (G, B, D, E, G)
  ];

  for (let bar = 0; bar < totalBars; bar++) {
    const chord = chordProgressions[bar % chordProgressions.length];
    const barSec = bar * 4 * beatSec;
    const startFrame = Math.floor(barSec * sampleRate);
    const chordFrames = Math.floor((4 * beatSec * 0.95) * sampleRate);

    for (let f = 0; f < chordFrames && startFrame + f < totalFrames; f++) {
      const t = f / sampleRate;
      const env = Math.min(1, t * 15) * Math.exp(-t * 0.6);
      let chordValL = 0;
      let chordValR = 0;

      for (let n = 0; n < chord.length; n++) {
        const freq = chord[n];
        // Detuned dual oscillator with subtle stereo spread
        const oscL = Math.sin(2 * Math.PI * freq * t) * 0.08;
        const oscR = Math.sin(2 * Math.PI * (freq * 1.002) * t) * 0.08;
        chordValL += oscL;
        chordValR += oscR;
      }

      keysL[startFrame + f] += chordValL * env;
      keysR[startFrame + f] += chordValR * env;
    }
  }

  // Lead / Arp (16th-note pentatonic arpeggio)
  const arpNotes = [440, 523.25, 659.25, 783.99, 880, 783.99, 659.25, 523.25];
  const stepSec = beatSec / 4;
  const totalSteps = totalBeats * 4;

  for (let s = 0; s < totalSteps; s++) {
    const noteFreq = arpNotes[s % arpNotes.length];
    const startSec = s * stepSec;
    const startFrame = Math.floor(startSec * sampleRate);
    const stepFrames = Math.floor((stepSec * 0.75) * sampleRate);

    for (let f = 0; f < stepFrames && startFrame + f < totalFrames; f++) {
      const t = f / sampleRate;
      const env = Math.exp(-t * 24);
      const val = (Math.sin(2 * Math.PI * noteFreq * t) +
                   Math.sin(2 * Math.PI * noteFreq * 3 * t) * 0.2) * env * 0.22;
      // Ping-pong pan across steps
      const panStep = Math.sin(s * 0.5) * 0.5;
      leadL[startFrame + f] += val * (1 - panStep);
      leadR[startFrame + f] += val * (1 + panStep);
    }
  }

  // Helper to compute waveform peak decimation
  const computePeaks = (buf: AudioBuffer, numBins = 600): Float32Array => {
    const peaks = new Float32Array(numBins * 2);
    const ch0 = buf.getChannelData(0);
    const framesPerBin = Math.floor(buf.length / numBins);
    for (let b = 0; b < numBins; b++) {
      let min = 0;
      let max = 0;
      const start = b * framesPerBin;
      const end = Math.min(buf.length, start + framesPerBin);
      const stride = Math.max(1, Math.floor(framesPerBin / 32));
      for (let i = start; i < end; i += stride) {
        const val = ch0[i];
        if (val < min) min = val;
        if (val > max) max = val;
      }
      peaks[b * 2] = min;
      peaks[b * 2 + 1] = max;
    }
    return peaks;
  };

  return [
    {
      id: 'track-1',
      name: '01. Drums / Beat',
      color: '#3B82F6', // Electric Cobalt
      volume: 0,
      pan: 0,
      mute: false,
      solo: false,
      eq: { lowGain: 2, midGain: -1, midFreq: 1000, highGain: 1.5 },
      compressor: { enabled: true, threshold: -16, ratio: 4, attack: 0.015, release: 0.15 },
      reverbSend: 0.15,
      fileInfo: {
        name: 'STEM_01_DRUMS_24BIT_96K.wav',
        sizeBytes: 1048576000, // 1.00 GB uncompressed equivalent
        sampleRate: 48000,
        bitDepth: 24,
        channels: 2,
        durationSec: duration,
        isStreamingCache: true,
      },
      peaks: computePeaks(drumsBuffer),
      audioBuffer: drumsBuffer,
      gainReductionDb: 0,
      peakMeterL: 0,
      peakMeterR: 0,
      isDecoding: false,
      decodeProgress: 100,
    },
    {
      id: 'track-2',
      name: '02. Sub Bass',
      color: '#10B981', // Emerald
      volume: -1,
      pan: 0,
      mute: false,
      solo: false,
      eq: { lowGain: 3, midGain: -2, midFreq: 800, highGain: -2 },
      compressor: { enabled: true, threshold: -14, ratio: 5, attack: 0.02, release: 0.2 },
      reverbSend: 0.05,
      fileInfo: {
        name: 'STEM_02_BASS_24BIT_96K.wav',
        sizeBytes: 1073741824, // 1.00 GB
        sampleRate: 48000,
        bitDepth: 24,
        channels: 2,
        durationSec: duration,
        isStreamingCache: true,
      },
      peaks: computePeaks(bassBuffer),
      audioBuffer: bassBuffer,
      gainReductionDb: 0,
      peakMeterL: 0,
      peakMeterR: 0,
      isDecoding: false,
      decodeProgress: 100,
    },
    {
      id: 'track-3',
      name: '03. Poly Keys',
      color: '#F59E0B', // Amber
      volume: -2.5,
      pan: -0.25,
      mute: false,
      solo: false,
      eq: { lowGain: -1, midGain: 1, midFreq: 1500, highGain: 2 },
      compressor: { enabled: false, threshold: -20, ratio: 2.5, attack: 0.03, release: 0.25 },
      reverbSend: 0.35,
      fileInfo: {
        name: 'STEM_03_KEYS_24BIT_96K.wav',
        sizeBytes: 1048576000, // 1.00 GB
        sampleRate: 48000,
        bitDepth: 24,
        channels: 2,
        durationSec: duration,
        isStreamingCache: true,
      },
      peaks: computePeaks(keysBuffer),
      audioBuffer: keysBuffer,
      gainReductionDb: 0,
      peakMeterL: 0,
      peakMeterR: 0,
      isDecoding: false,
      decodeProgress: 100,
    },
    {
      id: 'track-4',
      name: '04. Lead Synth / FX',
      color: '#EC4899', // Magenta / Rose
      volume: -3,
      pan: 0.25,
      mute: false,
      solo: false,
      eq: { lowGain: -3, midGain: 2, midFreq: 2400, highGain: 3 },
      compressor: { enabled: true, threshold: -18, ratio: 3, attack: 0.01, release: 0.18 },
      reverbSend: 0.45,
      fileInfo: {
        name: 'STEM_04_LEAD_24BIT_96K.wav',
        sizeBytes: 1048576000, // 1.00 GB
        sampleRate: 48000,
        bitDepth: 24,
        channels: 2,
        durationSec: duration,
        isStreamingCache: true,
      },
      peaks: computePeaks(leadBuffer),
      audioBuffer: leadBuffer,
      gainReductionDb: 0,
      peakMeterL: 0,
      peakMeterR: 0,
      isDecoding: false,
      decodeProgress: 100,
    },
  ];
}

export function createEmptyTracks(): TrackData[] {
  return [
    {
      id: 'track-1',
      name: '01. Audio Track 1',
      color: '#3B82F6', // Cobalt
      volume: 0,
      pan: 0,
      mute: false,
      solo: false,
      eq: { lowGain: 0, midGain: 0, midFreq: 1000, highGain: 0 },
      compressor: { enabled: false, threshold: -18, ratio: 3, attack: 0.015, release: 0.15 },
      reverbSend: 0.1,
      fileInfo: null,
      peaks: null,
      audioBuffer: null,
      gainReductionDb: 0,
      peakMeterL: 0,
      peakMeterR: 0,
      isDecoding: false,
      decodeProgress: 0,
    },
    {
      id: 'track-2',
      name: '02. Audio Track 2',
      color: '#10B981', // Emerald
      volume: 0,
      pan: 0,
      mute: false,
      solo: false,
      eq: { lowGain: 0, midGain: 0, midFreq: 1000, highGain: 0 },
      compressor: { enabled: false, threshold: -18, ratio: 3, attack: 0.015, release: 0.15 },
      reverbSend: 0.1,
      fileInfo: null,
      peaks: null,
      audioBuffer: null,
      gainReductionDb: 0,
      peakMeterL: 0,
      peakMeterR: 0,
      isDecoding: false,
      decodeProgress: 0,
    },
    {
      id: 'track-3',
      name: '03. Audio Track 3',
      color: '#F59E0B', // Amber
      volume: 0,
      pan: 0,
      mute: false,
      solo: false,
      eq: { lowGain: 0, midGain: 0, midFreq: 1000, highGain: 0 },
      compressor: { enabled: false, threshold: -18, ratio: 3, attack: 0.015, release: 0.15 },
      reverbSend: 0.1,
      fileInfo: null,
      peaks: null,
      audioBuffer: null,
      gainReductionDb: 0,
      peakMeterL: 0,
      peakMeterR: 0,
      isDecoding: false,
      decodeProgress: 0,
    },
    {
      id: 'track-4',
      name: '04. Audio Track 4',
      color: '#EC4899', // Rose
      volume: 0,
      pan: 0,
      mute: false,
      solo: false,
      eq: { lowGain: 0, midGain: 0, midFreq: 1000, highGain: 0 },
      compressor: { enabled: false, threshold: -18, ratio: 3, attack: 0.015, release: 0.15 },
      reverbSend: 0.1,
      fileInfo: null,
      peaks: null,
      audioBuffer: null,
      gainReductionDb: 0,
      peakMeterL: 0,
      peakMeterR: 0,
      isDecoding: false,
      decodeProgress: 0,
    },
  ];
}
