import React, { useRef, useState, useCallback } from 'react';
import { clamp } from '../audio/math';

interface VerticalFaderProps {
  value: number; // dB (-60 to +6)
  min?: number;  // -60
  max?: number;  // +6
  height?: number;
  color?: string;
  onChange: (val: number) => void;
}

export const VerticalFader: React.FC<VerticalFaderProps> = ({
  value,
  min = -60,
  max = 6,
  height = 180,
  color = '#3B82F6',
  onChange,
}) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Nonlinear fader mapping: gives much more resolution around -12 dB to +6 dB
  // Linear 0 at bottom (-60 dB) to 1 at top (+6 dB), 0 dB at ~75% position
  const dbToPosition = (db: number): number => {
    if (db <= -60) return 0;
    if (db <= -24) {
      // -60 to -24 dB => 0% to 25% height
      return ((db + 60) / 36) * 0.25;
    }
    if (db <= -6) {
      // -24 to -6 dB => 25% to 60% height
      return 0.25 + ((db + 24) / 18) * 0.35;
    }
    if (db <= 0) {
      // -6 to 0 dB => 60% to 80% height
      return 0.60 + ((db + 6) / 6) * 0.20;
    }
    // 0 to +6 dB => 80% to 100% height
    return 0.80 + (db / 6) * 0.20;
  };

  const positionToDb = (pos: number): number => {
    pos = clamp(pos, 0, 1);
    if (pos <= 0.02) return -60;
    if (pos <= 0.25) {
      return -60 + (pos / 0.25) * 36;
    }
    if (pos <= 0.60) {
      return -24 + ((pos - 0.25) / 0.35) * 18;
    }
    if (pos <= 0.80) {
      return -6 + ((pos - 0.60) / 0.20) * 6;
    }
    return ((pos - 0.80) / 0.20) * 6;
  };

  const normPos = dbToPosition(value);

  const updateFromPointer = useCallback(
    (clientY: number) => {
      if (!trackRef.current) return;
      const rect = trackRef.current.getBoundingClientRect();
      const relativeY = rect.bottom - clientY;
      const fraction = clamp(relativeY / rect.height, 0, 1);
      const newDb = positionToDb(fraction);
      onChange(Number(newDb.toFixed(1)));
    },
    [onChange]
  );

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    setIsDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    updateFromPointer(e.clientY);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging) return;
    updateFromPointer(e.clientY);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    setIsDragging(false);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const handleDoubleClick = () => {
    onChange(0); // Reset to 0 dB
  };

  return (
    <div className="flex items-center gap-1.5 select-none py-1">
      {/* dB Scale Marks */}
      <div
        className="flex flex-col justify-between text-[9px] font-mono text-slate-500 text-right pr-1 select-none pointer-events-none tabular-nums"
        style={{ height }}
      >
        <span>+6</span>
        <span className="text-slate-300 font-semibold">0</span>
        <span>-6</span>
        <span>-12</span>
        <span>-24</span>
        <span>-48</span>
        <span>-∞</span>
      </div>

      {/* Fader Track & Thumb */}
      <div
        ref={trackRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        className="relative w-8 cursor-ns-resize flex justify-center py-2 group"
        style={{ height, touchAction: 'none' }}
        role="slider"
        aria-label="Track Volume Fader"
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
      >
        {/* Track Slot Cutout */}
        <div className="w-1.5 h-full bg-slate-950 rounded-full border border-slate-800 shadow-inner relative flex justify-center overflow-hidden">
          {/* Active Level Color Fill */}
          <div
            className="w-full absolute bottom-0 transition-all duration-75"
            style={{
              height: `${normPos * 100}%`,
              backgroundColor: value > 0 ? '#EF4444' : color,
              opacity: 0.7,
            }}
          />
          {/* Zero dB guide mark */}
          <div
            className="absolute w-full h-[1px] bg-slate-400"
            style={{ bottom: '80%' }}
          />
        </div>

        {/* Fader Thumb Knob */}
        <div
          className={`absolute w-8 h-10 rounded-sm bg-linear-to-b from-slate-200 via-slate-300 to-slate-400 border border-slate-400 shadow-lg flex flex-col items-center justify-center pointer-events-none transition-shadow ${
            isDragging ? 'shadow-blue-500/40 ring-1 ring-blue-400' : 'group-hover:brightness-105'
          }`}
          style={{
            bottom: `calc(${normPos * 100}% - 20px)`,
          }}
        >
          {/* Textured grip ridges */}
          <div className="w-5 h-[1.5px] bg-slate-500 mb-0.5 rounded-full" />
          {/* Center line marker */}
          <div
            className="w-6 h-[2px] rounded-full my-0.5"
            style={{ backgroundColor: color }}
          />
          <div className="w-5 h-[1.5px] bg-slate-500 mt-0.5 rounded-full" />
        </div>
      </div>
    </div>
  );
};
