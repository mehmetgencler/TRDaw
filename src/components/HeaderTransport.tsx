import React from 'react';
import { Play, Pause, Square, SkipBack, Repeat, Download, Sliders, AudioWaveform } from 'lucide-react';
import { formatTimecode, formatBarsBeats } from '../audio/math';

interface HeaderTransportProps {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  isLooping: boolean;
  bpm: number;
  engineState: AudioContextState;
  hasTracksLoaded: boolean;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onReturnToZero: () => void;
  onToggleLoop: () => void;
  onBpmChange: (bpm: number) => void;
  onOpenExport: () => void;
  onLoadAllDemoStems: () => void;
  onClearAllTracks: () => void;
}

export const HeaderTransport: React.FC<HeaderTransportProps> = ({
  isPlaying,
  currentTime,
  isLooping,
  bpm,
  engineState,
  hasTracksLoaded,
  onPlay,
  onPause,
  onStop,
  onReturnToZero,
  onToggleLoop,
  onBpmChange,
  onOpenExport,
  onLoadAllDemoStems,
  onClearAllTracks,
}) => {
  return (
    <header className="h-14 px-4 md:px-6 bg-[#0B0E15] border-b border-slate-800 flex items-center justify-between gap-4 select-none shrink-0">
      {/* Zone 1: Wordmark & Quiet Metadata */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="w-8 h-8 rounded-lg bg-blue-600/20 border border-blue-500/40 flex items-center justify-center text-blue-400 shrink-0">
          <AudioWaveform className="w-5 h-5" />
        </div>
        <div className="flex flex-col">
          <span className="hidden md:inline-block text-base font-bold tracking-tight text-white leading-tight">
            WaveForge Studio
          </span>
          <span className="hidden lg:inline-block text-[11px] text-slate-400">
            4-Track 1GB Streaming · 24-bit Mixdown
          </span>
        </div>
      </div>

      {/* Zone 2: Transport & Central Timecode Deck */}
      <div className="flex items-center gap-2 md:gap-4 shrink-0">
        {/* Transport buttons */}
        <div className="flex items-center gap-1 bg-slate-900/90 border border-slate-800 p-1 rounded-lg">
          <button
            onClick={onReturnToZero}
            className="p-1.5 rounded-md hover:bg-slate-800 text-slate-300 hover:text-white transition-colors"
            title="Return to Zero (Home)"
            aria-label="Return to Zero"
          >
            <SkipBack className="w-4 h-4" />
          </button>

          <button
            onClick={isPlaying ? onPause : onPlay}
            className={`px-3 py-1.5 rounded-md flex items-center gap-1.5 text-xs font-semibold transition-all ${
              isPlaying
                ? 'bg-amber-500 hover:bg-amber-400 text-black shadow-md shadow-amber-500/20'
                : 'bg-blue-600 hover:bg-blue-500 text-white shadow-md shadow-blue-600/20'
            }`}
            title={isPlaying ? 'Pause' : 'Play (Space)'}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? (
              <>
                <Pause className="w-4 h-4 fill-black" />
                <span className="hidden md:inline">Pause</span>
              </>
            ) : (
              <>
                <Play className="w-4 h-4 fill-white" />
                <span className="hidden md:inline">Play</span>
              </>
            )}
          </button>

          <button
            onClick={onStop}
            className="p-1.5 rounded-md hover:bg-slate-800 text-slate-300 hover:text-white transition-colors"
            title="Stop"
            aria-label="Stop"
          >
            <Square className="w-4 h-4" />
          </button>

          <button
            onClick={onToggleLoop}
            className={`p-1.5 rounded-md transition-colors ${
              isLooping
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'
            }`}
            title="Toggle Loop Region"
            aria-label="Toggle Loop"
          >
            <Repeat className="w-4 h-4" />
          </button>
        </div>

        {/* Timecode & Bar Counters */}
        <div className="hidden sm:flex items-center gap-3 bg-slate-950 border border-slate-800 px-3 py-1.5 rounded-lg">
          <div className="flex flex-col">
            <span className="text-[9px] uppercase tracking-wider text-slate-400 font-mono">Timecode</span>
            <span className="text-sm font-mono font-bold text-white tabular-nums">
              {formatTimecode(currentTime)}
            </span>
          </div>

          <div className="w-[1px] h-6 bg-slate-800" />

          <div className="flex flex-col">
            <span className="text-[9px] uppercase tracking-wider text-slate-400 font-mono">Bar.Beat</span>
            <span className="text-sm font-mono font-bold text-emerald-400 tabular-nums">
              {formatBarsBeats(currentTime, bpm)}
            </span>
          </div>

          <div className="w-[1px] h-6 bg-slate-800" />

          {/* BPM selector */}
          <div className="flex flex-col">
            <span className="text-[9px] uppercase tracking-wider text-slate-400 font-mono">Tempo</span>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={40}
                max={240}
                value={bpm}
                onChange={e => onBpmChange(Number(e.target.value))}
                className="w-12 bg-transparent text-sm font-mono font-bold text-slate-200 focus:outline-hidden focus:text-blue-400 text-center"
              />
              <span className="text-[10px] text-slate-400 font-mono">BPM</span>
            </div>
          </div>
        </div>
      </div>

      {/* Zone 3: Primary Action & Export */}
      <div className="flex items-center gap-2 shrink-0">
        {hasTracksLoaded ? (
          <button
            onClick={onClearAllTracks}
            className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 hover:text-white border border-slate-800 text-xs font-medium transition-colors cursor-pointer"
            title="Clear all tracks and start empty project"
          >
            <span>Empty Project</span>
          </button>
        ) : (
          <button
            onClick={onLoadAllDemoStems}
            className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 hover:text-white border border-slate-800 text-xs font-medium transition-colors cursor-pointer"
            title="Load 4 synthesized demo stems"
          >
            <span>Load Demo Stems</span>
          </button>
        )}

        <button
          onClick={onOpenExport}
          className="px-2.5 sm:px-3.5 py-1.5 sm:py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 active:scale-[0.98] text-white text-xs font-semibold flex items-center gap-1.5 shadow-lg shadow-emerald-600/20 transition-all cursor-pointer whitespace-nowrap"
          title="Export mixdown WAV"
        >
          <Download className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
          <span className="hidden sm:inline">Export Mixdown WAV</span>
          <span className="sm:hidden font-bold">Export WAV</span>
        </button>
      </div>
    </header>
  );
};
