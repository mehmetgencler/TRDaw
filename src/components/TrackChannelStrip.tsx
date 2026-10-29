import React, { useState } from 'react';
import { Sliders, Activity, Disc } from 'lucide-react';
import type { TrackData } from '../types/audio';
import { KnobControl } from './KnobControl';
import { VerticalFader } from './VerticalFader';
import { PeakMeterLadder } from './PeakMeterLadder';

interface TrackChannelStripProps {
  track: TrackData;
  anySolo: boolean;
  onUpdateTrack: (updated: TrackData) => void;
}

export const TrackChannelStrip: React.FC<TrackChannelStripProps> = ({
  track,
  anySolo,
  onUpdateTrack,
}) => {
  const [activeDspTab, setActiveDspTab] = useState<'eq' | 'comp'>('eq');

  const handleEqChange = (field: keyof TrackData['eq'], val: number) => {
    onUpdateTrack({
      ...track,
      eq: {
        ...track.eq,
        [field]: val,
      },
    });
  };

  const handleCompChange = (field: keyof TrackData['compressor'], val: number | boolean) => {
    onUpdateTrack({
      ...track,
      compressor: {
        ...track.compressor,
        [field]: val,
      },
    });
  };

  const handleVolumeChange = (vol: number) => {
    onUpdateTrack({ ...track, volume: vol });
  };

  const handlePanChange = (pan: number) => {
    onUpdateTrack({ ...track, pan });
  };

  const handleReverbSendChange = (send: number) => {
    onUpdateTrack({ ...track, reverbSend: send });
  };

  const handleToggleMute = () => {
    onUpdateTrack({ ...track, mute: !track.mute });
  };

  const handleToggleSolo = () => {
    onUpdateTrack({ ...track, solo: !track.solo });
  };

  return (
    <div className="flex-1 min-w-[190px] max-w-[280px] bg-[#111622] border-r border-slate-800 flex flex-col justify-between shrink-0 select-none pb-2">
      {/* 1. Track Top Header */}
      <div
        className="px-3 py-2 border-b border-slate-800 flex items-center justify-between"
        style={{ borderTop: `3px solid ${track.color}` }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-bold text-white truncate">
            {track.name}
          </span>
        </div>
        <span className="text-[10px] font-mono text-slate-400">
          CH {track.id.replace('track-', '0')}
        </span>
      </div>

      {/* 2. DSP Section (Switchable EQ / Compressor) */}
      <div className="p-2 border-b border-slate-800 flex flex-col gap-2 bg-[#0C101A]">
        {/* Sub-tab switcher */}
        <div className="flex items-center justify-between bg-slate-900 p-0.5 rounded-md border border-slate-800 text-[10px]">
          <button
            onClick={() => setActiveDspTab('eq')}
            className={`flex-1 py-1 rounded font-medium transition-colors ${
              activeDspTab === 'eq'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            3-Band EQ
          </button>
          <button
            onClick={() => setActiveDspTab('comp')}
            className={`flex-1 py-1 rounded font-medium transition-colors ${
              activeDspTab === 'comp'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            Compressor
          </button>
        </div>

        {/* DSP View: 3-Band EQ */}
        {activeDspTab === 'eq' && (
          <div className="flex flex-col gap-2">
            {/* SVG EQ Curve Thumbnail */}
            <div className="w-full h-10 bg-slate-950 rounded border border-slate-800/80 overflow-hidden relative flex items-center justify-center">
              <svg width="100%" height="40" className="pointer-events-none">
                <line x1="0" y1="20" x2="100%" y2="20" stroke="#1E293B" strokeWidth="1" />
                <path
                  d={`M 0,${20 - track.eq.lowGain} Q 30,${20 - track.eq.lowGain * 0.8} 60,${20 - track.eq.midGain} T 140,${20 - track.eq.highGain} L 200,${20 - track.eq.highGain}`}
                  fill="none"
                  stroke={track.color}
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </div>

            {/* EQ Knobs */}
            <div className="grid grid-cols-3 gap-1">
              <KnobControl
                label="Low"
                value={track.eq.lowGain}
                min={-15}
                max={15}
                unit="dB"
                size="sm"
                color={track.color}
                onChange={val => handleEqChange('lowGain', val)}
              />
              <KnobControl
                label="Mid"
                value={track.eq.midGain}
                min={-15}
                max={15}
                unit="dB"
                size="sm"
                color={track.color}
                onChange={val => handleEqChange('midGain', val)}
              />
              <KnobControl
                label="High"
                value={track.eq.highGain}
                min={-15}
                max={15}
                unit="dB"
                size="sm"
                color={track.color}
                onChange={val => handleEqChange('highGain', val)}
              />
            </div>
          </div>
        )}

        {/* DSP View: Compressor */}
        {activeDspTab === 'comp' && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-slate-400 uppercase tracking-wide">Dynamics</span>
              <button
                onClick={() => handleCompChange('enabled', !track.compressor.enabled)}
                className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase transition-colors ${
                  track.compressor.enabled
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                    : 'bg-slate-800 text-slate-500'
                }`}
              >
                {track.compressor.enabled ? 'Active' : 'Bypass'}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <KnobControl
                label="Thresh"
                value={track.compressor.threshold}
                min={-40}
                max={0}
                unit="dB"
                size="sm"
                color="#10B981"
                onChange={val => handleCompChange('threshold', val)}
              />
              <KnobControl
                label="Ratio"
                value={track.compressor.ratio}
                min={1}
                max={20}
                unit=":1"
                size="sm"
                color="#10B981"
                onChange={val => handleCompChange('ratio', val)}
              />
            </div>

            {/* Gain Reduction Meter */}
            <div className="flex items-center justify-between text-[9px] font-mono text-slate-400 pt-1">
              <span>GR</span>
              <div className="flex-1 mx-2 h-1.5 bg-slate-900 rounded-full overflow-hidden border border-slate-800 flex justify-end">
                <div
                  className="h-full bg-amber-500 transition-all duration-75"
                  style={{ width: `${Math.min(100, (track.gainReductionDb / 15) * 100)}%` }}
                />
              </div>
              <span className="w-8 text-right tabular-nums">
                -{track.gainReductionDb.toFixed(1)}dB
              </span>
            </div>
          </div>
        )}
      </div>

      {/* 3. Aux Reverb Send & Pan Controls */}
      <div className="p-2 border-b border-slate-800 flex items-center justify-around bg-[#0E131E]">
        <KnobControl
          label="Rev Aux"
          value={Math.round(track.reverbSend * 100)}
          min={0}
          max={100}
          unit="%"
          size="sm"
          color="#8B5CF6"
          onChange={val => handleReverbSendChange(val / 100)}
        />
        <KnobControl
          label="Pan"
          value={Math.round(track.pan * 100)}
          min={-100}
          max={100}
          unit="%"
          size="sm"
          color="#38BDF8"
          onChange={val => handlePanChange(val / 100)}
        />
      </div>

      {/* 4. Solo & Mute Buttons */}
      <div className="px-3 py-1.5 flex items-center justify-center gap-2">
        <button
          onClick={handleToggleSolo}
          className={`flex-1 py-1.5 rounded text-xs font-bold uppercase transition-all ${
            track.solo
              ? 'bg-amber-500 text-black shadow-md shadow-amber-500/20'
              : 'bg-slate-800/80 hover:bg-slate-700 text-slate-300'
          }`}
          title="Solo track (silences non-soloed tracks)"
        >
          Solo
        </button>
        <button
          onClick={handleToggleMute}
          className={`flex-1 py-1.5 rounded text-xs font-bold uppercase transition-all ${
            track.mute
              ? 'bg-red-500 text-white shadow-md shadow-red-500/20'
              : 'bg-slate-800/80 hover:bg-slate-700 text-slate-300'
          }`}
          title="Mute track"
        >
          Mute
        </button>
      </div>

      {/* 5. Long-Throw Fader & Fast LED Peak Meter */}
      <div className="px-3 flex items-center justify-center gap-3">
        <VerticalFader
          value={track.volume}
          height={170}
          color={track.color}
          onChange={handleVolumeChange}
        />
        <PeakMeterLadder
          peakL={track.peakMeterL}
          peakR={track.peakMeterR}
          height={170}
          showLabels={true}
        />
      </div>

      {/* 6. Numeric Decibel Display */}
      <div className="text-center pt-1 font-mono text-xs font-bold text-slate-200 tabular-nums">
        {track.volume <= -60 ? '-∞' : track.volume > 0 ? `+${track.volume.toFixed(1)}` : track.volume.toFixed(1)}
        <span className="text-[10px] text-slate-400 font-normal ml-0.5">dB</span>
      </div>
    </div>
  );
};
