/**
 * Pure Audio Mathematics & Conversion Utilities
 */

/**
 * Converts decibels (dB) to linear gain multiplier.
 * -inf / <= -60 dB maps to 0.0 (silent)
 * 0 dB maps to 1.0
 * +6 dB maps to ~1.995
 */
export function dbToGain(db: number): number {
  if (db <= -60) return 0;
  return Math.pow(10, db / 20);
}

/**
 * Converts linear gain multiplier to decibels (dB).
 * 0.0 maps to -Infinity (or capped at -60 for UI)
 * 1.0 maps to 0 dB
 */
export function gainToDb(gain: number, floorDb = -60): number {
  if (gain <= 0.0001) return floorDb;
  const db = 20 * Math.log10(gain);
  return Math.max(floorDb, db);
}

/**
 * Constant Power Panning Law (-3dB center)
 * pan: -1.0 (Full Left) to 0.0 (Center) to +1.0 (Full Right)
 */
export function calculatePanGains(pan: number): { leftGain: number; rightGain: number } {
  const clampedPan = Math.max(-1, Math.min(1, pan));
  // Normalize pan from [-1, 1] to [0, 1]
  const normalized = (clampedPan + 1) / 2;
  // Constant power angle: 0 to PI/2
  const angle = normalized * (Math.PI / 2);
  const leftGain = Math.cos(angle);
  const rightGain = Math.sin(angle);
  return { leftGain, rightGain };
}

/**
 * Stereo Balance / Panning Law
 * - For mono tracks (channels <= 1): uses constant-power (-3dB center) panning.
 * - For stereo tracks (channels > 1): uses stereo balance panning where center (pan = 0)
 *   preserves exact unity gain (1.0 / 0 dB) on both channels, eliminating unwanted -3dB attenuation.
 *   pan < 0 attenuates right channel while keeping left channel at 1.0;
 *   pan > 0 attenuates left channel while keeping right channel at 1.0.
 */
export function calculateStereoPanGains(pan: number, channels: number = 2): { leftGain: number; rightGain: number } {
  const clampedPan = Math.max(-1, Math.min(1, pan));
  if (channels <= 1) {
    return calculatePanGains(clampedPan);
  }
  // Stereo balance law: exact unity gain at center (0 dB attenuation)
  if (clampedPan === 0) {
    return { leftGain: 1.0, rightGain: 1.0 };
  }
  if (clampedPan <= -1) {
    return { leftGain: 1.0, rightGain: 0.0 };
  }
  if (clampedPan >= 1) {
    return { leftGain: 0.0, rightGain: 1.0 };
  }
  if (clampedPan < 0) {
    // Panned left: left channel stays 1.0, right channel is attenuated
    return {
      leftGain: 1.0,
      rightGain: Math.cos((-clampedPan) * (Math.PI / 2)),
    };
  } else {
    // Panned right: right channel stays 1.0, left channel is attenuated
    return {
      leftGain: Math.cos(clampedPan * (Math.PI / 2)),
      rightGain: 1.0,
    };
  }
}

/**
 * Clamps a number between min and max
 */
export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/**
 * Formats seconds into MM:SS.mmm timecode string
 */
export function formatTimecode(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) seconds = 0;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const millis = Math.floor((seconds - Math.floor(seconds)) * 1000);

  const mm = mins.toString().padStart(2, '0');
  const ss = secs.toString().padStart(2, '0');
  const mmm = millis.toString().padStart(3, '0');

  return `${mm}:${ss}.${mmm}`;
}

/**
 * Formats seconds into Musical Bars:Beats.Sub-ticks
 */
export function formatBarsBeats(seconds: number, bpm = 120, beatsPerBar = 4): string {
  if (isNaN(seconds) || seconds < 0) seconds = 0;
  const beatDuration = 60 / bpm;
  const totalBeats = seconds / beatDuration;
  const bar = Math.floor(totalBeats / beatsPerBar) + 1;
  const beat = Math.floor(totalBeats % beatsPerBar) + 1;
  const tick = Math.floor(((totalBeats % 1) * 16));

  const barStr = bar.toString().padStart(3, '0');
  const beatStr = beat.toString();
  const tickStr = tick.toString().padStart(2, '0');

  return `${barStr}.${beatStr}.${tickStr}`;
}

/**
 * Formats byte size into human readable string (KB, MB, GB)
 */
export function formatFileSize(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2);
  return `${val} ${units[i]}`;
}
