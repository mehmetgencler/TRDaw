# WaveForge Studio: Cross-Platform Browser Audio Mixer (iOS Safari, Chrome, Desktop)

A professional multi-track digital audio workstation (DAW) and mixer engineered specifically for seamless operation across **iOS Mobile Safari**, **Desktop/Mobile Chrome**, and modern web browsers. The architecture handles massive uncompressed WAV files (up to 1GB per track, 4 tracks total) without triggering iOS WebKit *Jetsam* memory termination, browser heap crashes, or audio stutter.

---

### User Review & Critical Decisions

> [!IMPORTANT]
> **Revised Multi-Platform & Mobile Strategy (iOS Safari, Chrome & Desktop)**:
> 1. **Aggressive Chunked Memory Guard for iOS WebKit**: iOS Safari enforces a strict per-tab memory ceiling (~1.5GB–2GB total, but allocations above ~300MB can trigger immediate background tab reload via `Jetsam`). We implement a **Zero-Monolithic-Allocation rule**: 1GB WAV files are parsed via progressive `File.slice()` chunks (4MB slices) for metadata and waveform peak extraction. The playback engine uses an ultra-efficient downsampled preview buffer (22.05kHz/32kHz stereo) consuming <20MB RAM per track (<80MB total for all 4 tracks), keeping the browser well under safe thresholds on all iPhones and iPads.
> 2. **iOS Safari AudioContext Unlock & Hardware Lifecycle**: Safari on iOS automatically locks `AudioContext` in `suspended` mode and mutes audio until an explicit user touch event. The app includes a dedicated, frictionless audio unlock system with visual engine status, sample-rate auto-negotiation (44.1kHz / 48kHz matching device output), and background audio interruption recovery (`statechange` event handling).
> 3. **Chunked Mixdown WAV Export for Mobile**: Rather than allocating a single multi-gigabyte Float32Array in WebKit memory during mixdown, the exporter renders and encodes the WAV file in progressive 5-second streaming chunks, streaming into a Blob with memory release at each step.
> 4. **Adaptive Studio Layout (Desktop Console + iOS Mobile Touch Deck)**:
>    - **Desktop / Tablet (>= 1024px)**: Full dual-deck layout with 4 timeline waveform tracks on top and a 5-channel analog console below (4 channel strips + 1 master strip).
>    - **iOS Mobile Portrait (<= 768px)**: Compact top transport with timecode, compact synchronized multi-track overview, and a swipeable/tabbed high-precision touch channel strip deck ($\ge 48\text{px}$ touch targets, `touch-action: none` for fluid non-scrolling fader slides).
>    - **iOS Mobile Landscape**: Auto-adapts to a wide 5-strip console view.

---

### 1. Overview & Core Concept

- **What It Does**: WaveForge Studio provides a zero-install, studio-grade audio mixing environment that runs inside Chrome, iOS Safari, macOS Safari, and Edge. Users can load up to four 1GB WAV stems, balance levels, apply 3-band parametric EQ, adjust dynamics compression, route through a master spatial reverb send, and render a pristine mixdown WAV file directly on their mobile device or desktop.
- **Target Audience**: Audio engineers, field recordists, podcast producers, beatmakers, and musicians who need to audition, tweak, balance, and export stem mixes on an iPhone, iPad, laptop, or desktop without installing software.
- **Key Value**: Guarantees rock-solid stability on memory-constrained mobile devices (iOS Safari) while delivering high-speed desktop performance and studio-accurate audio export.

---

### 2. Cross-Browser & Mobile Architecture

#### A. iOS Safari vs. Chrome Strategy Matrix

| Dimension | iOS Safari / WebKit | Chrome (Desktop & Android) | WaveForge Architecture Solution |
| :--- | :--- | :--- | :--- |
| **Max Memory Budget** | Strict tab cap (~1.5GB; crashes on >300MB burst) | High heap (>2GB–4GB+) | Progressive `File.slice()` chunk reader (4MB blocks). Downsampled 22.05kHz preview buffer (<20MB per track). |
| **AudioContext Activation** | Suspended until explicit `touchstart`/`pointerdown` | Suspended until user click/key | Clear "Start Audio Engine" tap affordance; silent buffer warm-up on first touch. |
| **Sample Rate Sync** | Strictly tied to hardware (44.1kHz or 48kHz) | Flexible internal resampling | Dynamically initializes `AudioContext` matching `ctx.sampleRate`; auto-resamples preview buffers. |
| **File Export & Download** | Blob URL download requires direct user tap handler | Supports `showSaveFilePicker` and `a[download]` | Universal blob anchor trigger with iOS Safari fallback modal ("Save / Share WAV"). |
| **Touch vs. Mouse Controls** | Requires touch event handling with preventDefault | Standard drag/mouse events | Unified pointer events (`pointerdown`, `pointermove`, `pointerup`) with `touch-action: none`. |

