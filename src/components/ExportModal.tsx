import React, { useState } from 'react';
import { X, Download, CheckCircle, AlertTriangle, Play, Pause, HardDrive } from 'lucide-react';
import type { TrackData, MasterState, ExportSettings } from '../types/audio';
import { renderMixdownWav } from '../audio/wavEncoder';

interface ExportModalProps {
  tracks: TrackData[];
  master: MasterState;
  onClose: () => void;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  tracks,
  master,
  onClose,
}) => {
  // Detect native sample rate from loaded tracks
  const detectedRate = (tracks.find(t => t.fileInfo?.sampleRate)?.fileInfo?.sampleRate ||
    tracks.find(t => t.audioBuffer)?.audioBuffer?.sampleRate ||
    48000) as 44100 | 48000;

  const [settings, setSettings] = useState<ExportSettings>({
    format: 'wav-24',
    sampleRate: detectedRate === 44100 ? 44100 : 48000,
    range: 'preview-5m',
    normalize: false,
    bypassCompressors: true,
    bypassLimiter: true,
  });

  const maxTrackDuration = tracks.reduce((max, t) => {
    const dur = t.fileInfo?.durationSec || (t.audioBuffer ? t.audioBuffer.duration : 0);
    return Math.max(max, dur);
  }, 16.0);

  const effectiveDuration = settings.range === 'preview-5m'
    ? Math.min(300, maxTrackDuration)
    : settings.range === 'loop'
    ? Math.min(60, maxTrackDuration)
    : maxTrackDuration;

  const bytesPerSample = (settings.format === 'wav-32f' ? 32 : settings.format === 'wav-24' ? 24 : 16) / 8;
  const estimatedSizeBytes = 44 + Math.floor(effectiveDuration * settings.sampleRate) * 2 * bytesPerSample;
  const estimatedSizeMb = estimatedSizeBytes / (1024 * 1024);
  const isLargeForMobile = estimatedSizeMb > 250;

  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [exportedBlob, setExportedBlob] = useState<Blob | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null);

  const handleStartExport = async () => {
    setIsExporting(true);
    setProgress(0);
    try {
      const blob = await renderMixdownWav(tracks, master, settings, pct => {
        setProgress(pct);
      });

      setExportedBlob(blob);
      const url = URL.createObjectURL(blob);
      setDownloadUrl(url);
      setPreviewAudioUrl(url);
    } catch (err) {
      console.error('Export failed:', err);
    } finally {
      setIsExporting(false);
    }
  };

  const handleTriggerDownload = () => {
    if (!downloadUrl) return;
    const dateStr = new Date().toISOString().slice(0, 10);
    const bitStr = settings.format === 'wav-32f' ? '32bit_Float' : settings.format === 'wav-24' ? '24bit' : '16bit';
    const filename = `WaveForge_Mixdown_${bitStr}_${settings.sampleRate}Hz_${dateStr}.wav`;

    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="max-w-lg w-full bg-[#111622] border border-slate-700 rounded-xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 bg-[#0D121D] border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Download className="w-5 h-5 text-emerald-400" />
            <h2 className="text-base font-bold text-white tracking-tight">
              Export Mixdown WAV
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <div className="p-5 flex flex-col gap-4 text-xs">
          {/* Format Selection */}
          <div className="flex flex-col gap-1.5">
            <label className="text-slate-300 font-semibold uppercase tracking-wider text-[10px]">
              Audio Bit Depth & Encoding
            </label>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setSettings({ ...settings, format: 'wav-16' })}
                className={`py-2 px-3 rounded-lg border text-center transition-all ${
                  settings.format === 'wav-16'
                    ? 'bg-blue-600/20 border-blue-500 text-blue-200 font-bold'
                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <div>16-Bit PCM</div>
                <div className="text-[10px] text-slate-500 font-normal">CD Standard</div>
              </button>

              <button
                type="button"
                onClick={() => setSettings({ ...settings, format: 'wav-24' })}
                className={`py-2 px-3 rounded-lg border text-center transition-all ${
                  settings.format === 'wav-24'
                    ? 'bg-emerald-600/20 border-emerald-500 text-emerald-200 font-bold'
                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <div>24-Bit PCM</div>
                <div className="text-[10px] text-emerald-400/80 font-normal">Studio Master</div>
              </button>

              <button
                type="button"
                onClick={() => setSettings({ ...settings, format: 'wav-32f' })}
                className={`py-2 px-3 rounded-lg border text-center transition-all ${
                  settings.format === 'wav-32f'
                    ? 'bg-purple-600/20 border-purple-500 text-purple-200 font-bold'
                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <div>32-Bit Float</div>
                <div className="text-[10px] text-slate-500 font-normal">High Dynamic Range</div>
              </button>
            </div>
          </div>

          {/* Sample Rate */}
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-slate-300 font-semibold uppercase tracking-wider text-[10px]">
                Sample Rate
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setSettings({ ...settings, sampleRate: 44100 })}
                  className={`flex-1 py-1.5 rounded-lg border text-center transition-all ${
                    settings.sampleRate === 44100
                      ? 'bg-slate-800 border-slate-600 text-white font-bold'
                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  44.1 kHz
                </button>
                <button
                  type="button"
                  onClick={() => setSettings({ ...settings, sampleRate: 48000 })}
                  className={`flex-1 py-1.5 rounded-lg border text-center transition-all ${
                    settings.sampleRate === 48000
                      ? 'bg-slate-800 border-slate-600 text-white font-bold'
                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  48.0 kHz
                </button>
              </div>
            </div>

            {/* Dynamics & Mastering Overrides */}
            <div className="flex flex-col gap-1.5 col-span-2">
              <div className="flex items-center justify-between">
                <label className="text-slate-300 font-semibold uppercase tracking-wider text-[10px]">
                  Mixdown Dynamics & Limiting
                </label>
                <span className="text-[10px] text-emerald-400 font-mono">
                  {settings.bypassCompressors && settings.bypassLimiter ? 'Clean / Transparent Export' : 'Mastering DSP Active'}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex items-center gap-2 p-2 rounded-lg bg-slate-900 border border-slate-800 cursor-pointer hover:border-slate-700 transition-colors">
                  <input
                    type="checkbox"
                    checked={!settings.bypassCompressors}
                    onChange={e => setSettings({ ...settings, bypassCompressors: !e.target.checked })}
                    className="rounded text-emerald-500 focus:ring-0 bg-slate-800 border-slate-700"
                  />
                  <div className="flex flex-col">
                    <span className="text-slate-300 font-medium">Track Compressors</span>
                    <span className="text-[10px] text-slate-500">
                      {settings.bypassCompressors ? 'Bypassed (Clean)' : 'Active dynamics'}
                    </span>
                  </div>
                </label>

                <label className="flex items-center gap-2 p-2 rounded-lg bg-slate-900 border border-slate-800 cursor-pointer hover:border-slate-700 transition-colors">
                  <input
                    type="checkbox"
                    checked={!settings.bypassLimiter}
                    onChange={e => setSettings({ ...settings, bypassLimiter: !e.target.checked })}
                    className="rounded text-emerald-500 focus:ring-0 bg-slate-800 border-slate-700"
                  />
                  <div className="flex flex-col">
                    <span className="text-slate-300 font-medium">Master Limiter</span>
                    <span className="text-[10px] text-slate-500">
                      {settings.bypassLimiter ? 'Bypassed (Clean)' : 'Peak ceiling limiter'}
                    </span>
                  </div>
                </label>
              </div>
            </div>
          </div>

          {/* Export Range Selection */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-slate-300 font-semibold uppercase tracking-wider text-[10px]">
                Export Range
              </label>
              <span className="text-[10px] font-mono text-emerald-400">
                Est. Size: ~{estimatedSizeMb.toFixed(1)} MB
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setSettings({ ...settings, range: 'full' })}
                className={`py-1.5 px-2 rounded-lg border text-center transition-all ${
                  settings.range === 'full'
                    ? 'bg-blue-600/20 border-blue-500 text-blue-200 font-bold'
                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <div>Full Song</div>
                <div className="text-[9px] text-slate-500 font-normal">Entire Mix</div>
              </button>

              <button
                type="button"
                onClick={() => setSettings({ ...settings, range: 'preview-5m' })}
                className={`py-1.5 px-2 rounded-lg border text-center transition-all ${
                  settings.range === 'preview-5m'
                    ? 'bg-emerald-600/20 border-emerald-500 text-emerald-200 font-bold'
                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <div>5-Min Preview</div>
                <div className="text-[9px] text-emerald-400/80 font-normal">iOS Safari Safe</div>
              </button>

              <button
                type="button"
                onClick={() => setSettings({ ...settings, range: 'loop' })}
                className={`py-1.5 px-2 rounded-lg border text-center transition-all ${
                  settings.range === 'loop'
                    ? 'bg-purple-600/20 border-purple-500 text-purple-200 font-bold'
                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                <div>Loop Region</div>
                <div className="text-[9px] text-slate-500 font-normal">Active Region</div>
              </button>
            </div>
          </div>

          {/* Memory Protection Callout & iOS Advisory */}
          <div className="p-3 rounded-lg bg-slate-950/70 border border-slate-800 flex items-start gap-2.5">
            <HardDrive className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <div className="text-[11px] text-slate-400 leading-relaxed">
              <strong className="text-slate-200">Progressive 5s Chunked Mixdown:</strong> Mixdown runs via 5-second chunked summation, keeping RAM overhead under 5 MB during render.
              {isLargeForMobile && (
                <div className="mt-1 text-amber-300 font-semibold flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>iOS Safari Advisory: Mixes &gt;250 MB may exceed mobile WebContent memory limits. If exporting 60-min files on an iPhone, export via 5-Min Preview or Loop Region.</span>
                </div>
              )}
            </div>
          </div>

          {/* Progress Bar (when exporting) */}
          {isExporting && (
            <div className="flex flex-col gap-1.5 pt-2">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-300">Rendering master stems...</span>
                <span className="font-mono text-emerald-400 font-bold">{progress}%</span>
              </div>
              <div className="w-full h-2 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                <div
                  className="h-full bg-emerald-500 transition-all duration-150"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Export Complete State */}
          {exportedBlob && !isExporting && (
            <div className="p-3 rounded-lg bg-emerald-950/30 border border-emerald-500/40 flex flex-col gap-2">
              <div className="flex items-center gap-2 text-emerald-400 font-semibold">
                <CheckCircle className="w-4 h-4" />
                <span>Mixdown Ready ({((exportedBlob.size) / (1024 * 1024)).toFixed(2)} MB)</span>
              </div>

              {previewAudioUrl && (
                <audio controls src={previewAudioUrl} className="w-full h-8 mt-1" />
              )}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-4 bg-[#0D121D] border-t border-slate-800 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium transition-colors cursor-pointer"
          >
            Close
          </button>

          {!exportedBlob ? (
            <button
              onClick={handleStartExport}
              disabled={isExporting}
              className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 active:scale-[0.98] disabled:opacity-50 text-white font-semibold flex items-center gap-2 shadow-lg shadow-emerald-600/30 transition-all cursor-pointer"
            >
              <Download className="w-4 h-4" />
              <span>{isExporting ? 'Rendering...' : 'Render Mixdown'}</span>
            </button>
          ) : (
            <button
              onClick={handleTriggerDownload}
              className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 active:scale-[0.98] text-white font-semibold flex items-center gap-2 shadow-lg shadow-blue-600/30 transition-all cursor-pointer"
            >
              <Download className="w-4 h-4" />
              <span>Download WAV File</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
