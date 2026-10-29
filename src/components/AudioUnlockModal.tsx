import React from 'react';
import { Volume2, Zap } from 'lucide-react';

interface AudioUnlockModalProps {
  onUnlock: () => void;
}

export const AudioUnlockModal: React.FC<AudioUnlockModalProps> = ({ onUnlock }) => {
  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-slate-900 border border-slate-700/80 rounded-xl p-6 shadow-2xl flex flex-col items-center text-center">
        <div className="w-14 h-14 rounded-full bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-blue-400 mb-4 animate-pulse">
          <Volume2 className="w-7 h-7" />
        </div>

        <h2 className="text-xl font-bold text-white mb-2 tracking-tight">
          Initialize Audio Engine
        </h2>

        <p className="text-sm text-slate-300 mb-6 leading-relaxed">
          Browser security policies (especially on <span className="text-blue-400 font-medium">iOS Safari</span> and <span className="text-blue-400 font-medium">Chrome</span>) require an initial user tap to enable real-time Web Audio rendering and multi-track mixing.
        </p>

        <button
          onClick={onUnlock}
          className="w-full py-3.5 px-6 rounded-lg bg-blue-600 hover:bg-blue-500 active:scale-[0.98] text-white font-semibold flex items-center justify-center gap-2 shadow-lg shadow-blue-600/30 transition-all cursor-pointer"
        >
          <Zap className="w-4 h-4 fill-white" />
          <span>Launch WaveForge Studio</span>
        </button>

        <span className="text-xs text-slate-400 mt-4">
          Optimized for low-latency playback · 4x 1GB WAV memory protection
        </span>
      </div>
    </div>
  );
};