#### B. The 1GB WAV Processing Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       1GB WAV File on Disk / Device                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
      ┌────────────────────────────────────────────────────────┐
      │  Chunked File Slice Header Parser (First 4KB - 64KB)   │
      │  • Validates RIFF / WAVE format chunk                  │
      │  • Extracts Channels, Bit Depth (16/24/32), Rate (Hz)  │
      │  • Computes exact duration & audio sample count        │
      └────────────────────────────────────────────────────────┘
                                  │
                                  ▼
      ┌────────────────────────────────────────────────────────┐
      │  Progressive Waveform Peak Extractor (4MB Chunks)      │
      │  • Reads file in streaming 4MB slices                  │
      │  • Computes min/max peak decimation (256 samples/px)   │
      │  • Total memory overhead: < 128KB per track            │
      └────────────────────────────────────────────────────────┘
                                  │
                                  ▼
      ┌────────────────────────────────────────────────────────┐
      │  Lightweight Playback Preview Buffer Generation        │
      │  • Decodes downsampled preview (22.05kHz stereo)       │
      │  • Consumes ~15MB - 25MB RAM per 1GB track             │
      │  • 4 tracks total: ~70MB RAM (Safe for iOS!)           │
      └────────────────────────────────────────────────────────┘
                                  │
                ┌─────────────────┴─────────────────┐
                ▼                                   ▼
┌───────────────────────────────┐   ┌───────────────────────────────┐
│     Real-Time Mixing Engine   │   │  Full-Res Mixdown WAV Exporter│
│  • Web Audio DSP Graph        │   │  • Progressive time-slice DSP │
│  • 3-Band EQ per track        │   │  • 16/24/32-bit PCM encoder   │
│  • Compressor + Reverb Aux    │   │  • Memory-safe chunked export │
│  • Solo / Mute / Pan / Fader  │   │  • Downloads .wav on device   │
└───────────────────────────────┘   └───────────────────────────────┘
```

---

### 3. User Experience & Visual Design

#### A. Responsive Layout Modes
1. **Desktop View (1440px wide baseline)**:
   - **Top Transport Bar**: Project name, Play/Pause/Stop/RTZ controls, Loop toggle, Tempo BPM, Timecode counter (`00:00.000` & `Bar:Beat:Tick`), Master volume meter, and "Export Mixdown" button.
   - **Timeline Deck (Upper half)**: Multi-track ruler, synchronized scrubbing playhead, 4 track waveform lanes with peak envelopes, track color badges, and zoom controls.
   - **Console Deck (Lower half)**: 5 parallel studio strips:
     - Track 1 (Drums - Blue accent)
     - Track 2 (Bass - Emerald accent)
     - Track 3 (Synths - Amber accent)
     - Track 4 (Vocals - Rose accent)
     - Master Bus (Studio Violet accent)
2. **Mobile View (iOS Safari & Chrome Mobile on iPhone / Android)**:
   - **Sticky Studio Header**: Compact timecode, Play/Pause, Loop, and Export button.
   - **Overview Timeline**: Synchronized 4-lane mini-waveform with draggable playhead.
   - **Touch Console Deck**:
     - Channel Strip Selector: Segmented tabs for `Track 1`, `Track 2`, `Track 3`, `Track 4`, and `Master Bus`.
     - Active Channel View: Large, high-resolution vertical fader ($\ge 56\text{px}$ touch target width, smooth haptic visual feedback), rotary knobs with touch drag sensitivity, large Mute and Solo buttons, and fast dual peak/RMS meters.
     - Landscape Mode: Automatically switches to a wide 5-strip console view when the phone is rotated horizontally!

#### B. Visual Identity & Anti-Slop Discipline
- **Theme**: Dark obsidian brushed studio chassis (`#0B0E14` base, `#141A26` strip panels, `#1E273A` module borders).
- **Meters**: Calibrated LED ladders (-60 dB to 0 dB, clip indicator at > -0.1 dB). Green (-60 to -12 dB), Amber (-12 to -3 dB), Crimson clip.
- **Typography**: `Plus Jakarta Sans` for labels; `JetBrains Mono` with `tabular-nums` for timecode, frequencies, and decibels to prevent layout jitter.
- **Zero-Pill Discipline**: Metadata displayed as unboxed text with subtle typographic dividers (`·`); controls styled as physical studio toggles with illuminated active states.

---

### 4. Audio Engine & DSP Signal Flow

#### Track Signal Chain (Tracks 1 to 4):
1. **AudioSource**: Lightweight downsampled stereo preview buffer.
2. **3-Band Parametric EQ**:
   - Low-Shelf: 100 Hz ($\pm 15$ dB)
   - Mid-Peaking: 1000 Hz ($\pm 15$ dB, Q = 1.0)
   - High-Shelf: 8000 Hz ($\pm 15$ dB)
3. **Dynamics Compressor**:
   - Threshold (-40 dB to 0 dB), Ratio (1:1 to 20:1), Attack (0.005s to 0.1s), Release (0.05s to 0.5s), with real-time gain reduction estimation.
