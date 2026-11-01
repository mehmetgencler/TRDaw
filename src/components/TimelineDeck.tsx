import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Upload, Volume2, VolumeX, Headphones, RefreshCw, HardDrive } from 'lucide-react';
import type { TrackData } from '../types/audio';
import { formatTimecode, formatFileSize } from '../audio/math';

interface TimelineDeckProps {
  tracks: TrackData[];
  currentTime: number;
  duration: number;
  isLooping: boolean;
  loopStart: number;
  loopEnd: number;
  onSeek: (seconds: number) => void;
  onTrackMute: (id: string) => void;
  onTrackSolo: (id: string) => void;
  onTrackVolume: (id: string, vol: number) => void;
  onFileUpload: (trackId: string, file: File) => void;
  onResetTrackToDemo: (trackId: string) => void;
}

export const TimelineDeck: React.FC<TimelineDeckProps> = ({
  tracks,
  currentTime,
  duration,
  isLooping,
  loopStart,
  loopEnd,
  onSeek,
  onTrackMute,
  onTrackSolo,
  onTrackVolume,
  onFileUpload,
  onResetTrackToDemo,
}) => {
  const rulerRef = useRef<HTMLDivElement>(null);
  const isScrubbingRef = useRef(false);
  const [scrubTime, setScrubTime] = useState<number | null>(null);

  const safeDuration = Math.max(1, duration);
  const displayTime = scrubTime !== null ? scrubTime : currentTime;
  const playheadPercent = Math.min(100, Math.max(0, (displayTime / safeDuration) * 100));

  const handlePointerDownRuler = (e: React.PointerEvent) => {
    if (!rulerRef.current) return;
    isScrubbingRef.current = true;
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    const rect = rulerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const target = (x / rect.width) * safeDuration;
    setScrubTime(target);
    onSeek(target);
  };

  const handlePointerMoveRuler = (e: React.PointerEvent) => {
    if (!isScrubbingRef.current || !rulerRef.current) return;
    const rect = rulerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const target = (x / rect.width) * safeDuration;
    setScrubTime(target);
    onSeek(target);
  };

  const handlePointerUpRuler = (e: React.PointerEvent) => {
    if (!isScrubbingRef.current) return;
    isScrubbingRef.current = false;
    if (rulerRef.current) {
      const rect = rulerRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const target = (x / rect.width) * safeDuration;
      onSeek(target);
    }
    setScrubTime(null);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-[#080B10] border-b border-slate-800 overflow-hidden select-none">
      {/* Top Ruler Bar */}
      <div className="h-8 bg-[#0D121D] border-b border-slate-800 flex items-center shrink-0">
        {/* Track Label Offset Column */}
        <div className="w-32 md:w-52 px-2.5 md:px-4 text-[10px] font-mono uppercase tracking-wider text-slate-400 border-r border-slate-800 flex items-center justify-between shrink-0">
          <span>Tracks</span>
          <span className="text-slate-500 hidden sm:inline">1GB Shield</span>
        </div>

        {/* Interactive Scrubbing Ruler */}
        <div
          ref={rulerRef}
          onPointerDown={handlePointerDownRuler}
          onPointerMove={handlePointerMoveRuler}
          onPointerUp={handlePointerUpRuler}
          className="flex-1 h-full relative cursor-pointer overflow-hidden flex items-center"
          title="Click or drag to scrub timeline"
        >
          {/* Loop Region Highlight */}
          {isLooping && (
            <div
              className="absolute top-0 bottom-0 bg-emerald-500/15 border-x border-emerald-500/40 pointer-events-none"
              style={{
                left: `${(loopStart / safeDuration) * 100}%`,
                width: `${((loopEnd - loopStart) / safeDuration) * 100}%`,
              }}
            />
          )}

          {/* Time & Bar Grid Ticks */}
          <div className="absolute inset-0 flex justify-between px-2 items-center pointer-events-none text-[9px] font-mono text-slate-400">
            <span>00:00</span>
            <span>{formatTimecode(safeDuration * 0.25).slice(0, 5)}</span>
            <span>{formatTimecode(safeDuration * 0.50).slice(0, 5)}</span>
            <span>{formatTimecode(safeDuration * 0.75).slice(0, 5)}</span>
            <span>{formatTimecode(safeDuration).slice(0, 5)}</span>
          </div>

          {/* Playhead marker indicator on ruler */}
          <div
            className="absolute top-0 bottom-0 w-[2px] bg-red-500 z-20 pointer-events-none"
            style={{ left: `${playheadPercent}%` }}
          >
            <div className="w-2.5 h-2.5 -ml-1 bg-red-500 rotate-45 -mt-1 shadow-sm" />
          </div>
        </div>
      </div>

      {/* Track Lanes Container */}
      <div className="flex-1 overflow-y-auto divide-y divide-slate-800/80">
        {tracks.map(track => (
          <TrackTimelineRow
            key={track.id}
            track={track}
            duration={safeDuration}
            playheadPercent={playheadPercent}
            onSeek={onSeek}
            onTrackMute={onTrackMute}
            onTrackSolo={onTrackSolo}
            onTrackVolume={onTrackVolume}
            onFileUpload={onFileUpload}
            onResetTrackToDemo={onResetTrackToDemo}
          />
        ))}
      </div>
    </div>
  );
};

interface TrackTimelineRowProps {
  track: TrackData;
  duration: number;
  playheadPercent: number;
  onSeek: (seconds: number) => void;
  onTrackMute: (id: string) => void;
  onTrackSolo: (id: string) => void;
  onTrackVolume: (id: string, vol: number) => void;
  onFileUpload: (trackId: string, file: File) => void;
  onResetTrackToDemo: (trackId: string) => void;
}

const TrackTimelineRow: React.FC<TrackTimelineRowProps> = ({
  track,
  duration,
  playheadPercent,
  onSeek,
  onTrackMute,
  onTrackSolo,
  onTrackVolume,
  onFileUpload,
  onResetTrackToDemo,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isDragOver, setIsDragOver] = useState(false);

  // Draw peaks on canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !track.peaks) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    // Center baseline
    const centerY = height / 2;
    const peaks = track.peaks;
    const numBins = peaks.length / 2;

    ctx.fillStyle = track.color;
    ctx.globalAlpha = track.mute ? 0.35 : 0.85;

    for (let i = 0; i < numBins; i++) {
      const min = peaks[i * 2];
      const max = peaks[i * 2 + 1];
      const x = (i / numBins) * width;
      const barWidth = Math.max(1, width / numBins);

      const yTop = centerY - max * (centerY * 0.95);
      const yBottom = centerY - min * (centerY * 0.95);
      const barHeight = Math.max(1.5, yBottom - yTop);

      ctx.fillRect(x, yTop, barWidth, barHeight);
    }

    ctx.globalAlpha = 1.0;
  }, [track.peaks, track.color, track.mute]);

  const hasAudio = Boolean(track.audioBuffer || track.sourceBlob || track.mediaSourceUrl || track.peaks);

  const handleLaneClick = (e: React.MouseEvent) => {
    if (!laneRef.current || !hasAudio) return;
    const rect = laneRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const fraction = x / rect.width;
    onSeek(fraction * duration);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      onFileUpload(track.id, e.target.files[0]);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      onFileUpload(track.id, e.dataTransfer.files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`h-20 md:h-24 flex items-stretch transition-colors ${
        track.mute ? 'bg-slate-950/60' : 'bg-[#0B0F18]'
      }`}
    >
      {/* Track Control Header Card */}
      <div className="w-32 md:w-52 p-2 md:p-2.5 bg-[#0F1420] border-r border-slate-800 flex flex-col justify-between shrink-0">
        <div className="flex items-center justify-between gap-1.5">
          <div className="flex items-center gap-1.5 min-w-0">
            <div
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: track.color }}
            />
            <span className="text-xs font-semibold text-white truncate">
              {track.name}
            </span>
          </div>

          {/* Quick Solo & Mute */}
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => onTrackSolo(track.id)}
              className={`w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center transition-colors ${
                track.solo
                  ? 'bg-amber-500 text-black shadow-xs'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
              title="Solo Track"
            >
              S
            </button>
            <button
              onClick={() => onTrackMute(track.id)}
              className={`w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center transition-colors ${
                track.mute
                  ? 'bg-red-500 text-white shadow-xs'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
              title="Mute Track"
            >
              M
            </button>
          </div>
        </div>

        {/* File Metadata & Memory Protection Status */}
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center justify-between text-[10px] text-slate-400">
            <span className="truncate max-w-[80px] md:max-w-[120px]" title={track.fileInfo?.name}>
              {track.fileInfo?.name || 'No stem loaded'}
            </span>
            <span className="font-mono text-slate-400 tabular-nums">
              {track.fileInfo ? formatFileSize(track.fileInfo.sizeBytes) : 'Empty'}
            </span>
          </div>

          <div className="flex items-center justify-between text-[9px] text-slate-400">
            {track.fileInfo ? (
              <span className="flex items-center gap-1 text-emerald-400 truncate">
                <HardDrive className="w-3 h-3 shrink-0" />
                <span className="hidden sm:inline">Streaming Mode: &lt;20MB RAM</span>
                <span className="sm:hidden">&lt;20MB RAM</span>
              </span>
            ) : (
              <span className="text-slate-400">Ready for Audio</span>
            )}

            <div className="flex items-center gap-1">
              <input
                ref={fileInputRef}
                type="file"
                accept=".wav,audio/wav,.mp3,audio/mpeg,audio/mp3,.m4a,.aac,audio/aac,audio/x-m4a,audio/*"
                onChange={handleFileChange}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-1.5 py-0.5 rounded bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 border border-blue-500/30 transition-colors flex items-center gap-1"
                title="Upload audio stem (WAV, MP3, M4A, AAC up to 1GB)"
              >
                <Upload className="w-3 h-3" />
                <span className="hidden md:inline text-[9px]">Upload</span>
              </button>
              <button
                onClick={() => onResetTrackToDemo(track.id)}
                className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-emerald-400 transition-colors"
                title="Load synthesized demo stem"
              >
                <RefreshCw className="w-3 h-3" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Waveform Visualization Lane or Empty Drop Zone */}
      <div
        ref={laneRef}
        onClick={handleLaneClick}
        className={`flex-1 relative cursor-pointer overflow-hidden flex items-center transition-colors ${
          isDragOver
            ? 'bg-blue-950/30 border-2 border-dashed border-blue-500/80'
            : 'bg-[#07090F]'
        }`}
        title={hasAudio ? 'Click to seek' : 'Click to upload WAV stem'}
      >
        {/* Loading / Decoding Progress overlay */}
        {track.isDecoding && (
          <div className="absolute inset-0 z-30 bg-black/75 flex flex-col items-center justify-center gap-1">
            <span className="text-xs text-blue-400 font-medium">
              Streaming Chunk Decimation: {track.decodeProgress}%
            </span>
            <div className="w-48 h-1.5 bg-slate-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all duration-150"
                style={{ width: `${track.decodeProgress}%` }}
              />
            </div>
          </div>
        )}

        {/* Empty Track Upload State */}
        {!track.audioBuffer && !track.peaks && !track.isDecoding ? (
          <div
            onClick={() => fileInputRef.current?.click()}
            className="w-full h-full flex items-center justify-between px-4 md:px-8 border border-dashed border-slate-800/80 hover:border-slate-700 bg-slate-950/20 hover:bg-slate-900/30 transition-all group"
          >
            <div className="flex items-center gap-3">
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border transition-all"
                style={{
                  backgroundColor: `${track.color}15`,
                  borderColor: `${track.color}40`,
                  color: track.color,
                }}
              >
                <Upload className="w-4 h-4" />
              </div>
              <div className="flex flex-col text-left">
                <span className="text-xs font-semibold text-slate-200 group-hover:text-white flex items-center gap-1.5">
                  <span>Upload 1GB WAV Stem</span>
                  <span className="text-[10px] text-slate-400 font-normal hidden sm:inline">· drag & drop or click</span>
                </span>
                <span className="text-[10px] text-slate-400">
                  Supports 16/24/32-bit PCM/Float up to 1GB without memory crashes
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onResetTrackToDemo(track.id);
              }}
              className="hidden sm:flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-[11px] font-medium border border-slate-700/60 transition-colors"
              title="Load demo audio for this track"
            >
              <RefreshCw className="w-3 h-3 text-emerald-400" />
              <span>Load Demo Stem</span>
            </button>
          </div>
        ) : (
          <>
            {/* Waveform Canvas */}
            <canvas
              ref={canvasRef}
              width={1200}
              height={96}
              className="w-full h-full pointer-events-none"
            />

            {/* Playhead vertical line across this track */}
            <div
              className="absolute top-0 bottom-0 w-[2px] bg-red-500 z-10 pointer-events-none shadow-[0_0_6px_#EF4444]"
              style={{ left: `${playheadPercent}%` }}
            />
          </>
        )}
      </div>
    </div>
  );
};
