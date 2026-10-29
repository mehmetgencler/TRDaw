import React, { useRef, useState, useCallback, useEffect } from 'react';

interface KnobControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  defaultValue?: number;
  step?: number;
  unit?: string;
  size?: 'sm' | 'md';
  color?: string;
  onChange: (val: number) => void;
}

export const KnobControl: React.FC<KnobControlProps> = ({
  label,
  value,
  min,
  max,
  defaultValue = 0,
  step = 0.1,
  unit = '',
  size = 'md',
  color = '#3B82F6',
  onChange,
}) => {
  const knobRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartYRef = useRef(0);
  const dragStartValRef = useRef(value);

  // Normalize value to [0, 1]
  const normalized = Math.max(0, Math.min(1, (value - min) / (max - min)));
  // Angle: -135deg (min) to +135deg (max) => 270deg total sweep
  const angle = -135 + normalized * 270;

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    setIsDragging(true);
    dragStartYRef.current = e.clientY;
    dragStartValRef.current = value;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging) return;
      const deltaY = dragStartYRef.current - e.clientY;
      const range = max - min;
      // 150px drag moves through the full range
      const stepChange = (deltaY / 150) * range;
      let newVal = dragStartValRef.current + stepChange;
      if (step > 0) {
        newVal = Math.round(newVal / step) * step;
      }
      newVal = Math.max(min, Math.min(max, newVal));
      onChange(Number(newVal.toFixed(2)));
    },
    [isDragging, max, min, step, onChange]
  );

  const handlePointerUp = (e: React.PointerEvent) => {
    setIsDragging(false);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const handleDoubleClick = () => {
    onChange(defaultValue);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? step * 2 : -step * 2;
    const newVal = Math.max(min, Math.min(max, value + delta));
    onChange(Number(newVal.toFixed(2)));
  };

  const diameter = size === 'sm' ? 36 : 46;
  const strokeWidth = size === 'sm' ? 3 : 3.5;
  const radius = (diameter - strokeWidth * 2) / 2;
  const center = diameter / 2;
  const circumference = 2 * Math.PI * radius;
  // 270 degrees arc length = 75% of circumference
  const arcLength = circumference * 0.75;
  const dashOffset = arcLength * (1 - normalized);

  return (
    <div className="flex flex-col items-center gap-1 select-none">
      <div
        ref={knobRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onWheel={handleWheel}
        className={`relative flex items-center justify-center cursor-ns-resize transition-transform duration-75 ${
          isDragging ? 'scale-105' : ''
        }`}
        style={{
          width: diameter,
          height: diameter,
          touchAction: 'none',
        }}
        role="slider"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
      >
        {/* Background Arc SVG */}
        <svg
          width={diameter}
          height={diameter}
          className="absolute inset-0 rotate-[135deg] pointer-events-none"
        >
          {/* Base track */}
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="#1F2937"
            strokeWidth={strokeWidth}
            strokeDasharray={`${arcLength} ${circumference}`}
            strokeLinecap="round"
          />
          {/* Active arc */}
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeDasharray={`${arcLength} ${circumference}`}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
          />
        </svg>

        {/* Knob Cap */}
        <div
          className="rounded-full bg-linear-to-b from-slate-700 to-slate-900 border border-slate-600/60 shadow-md flex items-center justify-center relative pointer-events-none"
          style={{
            width: diameter - 10,
            height: diameter - 10,
            transform: `rotate(${angle}deg)`,
          }}
        >
          {/* Pointer indicator notch */}
          <div
            className="w-0.5 rounded-full absolute top-1"
            style={{
              height: size === 'sm' ? 6 : 8,
              backgroundColor: isDragging ? '#FFFFFF' : color,
              boxShadow: isDragging ? `0 0 6px ${color}` : 'none',
            }}
          />
        </div>
      </div>

      {/* Label & Value */}
      <div className="flex flex-col items-center leading-none">
        <span className="text-[10px] font-medium text-slate-400 tracking-wider uppercase truncate max-w-[56px]">
          {label}
        </span>
        <span className="text-[10px] font-mono font-medium text-slate-200 tabular-nums">
          {value > 0 && unit.includes('dB') ? `+${value}` : value}
          <span className="text-slate-500 text-[9px] ml-0.5">{unit}</span>
        </span>
      </div>
    </div>
  );
};