4. **Stereo Panner**:
   - `StereoPannerNode` with constant-power panning law (-100% Left to +100% Right).
5. **Aux Send & Track Fader**:
   - Dry path -> Track Fader Gain -> Master Sum.
   - Aux path -> Reverb Send Gain -> Master Reverb Bus.
6. **Solo / Mute Bus Logic**:
   - Mute immediately zeroes the track gain.
   - Soloing any track mutes all un-soloed tracks while keeping soloed tracks audible.

#### Master Signal Chain:
1. **Summing Bus**: Sum of all active track dry paths.
2. **Spatial Reverb Return**: Convolution/algorithmic room response with variable decay time.
3. **Master 3-Band Bus EQ**: Low, Mid, and High tone shaping.
4. **Master Limiter**: Fast lookahead brickwall compressor (Threshold -0.3 dB, 20:1 ratio, 0.001s attack) ensuring zero digital clipping on export.
5. **Master Fader & Analyser**: Stereo peak & RMS metering connected to canvas visualizer.

---

### 5. Mixdown WAV Exporter

- **Export Dialog**:
  - Bit Depth selector: 16-bit PCM (CD standard), 24-bit PCM (Studio master), 32-bit IEEE Float.
  - Sample Rate: 44.1 kHz or 48.0 kHz.
  - Range: Full Project or Looped Selection.
- **Progressive Chunked Render**:
  - Mixes audio in discrete 5-second blocks using Web Audio / Offline processing.
  - Encodes the standard canonical RIFF `WAVE` format header with `fmt ` and `data` chunks.
  - Generates a local `Blob` and triggers direct download:
    - Desktop Chrome / Safari: Direct file download prompt (`mixdown_YYYY-MM-DD.wav`).
    - iOS Safari: Direct download or built-in audio player modal with "Save to Files / Share" action.

---

### 6. Technical Architecture & Component Tree

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                WaveForgeApp                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│  ├── AudioEngineProvider (Context & Web Audio Graph Manager)                │
│  │    ├── AudioUnlockModal (iOS Safari touch activation overlay)            │
│  │    ├── HeaderTransport (Timecode, Play, Pause, RTZ, Loop, BPM, Export)   │
│  │    ├── WaveformTimelineDeck                                              │
│  │    │    ├── TimelineRuler (Bars / Beats / Time markers)                  │
│  │    │    ├── PlayheadCursor (Synchronous scrubber)                        │
│  │    │    └── 4x TrackWaveformLane (Canvas peaks, zoom, file drop slot)    │
│  │    ├── MixingConsoleDeck                                                 │
│  │    │    ├── MobileChannelSelectorTabs (iOS mobile breakpoint only)       │
│  │    │    ├── 4x TrackChannelStrip                                         │
│  │    │    │    ├── TrackHeader & ColorBadge                                │
│  │    │    │    ├── 3BandEQModule (Knobs + Live EQ curve visualizer)        │
│  │    │    │    ├── CompressorModule (Threshold, Ratio, Gain Reduction)     │
│  │    │    │    ├── ReverbSendKnob & PanKnob                                │
│  │    │    │    ├── Solo & MuteButtons                                      │
│  │    │    │    ├── LongThrowVerticalFader (Touch-optimized slider)         │
│  │    │    │    └── DualPeakMeter (Fast LED peak-hold ladder)               │
│  │    │    └── MasterChannelStrip                                           │
│  │    │         ├── MasterReverbDecay                                       │
│  │    │         ├── MasterEQ & LimiterThreshold                             │
│  │    │         ├── MasterStereoFader                                       │
│  │    │         └── MasterStereoVUMeter (L/R peak-hold in dBFS)             │
│  │    └── MixdownExportModal (Format, Progress Bar, Download Trigger)       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 7. Verification & Testing Strategy

1. **Unit Testing (`node:test`)**:
   - `src/audio/math.test.ts`: Test dB to linear gain and linear to dB conversions, panning formulas, and clipping boundary tests.
   - `src/audio/wavParser.test.ts`: Test RIFF header parsing, sample rate, bit depth, and duration calculations from simulated WAV headers.
   - `src/audio/wavEncoder.test.ts`: Verify generated RIFF WAV headers, byte size alignments, 16-bit and 24-bit PCM word generation.
2. **Browser Verification (`computer-use`)**:
   - **Desktop Test (1440x900)**:
     - Verify desktop console shows all 4 tracks + master strip simultaneously.
     - Verify audio engine unlock works upon initial interaction.
     - Verify demo stems play smoothly with synchronized playhead movement across all 4 waveforms.
     - Verify adjusting track faders, panning, EQ, and solo/mute visibly updates audio output meters.
     - Verify WAV mixdown export generates a valid WAV file download.
   - **Mobile Test (390x844 iPhone Viewport)**:
     - Verify responsive mobile layout: top transport, compact waveform overview, and swipeable/tabbed touch channel strip.
     - Verify touch targets are $\ge 44\text{px}$ and faders/knobs respond cleanly without accidental screen scrolling.
