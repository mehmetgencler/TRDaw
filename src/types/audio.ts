/**
 * Audio Mixer Data Types & Structures
 */

export interface EQSettings {
  lowGain: number;    // -15 dB to +15 dB (Low Shelf at 100 Hz)
  midGain: number;    // -15 dB to +15 dB (Peaking Bell at 1000 Hz)
  midFreq: number;    // 200 Hz to 5000 Hz
  highGain: number;   // -15 dB to +15 dB (High Shelf at 8000 Hz)
}

export interface CompressorSettings {
  enabled: boolean;
  threshold: number;  // -40 dB to 0 dB
  ratio: number;      // 1 to 20
  attack: number;     // 0.005s to 0.1s
  release: number;    // 0.05s to 0.5s
}

export interface TrackFileInfo {
  name: string;
  sizeBytes: number;
  sampleRate: number;
  bitDepth: number;
  channels: number;
  durationSec: number;
  isStreamingCache: boolean;
}

export interface TrackData {
  id: string;                 // 'track-1', 'track-2', 'track-3', 'track-4'
  name: string;               // e.g. "Drums / Beat", "Bass", "Keys", "Vocals / FX"
  color: string;              // hex or tailwind color class
  volume: number;             // dB (-60 to +6)
  pan: number;                // -1.0 (Left) to +1.0 (Right)
  mute: boolean;
  solo: boolean;
  eq: EQSettings;
  compressor: CompressorSettings;
  reverbSend: number;         // 0.0 to 1.0 (Aux send to master reverb)
  fileInfo: TrackFileInfo | null;
  peaks: Float32Array | null; // Downsampled peak envelope for waveform rendering
  audioBuffer: AudioBuffer | null; // Lightweight playback preview buffer (demo stems or short clips)
  mediaSourceUrl?: string | null; // Object URL for streaming playback (<20MB RAM)
  sourceBlob?: Blob | File | null; // Original file/blob handle for chunked streaming export
  parsedHeader?: import('../audio/wavParser').ParsedWavHeader | null; // Parsed RIFF chunk header
  gainReductionDb: number;    // Real-time compressor gain reduction
  peakMeterL: number;         // 0.0 to 1.0+
  peakMeterR: number;         // 0.0 to 1.0+
  isDecoding: boolean;        // Loading / slice-decoding progress state
  decodeProgress: number;     // 0 to 100%
}

export interface MasterState {
  volume: number;             // dB (-60 to +6)
  limiterEnabled: boolean;
  limiterThreshold: number;   // dB (-6 to 0)
  reverbDecay: number;        // seconds (0.5 to 4.0)
  eq: {
    lowGain: number;
    midGain: number;
    highGain: number;
  };
  peakL: number;              // 0.0 to 1.0+
  peakR: number;              // 0.0 to 1.0+
  rmsL: number;
  rmsR: number;
}

export interface TransportState {
  isPlaying: boolean;
  currentTime: number;        // seconds
  duration: number;           // maximum seconds across loaded tracks
  isLooping: boolean;
  loopStart: number;          // seconds
  loopEnd: number;            // seconds
  bpm: number;
}

export interface ExportSettings {
  format: 'wav-16' | 'wav-24' | 'wav-32f';
  sampleRate: 44100 | 48000;
  range: 'full' | 'loop' | 'preview-5m';
  customStart?: number;
  customEnd?: number;
  normalize: boolean;
}
