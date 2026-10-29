import React, { useState } from 'react';
import type { TrackData, MasterState } from '../types/audio';
import { TrackChannelStrip } from './TrackChannelStrip';
import { MasterChannelStrip } from './MasterChannelStrip';

interface MixingConsoleDeckProps {
  tracks: TrackData[];
  master: MasterState;
  onUpdateTrack: (updated: TrackData) => void;
  onUpdateMaster: (updated: MasterState) => void;
  onReverbDecayChange: (decay: number) => void;
}

export const MixingConsoleDeck: React.FC<MixingConsoleDeckProps> = ({
  tracks,
  master,
  onUpdateTrack,
  onUpdateMaster,
  onReverbDecayChange,
}) => {
  const [mobileSelectedTab, setMobileSelectedTab] = useState<string>('track-1');
  const anySolo = tracks.some(t => t.solo);

  return (
    <div className="h-[430px] md:h-[450px] bg-[#0A0D15] flex flex-col select-none shrink-0 border-t border-slate-800">
      {/* Mobile Channel Selector Tabs (visible on mobile / small screens) */}
      <div className="lg:hidden flex items-center justify-between bg-slate-950 p-2 border-b border-slate-800 overflow-x-auto gap-1">
        {tracks.map(track => (
          <button
            key={track.id}
            onClick={() => setMobileSelectedTab(track.id)}
            className={`px-3 py-1.5 rounded text-xs font-semibold whitespace-nowrap transition-all flex items-center gap-1.5 ${
              mobileSelectedTab === track.id
                ? 'bg-slate-800 text-white shadow-md'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: track.color }}
            />
            <span>{track.name.split('.')[1] || track.name}</span>
          </button>
        ))}

        <button
          onClick={() => setMobileSelectedTab('master')}
          className={`px-3 py-1.5 rounded text-xs font-bold whitespace-nowrap transition-all flex items-center gap-1.5 ${
            mobileSelectedTab === 'master'
              ? 'bg-purple-900/60 text-purple-200 border border-purple-500/50 shadow-md'
              : 'text-purple-400 hover:text-purple-200'
          }`}
        >
          <div className="w-2 h-2 rounded-full bg-purple-500" />
          <span>Master Bus</span>
        </button>
      </div>

      {/* Console Strips Viewport */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden flex items-stretch">
        {/* Desktop View: All strips displayed side by side */}
        <div className="hidden lg:flex items-stretch w-full">
          {tracks.map(track => (
            <TrackChannelStrip
              key={track.id}
              track={track}
              anySolo={anySolo}
              onUpdateTrack={onUpdateTrack}
            />
          ))}

          {/* Master Output Strip */}
          <MasterChannelStrip
            master={master}
            onUpdateMaster={onUpdateMaster}
            onReverbDecayChange={onReverbDecayChange}
          />
        </div>

        {/* Mobile View: Active Selected Tab Full Height Strip */}
        <div className="lg:hidden flex items-stretch justify-center w-full p-2">
          {mobileSelectedTab === 'master' ? (
            <div className="w-full max-w-sm flex justify-center">
              <MasterChannelStrip
                master={master}
                onUpdateMaster={onUpdateMaster}
                onReverbDecayChange={onReverbDecayChange}
              />
            </div>
          ) : (
            tracks
              .filter(t => t.id === mobileSelectedTab)
              .map(track => (
                <div key={track.id} className="w-full max-w-sm flex justify-center">
                  <TrackChannelStrip
                    track={track}
                    anySolo={anySolo}
                    onUpdateTrack={onUpdateTrack}
                  />
                </div>
              ))
          )}
        </div>
      </div>
    </div>
  );
};
