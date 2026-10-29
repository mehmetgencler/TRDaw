import React from 'react';
import { ShieldCheck, Waves } from 'lucide-react';
import type { MasterState } from '../types/audio';
import { KnobControl } from './KnobControl';
import { VerticalFader } from './VerticalFader';
import { PeakMeterLadder } from './PeakMeterLadder';
import { gainToDb } from '../audio/math';

interface MasterChannelStripProps {
  master: MasterState;
  onUpdateMaster: (updated: MasterState) => void;
  onReverbDecayChange: (decay: number) => void;
}

export const MasterChannelStrip: React.FC<MasterChannelStripProps> = ({
  master,
  onUpdateMaster,
  onReverbDecayChange,
}) => {
  const handleVolumeChange = (vol: number) => {
    onUpdateMaster({ ...master, volume: vol });
  };

  const handleLimiterToggle = () => {
    onUpdateMaster({ ...master, limiterEnabled: !master.limiterEnabled });
  };

  const handleLimiterThresholdChange = (thresh: number) => {
    onUpdateMaster({ ...master, limiterThreshold: thresh });
  };

  const handleMasterEqChange = (band: keyof MasterState['eq'], val: number) => {
    onUpdateMaster({
      ...master,
      eq: {
        ...master.eq,
        [band]: val,
      },
    });
  };

  const peakDbL = gainToDb(master.peakL);
  const peakDbR = gainToDb(master.peakR);

  return (
    <div className="flex-1 min-w-[200px] max-w-[280px] bg-[#141A28] border-l-2 border-purple-500/40 flex flex-col justify-between shrink-0 select-none pb-2 shadow-2xl">
      {/* 1. Master Top Header */}
      <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between bg-purple-950/20">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-purple-500 shadow-[0_0_8px_#A855F7]" />
          <span className="text-xs font-black tracking-wider uppercase text-purple-300">
            Master Bus
          </span>
        </div>
        <span className="text-[10px] font-mono text-purple-400">
          MAIN OUT
        </span>
      </div>

      {/* 2. Master Reverb & Master Limiter Controls */}
      <div className="p-2 border-b border-slate-800 flex flex-col gap-2 bg-[#0F1420]">
        {/* Reverb Room Decay */}
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-slate-400 uppercase tracking-wide flex items-center gap-1">
            <Waves className="w-3 h-3 text-purple-400" />
            <span>Room Verb</span>
          </span>
          <KnobControl
            label="Decay"
            value={master.reverbDecay}
            min={0.5}
            max={4.0}
            step={0.1}
            unit="s"
            size="sm"
            color="#A855F7"
            onChange={val => {
              onUpdateMaster({ ...master, reverbDecay: val });
              onReverbDecayChange(val);
            }}
          />
        </div>

        {/* Master Brickwall Limiter */}
        <div className="pt-1 border-t border-slate-800/80 flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-slate-400 uppercase tracking-wide flex items-center gap-1">
              <ShieldCheck className="w-3 h-3 text-emerald-400" />
              <span>Limiter</span>
            </span>
            <button
              onClick={handleLimiterToggle}
              className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase transition-colors ${
                master.limiterEnabled
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                  : 'bg-slate-800 text-slate-500'
              }`}
            >
              {master.limiterEnabled ? 'Brickwall' : 'Off'}
            </button>
          </div>

          <div className="flex items-center justify-center">
            <KnobControl
              label="Ceiling"
              value={master.limiterThreshold}
              min={-6}
              max={0}
              step={0.1}
              unit="dB"
              size="sm"
              color="#10B981"
              onChange={handleLimiterThresholdChange}
            />
          </div>
        </div>
      </div>

      {/* 3. Master Bus EQ */}
      <div className="p-2 border-b border-slate-800 flex items-center justify-around bg-[#0C101A]">
        <KnobControl
          label="Low"
          value={master.eq.lowGain}
          min={-12}
          max={12}
          unit="dB"
          size="sm"
          color="#A855F7"
          onChange={val => handleMasterEqChange('lowGain', val)}
        />
        <KnobControl
          label="Mid"
          value={master.eq.midGain}
          min={-12}
          max={12}
          unit="dB"
          size="sm"
          color="#A855F7"
          onChange={val => handleMasterEqChange('midGain', val)}
        />
        <KnobControl
          label="High"
          value={master.eq.highGain}
          min={-12}
          max={12}
          unit="dB"
          size="sm"
          color="#A855F7"
          onChange={val => handleMasterEqChange('highGain', val)}
        />
      </div>

      {/* 4. Master Output Fader & Stereo L/R Meters */}
      <div className="px-3 flex items-center justify-center gap-3">
        <VerticalFader
          value={master.volume}
          height={170}
          color="#A855F7"
          onChange={handleVolumeChange}
        />
        <PeakMeterLadder
          peakL={master.peakL}
          peakR={master.peakR}
          height={170}
          showLabels={true}
        />
      </div>

      {/* 5. Master Output Readout */}
      <div className="flex items-center justify-around pt-1 px-3 font-mono text-[11px] text-slate-300 tabular-nums">
        <div className="flex flex-col items-center">
          <span className="text-[9px] text-slate-400">OUT L</span>
          <span className={peakDbL > -0.2 ? 'text-red-400 font-bold' : ''}>
            {peakDbL <= -60 ? '-∞' : `${peakDbL.toFixed(1)}`}
          </span>
        </div>
        <div className="flex flex-col items-center">
          <span className="text-[9px] text-slate-400">OUT R</span>
          <span className={peakDbR > -0.2 ? 'text-red-400 font-bold' : ''}>
            {peakDbR <= -60 ? '-∞' : `${peakDbR.toFixed(1)}`}
          </span>
        </div>
      </div>
    </div>
  );
};
