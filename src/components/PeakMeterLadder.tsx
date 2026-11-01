import React, { useEffect, useState, useRef } from 'react';
import { gainToDb } from '../audio/math';

interface PeakMeterLadderProps {
  peakL: number; // 0.0 to 1.0+
  peakR?: number; // 0.0 to 1.0+ (if stereo)
  height?: number;
  showLabels?: boolean;
}

export const PeakMeterLadder: React.FC<PeakMeterLadderProps> = ({
  peakL,
  peakR,
  height = 180,
  showLabels = false,
}) => {
  const isStereo = peakR !== undefined;
  const [holdL, setHoldL] = useState(0);
  const [holdR, setHoldR] = useState(0);
  const [hasClipped, setHasClipped] = useState(false);
  const clipTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Peak hold logic: update peak without recursive effect loops
  useEffect(() => {
    setHoldL(prev => Math.max(prev, peakL));
  }, [peakL]);

  useEffect(() => {
    if (isStereo && peakR !== undefined) {
      setHoldR(prev => Math.max(prev, peakR));
    }
  }, [peakR, isStereo]);

  // Gentle periodic peak decay
  useEffect(() => {
    const decayTimer = setInterval(() => {
      setHoldL(prev => (prev > 0.01 ? prev * 0.93 : 0));
      setHoldR(prev => (prev > 0.01 ? prev * 0.93 : 0));
    }, 80);
    return () => clearInterval(decayTimer);
  }, []);

  // Clip indicator
  useEffect(() => {
    if (peakL >= 0.99 || (peakR !== undefined && peakR >= 0.99)) {
      setHasClipped(true);
      if (clipTimeoutRef.current) clearTimeout(clipTimeoutRef.current);
      clipTimeoutRef.current = setTimeout(() => setHasClipped(false), 2000);
    }
  }, [peakL, peakR]);

  const dbL = gainToDb(peakL);
  const dbR = isStereo && peakR !== undefined ? gainToDb(peakR) : dbL;

  // Percentage height from -60 dB to 0 dB
  const getPercent = (db: number) => {
    if (db <= -60) return 0;
    return Math.min(100, ((db + 60) / 60) * 100);
  };

  const pctL = getPercent(dbL);
  const pctR = getPercent(dbR);
  const pctHoldL = getPercent(gainToDb(holdL));
  const pctHoldR = getPercent(gainToDb(holdR));

  return (
    <div className="flex flex-col items-center gap-1">
      {/* Clip LED */}
      <div
        className={`w-3.5 h-2 rounded-xs border border-slate-700 transition-colors ${
          hasClipped ? 'bg-red-500 shadow-[0_0_8px_#EF4444]' : 'bg-red-950/40'
        }`}
        title="Clip Indicator"
      />

      <div className="flex items-center gap-1">
        {/* Left Channel Bar */}
        <div
          className="w-2.5 bg-slate-950 rounded-xs border border-slate-800 relative overflow-hidden flex flex-col justify-end"
          style={{ height }}
        >
          {/* LED Gradient Fill */}
          <div
            className="w-full transition-all duration-75"
            style={{
              height: `${pctL}%`,
              background: 'linear-gradient(to top, #22C55E 0%, #22C55E 70%, #EAB308 85%, #EF4444 100%)',
            }}
          />
          {/* Peak Hold Line */}
          {pctHoldL > 2 && (
            <div
              className="absolute w-full h-[2px] bg-white pointer-events-none transition-all duration-100"
              style={{ bottom: `${pctHoldL}%` }}
            />
          )}
        </div>

        {/* Right Channel Bar (if stereo) */}
        {isStereo && (
          <div
            className="w-2.5 bg-slate-950 rounded-xs border border-slate-800 relative overflow-hidden flex flex-col justify-end"
            style={{ height }}
          >
            <div
              className="w-full transition-all duration-75"
              style={{
                height: `${pctR}%`,
                background: 'linear-gradient(to top, #22C55E 0%, #22C55E 70%, #EAB308 85%, #EF4444 100%)',
              }}
            />
            {pctHoldR > 2 && (
              <div
                className="absolute w-full h-[2px] bg-white pointer-events-none transition-all duration-100"
                style={{ bottom: `${pctHoldR}%` }}
              />
            )}
          </div>
        )}

        {/* dB labels */}
        {showLabels && (
          <div
            className="flex flex-col justify-between text-[8px] font-mono text-slate-500 pl-1 select-none tabular-nums"
            style={{ height }}
          >
            <span>0</span>
            <span>-6</span>
            <span>-12</span>
            <span>-24</span>
            <span>-36</span>
            <span>-48</span>
            <span>-60</span>
          </div>
        )}
      </div>
    </div>
  );
};
