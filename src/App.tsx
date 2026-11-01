/**
 * WaveForge Studio - Professional 4-Track Browser Audio Mixer
 * Optimized for iOS Safari, Chrome, and Desktop
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { TrackData, MasterState, TransportState } from './types/audio';
import { createDemoStems, createEmptyTracks } from './audio/demoStems';
import { AudioEngine } from './audio/audioEngine';
import { extractWaveformPeaksFromBlob, parseWavHeader, createAdaptivePreviewBuffer, type ParsedWavHeader } from './audio/wavParser';
import { HeaderTransport } from './components/HeaderTransport';
import { TimelineDeck } from './components/TimelineDeck';
import { MixingConsoleDeck } from './components/MixingConsoleDeck';
import { ExportModal } from './components/ExportModal';
import { AudioUnlockModal } from './components/AudioUnlockModal';

export default function App() {
  const [tracks, setTracks] = useState<TrackData[]>(() => createEmptyTracks());
  const [master, setMaster] = useState<MasterState>({
    volume: 0,
    limiterEnabled: true,
    limiterThreshold: -0.5,
    reverbDecay: 1.8,
    eq: { lowGain: 0, midGain: 0, highGain: 0 },
    peakL: 0,
    peakR: 0,
    rmsL: 0,
    rmsR: 0,
  });

  const [transport, setTransport] = useState<TransportState>({
    isPlaying: false,
    currentTime: 0,
    duration: 16.0,
    isLooping: true,
    loopStart: 0,
    loopEnd: 16.0,
    bpm: 120,
  });

  const [engineState, setEngineState] = useState<AudioContextState>('suspended');
  const [showUnlockModal, setShowUnlockModal] = useState<boolean>(false);
  const [showExportModal, setShowExportModal] = useState<boolean>(false);

  const engineRef = useRef<AudioEngine | null>(null);
  const tracksRef = useRef<TrackData[]>(tracks);
  tracksRef.current = tracks;
  const masterRef = useRef<MasterState>(master);
  masterRef.current = master;
  const transportRef = useRef<TransportState>(transport);
  transportRef.current = transport;

  // Initialize engine & empty project
  useEffect(() => {
    let lastMeterTime = 0;
    const engine = new AudioEngine({
      onTimeUpdate: (time) => {
        setTransport(prev => ({ ...prev, currentTime: time }));
      },
      onMeterUpdate: (trackMeters, masterMeter) => {
        const now = performance.now();
        if (now - lastMeterTime < 40) return; // Cap meter state dispatch to ~25fps on mobile
        lastMeterTime = now;

        setTracks(prevTracks =>
          prevTracks.map(t => {
            const m = trackMeters.find(item => item.id === t.id);
            if (m) {
              return {
                ...t,
                peakMeterL: m.peakL,
                peakMeterR: m.peakR,
                gainReductionDb: m.gr,
              };
            }
            return t;
          })
        );

        setMaster(prev => ({
          ...prev,
          peakL: masterMeter.peakL,
          peakR: masterMeter.peakR,
        }));
      },
      onEnded: () => {
        setTransport(prev => ({ ...prev, isPlaying: false, currentTime: 0 }));
      },
      onStateChange: (state) => {
        setEngineState(state);
        if (state === 'running') {
          setShowUnlockModal(false);
        }
      },
    });

    engineRef.current = engine;

    // Detect if we need an initial unlock modal (iOS Safari or suspended context)
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    if (isIOS || engine.getContextState() === 'suspended') {
      setShowUnlockModal(true);
    }

    return () => {
      engine.destroy();
    };
  }, []);

  // Handle engine unlock tap
  const handleUnlockEngine = async () => {
    if (engineRef.current) {
      await engineRef.current.initContext();
      setShowUnlockModal(false);
    }
  };

  // Transport handlers
  const handlePlay = useCallback(async () => {
    if (!engineRef.current) return;
    await engineRef.current.play(tracksRef.current, transportRef.current.currentTime);
    setTransport(prev => ({ ...prev, isPlaying: true }));
  }, []);

  const handlePause = useCallback(() => {
    if (!engineRef.current) return;
    engineRef.current.pause();
    setTransport(prev => ({ ...prev, isPlaying: false }));
  }, []);

  const handleStop = useCallback(() => {
    if (!engineRef.current) return;
    engineRef.current.stop();
    setTransport(prev => ({ ...prev, isPlaying: false, currentTime: 0 }));
  }, []);

  const handleReturnToZero = useCallback(() => {
    if (!engineRef.current) return;
    engineRef.current.seek(0, tracksRef.current);
    setTransport(prev => ({ ...prev, currentTime: 0 }));
  }, []);

  const handleSeek = useCallback((seconds: number) => {
    if (!engineRef.current) return;
    engineRef.current.seek(seconds, tracksRef.current);
    setTransport(prev => ({ ...prev, currentTime: seconds }));
  }, []);

  const handleToggleLoop = useCallback(() => {
    const newLoop = !transportRef.current.isLooping;
    setTransport(prev => ({ ...prev, isLooping: newLoop }));
    if (engineRef.current) {
      engineRef.current.setLoop(newLoop, transportRef.current.loopStart, transportRef.current.loopEnd, tracksRef.current);
    }
  }, []);

  const handleBpmChange = useCallback((bpm: number) => {
    setTransport(prev => ({ ...prev, bpm: Math.max(40, Math.min(240, bpm)) }));
  }, []);

  // Keyboard shortcut listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in input
      if ((e.target as HTMLElement).tagName === 'INPUT') return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (transportRef.current.isPlaying) {
          handlePause();
        } else {
          handlePlay();
        }
      } else if (e.code === 'Home') {
        e.preventDefault();
        handleReturnToZero();
      } else if (e.code === 'Escape') {
        if (showExportModal) {
          setShowExportModal(false);
        } else {
          handleStop();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handlePlay, handlePause, handleStop, handleReturnToZero, showExportModal]);

  // Track state updates
  const handleUpdateTrack = useCallback((updated: TrackData) => {
    setTracks(prev => {
      const next = prev.map(t => (t.id === updated.id ? updated : t));
      const anySolo = next.some(t => t.solo);
      if (engineRef.current) {
        next.forEach(t => engineRef.current!.applyTrackParams(t, anySolo));
      }
      return next;
    });
  }, []);

  const handleTrackMute = useCallback((id: string) => {
    setTracks(prev => {
      const next = prev.map(t => (t.id === id ? { ...t, mute: !t.mute } : t));
      const anySolo = next.some(t => t.solo);
      if (engineRef.current) {
        next.forEach(t => engineRef.current!.applyTrackParams(t, anySolo));
      }
      return next;
    });
  }, []);

  const handleTrackSolo = useCallback((id: string) => {
    setTracks(prev => {
      const next = prev.map(t => (t.id === id ? { ...t, solo: !t.solo } : t));
      const anySolo = next.some(t => t.solo);
      if (engineRef.current) {
        next.forEach(t => engineRef.current!.applyTrackParams(t, anySolo));
      }
      return next;
    });
  }, []);

  const handleTrackVolume = useCallback((id: string, vol: number) => {
    setTracks(prev => {
      const next = prev.map(t => (t.id === id ? { ...t, volume: vol } : t));
      const anySolo = next.some(t => t.solo);
      if (engineRef.current) {
        next.forEach(t => engineRef.current!.applyTrackParams(t, anySolo));
      }
      return next;
    });
  }, []);

  // Master updates
  const handleUpdateMaster = useCallback((updated: MasterState) => {
    setMaster(updated);
    if (engineRef.current) {
      engineRef.current.applyMasterParams(updated);
    }
  }, []);

  const handleReverbDecayChange = useCallback((decay: number) => {
    if (engineRef.current) {
      engineRef.current.updateReverbImpulse(decay);
    }
  }, []);

  // Large File Ingestion (Memory safe streaming playback <20MB RAM for 60-min files)
  const handleFileUpload = useCallback(async (trackId: string, file: File) => {
    // 1. Mark track as decoding
    setTracks(prev =>
      prev.map(t => (t.id === trackId ? { ...t, isDecoding: true, decodeProgress: 5 } : t))
    );

    try {
      // Clean up previous Object URL if replacing track
      const existingTrack = tracksRef.current.find(t => t.id === trackId);
      if (existingTrack?.mediaSourceUrl) {
        URL.revokeObjectURL(existingTrack.mediaSourceUrl);
      }

      // 1. Parse WAV RIFF header if available via bounded 64KB slice
      let header: ParsedWavHeader | null = null;
      let fileDuration = 0;
      try {
        const headerSlice = await file.slice(0, 65536).arrayBuffer();
        header = parseWavHeader(headerSlice, file.size);
        fileDuration = header.durationSec;
      } catch {
        header = null;
      }

      // 2. For non-WAV formats (MP3, AAC, M4A), probe duration with temporary probe element and revoke immediately
      let mediaSourceUrl: string | undefined = undefined;
      if (!header || fileDuration <= 0) {
        const probeUrl = URL.createObjectURL(file);
        fileDuration = await new Promise<number>((resolve) => {
          const probe = new Audio();
          probe.preload = 'metadata';
          probe.src = probeUrl;
          const onMeta = () => {
            cleanup();
            resolve(probe.duration && isFinite(probe.duration) ? probe.duration : 60);
          };
          const onErr = () => {
            cleanup();
            resolve(60);
          };
          const cleanup = () => {
            probe.removeEventListener('loadedmetadata', onMeta);
            probe.removeEventListener('error', onErr);
            URL.revokeObjectURL(probeUrl);
          };
          probe.addEventListener('loadedmetadata', onMeta);
          probe.addEventListener('error', onErr);
        });
      }

      // 3. Extract downsampled peak envelope via sequential 1 MB slices (constant memory footprint)
      const peaks = await extractWaveformPeaksFromBlob(file, 600, pct => {
        setTracks(prev =>
          prev.map(t => (t.id === trackId ? { ...t, decodeProgress: Math.round(pct) } : t))
        );
      });

      // 4. Connect streaming audio source to Web Audio DSP engine
      if (engineRef.current) {
        const trackIndex = ['track-1', 'track-2', 'track-3', 'track-4'].indexOf(trackId);
        if (trackIndex >= 0 && header) {
          engineRef.current.attachStreamingWavTrack(trackIndex, trackId, file, header);
        } else if (mediaSourceUrl) {
          engineRef.current.attachTrackMedia(trackId, mediaSourceUrl, fileDuration);
        }
        engineRef.current.setDuration(Math.max(engineRef.current.getDuration(), fileDuration));
        engineRef.current.setLoop(transport.isLooping, transport.loopStart, Math.max(transport.loopEnd, fileDuration));
      }

      // Update transport duration to accommodate loaded audio
      setTransport(prev => ({
        ...prev,
        duration: Math.max(prev.duration, fileDuration),
        loopEnd: Math.max(prev.loopEnd, fileDuration),
      }));

      // Store streaming track reference (zero full-duration PCM buffer in RAM)
      setTracks(prev =>
        prev.map(t => {
          if (t.id === trackId) {
            return {
              ...t,
              name: file.name.replace(/\.[^/.]+$/, '').slice(0, 20),
              fileInfo: {
                name: file.name,
                sizeBytes: file.size,
                sampleRate: header?.sampleRate || 44100,
                bitDepth: header?.bitsPerSample || 16,
                channels: header?.channels || 2,
                durationSec: fileDuration,
                isStreamingCache: true,
              },
              peaks,
              audioBuffer: null, // Avoid monolithic multi-gigabyte buffer
              mediaSourceUrl,
              sourceBlob: file,
              parsedHeader: header,
              isDecoding: false,
              decodeProgress: 100,
            };
          }
          return t;
        })
      );
    } catch (err) {
      console.error('File streaming attachment failed:', err);
      setTracks(prev =>
        prev.map(t => (t.id === trackId ? { ...t, isDecoding: false } : t))
      );
    }
  }, [transport.isLooping, transport.loopStart, transport.loopEnd]);

  const handleResetTrackToDemo = useCallback((trackId: string) => {
    const existing = tracksRef.current.find(t => t.id === trackId);
    if (existing?.mediaSourceUrl) {
      URL.revokeObjectURL(existing.mediaSourceUrl);
    }
    if (engineRef.current) {
      engineRef.current.clearTrackMedia(trackId);
    }

    const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const tempCtx = new AudioCtxClass();
    const demoTracks = createDemoStems(tempCtx);
    const demo = demoTracks.find(t => t.id === trackId);
    if (demo) {
      setTracks(prev => prev.map(t => (t.id === trackId ? demo : t)));
      setTransport(prev => ({
        ...prev,
        duration: Math.max(prev.duration, demo.fileInfo?.durationSec || 16.0),
        loopEnd: Math.max(prev.loopEnd, demo.fileInfo?.durationSec || 16.0),
      }));
    }
    tempCtx.close();
  }, []);

  const handleLoadAllDemoStems = useCallback(() => {
    try {
      tracksRef.current.forEach(t => {
        if (t.mediaSourceUrl) URL.revokeObjectURL(t.mediaSourceUrl);
        if (engineRef.current) engineRef.current.clearTrackMedia(t.id);
      });

      const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const tempCtx = new AudioCtxClass();
      const demoTracks = createDemoStems(tempCtx);
      setTracks(demoTracks);
      setTransport(prev => ({
        ...prev,
        duration: 16.0,
        loopEnd: 16.0,
      }));
      tempCtx.close();
    } catch (err) {
      console.warn('Demo stems load failed:', err);
    }
  }, []);

  const handleClearAllTracks = useCallback(() => {
    tracksRef.current.forEach(t => {
      if (t.mediaSourceUrl) URL.revokeObjectURL(t.mediaSourceUrl);
      if (engineRef.current) engineRef.current.clearTrackMedia(t.id);
    });

    if (engineRef.current) {
      engineRef.current.stop();
    }
    setTracks(createEmptyTracks());
    setTransport(prev => ({
      ...prev,
      isPlaying: false,
      currentTime: 0,
      duration: 16.0,
      loopEnd: 16.0,
    }));
  }, []);

  const hasTracksLoaded = tracks.some(t => Boolean(t.audioBuffer || t.sourceBlob || t.mediaSourceUrl || t.peaks));

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#080B10] text-slate-100 font-sans">
      {/* iOS Safari / Chrome Audio Unlock Banner/Modal */}
      {showUnlockModal && (
        <AudioUnlockModal onUnlock={handleUnlockEngine} />
      )}

      {/* Top Header & Transport Bar */}
      <HeaderTransport
        isPlaying={transport.isPlaying}
        currentTime={transport.currentTime}
        duration={transport.duration}
        isLooping={transport.isLooping}
        bpm={transport.bpm}
        engineState={engineState}
        hasTracksLoaded={hasTracksLoaded}
        onPlay={handlePlay}
        onPause={handlePause}
        onStop={handleStop}
        onReturnToZero={handleReturnToZero}
        onToggleLoop={handleToggleLoop}
        onBpmChange={handleBpmChange}
        onOpenExport={() => setShowExportModal(true)}
        onLoadAllDemoStems={handleLoadAllDemoStems}
        onClearAllTracks={handleClearAllTracks}
      />

      {/* Timeline Deck (Upper half) */}
      <TimelineDeck
        tracks={tracks}
        currentTime={transport.currentTime}
        duration={transport.duration}
        isLooping={transport.isLooping}
        loopStart={transport.loopStart}
        loopEnd={transport.loopEnd}
        onSeek={handleSeek}
        onTrackMute={handleTrackMute}
        onTrackSolo={handleTrackSolo}
        onTrackVolume={handleTrackVolume}
        onFileUpload={handleFileUpload}
        onResetTrackToDemo={handleResetTrackToDemo}
      />

      {/* Mixing Console Deck (Lower half) */}
      <MixingConsoleDeck
        tracks={tracks}
        master={master}
        onUpdateTrack={handleUpdateTrack}
        onUpdateMaster={handleUpdateMaster}
        onReverbDecayChange={handleReverbDecayChange}
      />

      {/* Export Mixdown WAV Modal */}
      {showExportModal && (
        <ExportModal
          tracks={tracks}
          master={master}
          onClose={() => setShowExportModal(false)}
        />
      )}
    </div>
  );
}
