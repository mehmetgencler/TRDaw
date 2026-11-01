import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamingMixerController } from './streamingMixerController';
import type { ParsedWavHeader } from './wavParser';

/**
 * Creates a minimal mock AudioContext for unit tests
 */
function createMockAudioContext(sampleRate = 48000) {
  const listeners: Record<string, ((event: any) => void)[]> = {};
  const mockPort = {
    postedMessages: [] as any[],
    postMessage(msg: any) {
      this.postedMessages.push(msg);
    },
    onmessage: null as ((event: any) => void) | null,
  };

  const mockWorkletNode = {
    port: mockPort,
    connect: () => {},
    disconnect: () => {},
  };

  const mockCtx = {
    sampleRate,
    state: 'running' as AudioContextState,
    currentTime: 0,
    audioWorklet: {
      addModule: async () => {},
    },
    createChannelSplitter: () => ({ connect: () => {}, disconnect: () => {} }),
    createChannelMerger: () => ({ connect: () => {}, disconnect: () => {} }),
    createGain: () => ({ gain: { value: 1, setTargetAtTime: () => {} }, connect: () => {} }),
    createBiquadFilter: () => ({ gain: { value: 0, setTargetAtTime: () => {} }, frequency: { value: 1000, setTargetAtTime: () => {} }, Q: { value: 1 }, connect: () => {} }),
    createDynamicsCompressor: () => ({ threshold: { value: -10, setTargetAtTime: () => {} }, ratio: { value: 4, setTargetAtTime: () => {} }, attack: { value: 0.01, setTargetAtTime: () => {} }, release: { value: 0.1, setTargetAtTime: () => {} }, reduction: 0, connect: () => {} }),
    createStereoPanner: () => ({ pan: { value: 0, setTargetAtTime: () => {} }, connect: () => {} }),
    createAnalyser: () => ({ fftSize: 128, frequencyBinCount: 64, smoothingTimeConstant: 0.7, getByteTimeDomainData: () => {}, connect: () => {} }),
    createConvolver: () => ({ buffer: null, connect: () => {} }),
    createBufferSource: () => ({ buffer: null, loop: false, loopStart: 0, loopEnd: 0, start: () => {}, stop: () => {}, disconnect: () => {}, connect: () => {} }),
    createBuffer: () => ({ getChannelData: () => new Float32Array(100) }),
    destination: {},
  };

  return { mockCtx, mockPort, mockWorkletNode };
}

function createVirtualWavBlob(durationSec: number, sampleRate = 48000): { blob: Blob; header: ParsedWavHeader } {
  const channels = 2;
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const totalSampleFrames = Math.floor(durationSec * sampleRate);
  const dataByteLength = totalSampleFrames * blockAlign;
  const totalBytes = 44 + dataByteLength;

  const headerBuf = new ArrayBuffer(44);
  const v = new DataView(headerBuf);
  v.setUint8(0, 0x52); v.setUint8(1, 0x49); v.setUint8(2, 0x46); v.setUint8(3, 0x46); // RIFF
  v.setUint32(4, Math.min(0xFFFFFFFF, totalBytes - 8), true);
  v.setUint8(8, 0x57); v.setUint8(9, 0x41); v.setUint8(10, 0x56); v.setUint8(11, 0x45); // WAVE
  v.setUint8(12, 0x66); v.setUint8(13, 0x6D); v.setUint8(14, 0x74); v.setUint8(15, 0x20); // fmt
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bitsPerSample, true);
  v.setUint8(36, 0x64); v.setUint8(37, 0x61); v.setUint8(38, 0x74); v.setUint8(39, 0x61); // data
  v.setUint32(40, Math.min(0xFFFFFFFF, dataByteLength), true);

  const header: ParsedWavHeader = {
    sampleRate,
    channels,
    bitsPerSample,
    audioFormat: 1,
    byteRate: sampleRate * blockAlign,
    blockAlign,
    dataChunkOffset: 44,
    dataChunkSize: dataByteLength,
    totalSampleFrames,
    durationSec,
  };

  const blob = {
    size: totalBytes,
    type: 'audio/wav',
    slice(start = 0, end = totalBytes) {
      const sliceStart = Math.max(0, start);
      const sliceEnd = Math.min(totalBytes, end);
      const sliceLen = Math.max(0, sliceEnd - sliceStart);
      const buf = new Uint8Array(sliceLen);

      if (sliceStart < 44) {
        const headerSlice = new Uint8Array(headerBuf, sliceStart, Math.min(sliceLen, 44 - sliceStart));
        buf.set(headerSlice, 0);
      }

      return {
        size: sliceLen,
        type: 'audio/wav',
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      } as unknown as Blob;
    },
  } as unknown as Blob;

  return { blob, header };
}

test('Transport seek: Controller updates currentProjectFrame and notifies callbacks immediately', async () => {
  const { mockCtx, mockPort } = createMockAudioContext(48000);
  let reportedTime = -1;
  let reportedFrame = -1;

  const controller = new StreamingMixerController(
    mockCtx as unknown as AudioContext,
    ['track-1', 'track-2', 'track-3', 'track-4'],
    {
      onTimeUpdate: (timeSec, frame) => {
        reportedTime = timeSec;
        reportedFrame = frame;
      },
      onUnderrun: () => {},
    }
  );

  // Directly attach initialized mock worklet node
  (controller as any).workletNode = { port: mockPort, connect: () => {}, disconnect: () => {} };
  (controller as any).isInitialized = true;

  const { blob, header } = createVirtualWavBlob(3000, 48000);

  // Attach 4 streaming tracks
  for (let i = 0; i < 4; i++) {
    controller.setTrackSource(i, blob, header);
  }

  assert.equal(controller.hasActiveTracks(), true, 'Controller should confirm active streaming tracks');

  // Seek forward to 125.5 seconds during playback
  controller.seek(125.5);

  const expectedFrame = Math.floor(125.5 * 48000);
  assert.equal(controller.getCurrentProjectFrame(), expectedFrame, 'getCurrentProjectFrame must immediately match seek target');
  assert.equal(reportedTime, 125.5, 'onTimeUpdate must receive seek target time in seconds immediately');
  assert.equal(reportedFrame, expectedFrame, 'onTimeUpdate must receive seek target frame immediately');

  // Verify seek message sent to AudioWorklet
  const seekMsg = mockPort.postedMessages.find(m => m.type === 'seek');
  assert.ok(seekMsg, 'Worklet port must receive seek message');
  assert.equal(seekMsg.projectFrame, expectedFrame);

  // Verify tracks have correct sourceReadFrame matching seek target
  const tracks = (controller as any).tracks;
  for (let i = 0; i < 4; i++) {
    assert.equal(tracks[i].sourceReadFrame, expectedFrame, `Track ${i} sourceReadFrame must match target frame`);
  }

  // Verify setTrackSource with same source does NOT reset sourceReadFrame to 0
  controller.setTrackSource(0, blob, header);
  assert.equal(tracks[0].sourceReadFrame, expectedFrame, 'setTrackSource with identical source must preserve sourceReadFrame');

  controller.destroy();
});

test('Transport seek: Track past EOF sends track-eof and avoids stalling pre-roll', async () => {
  const { mockCtx, mockPort } = createMockAudioContext(48000);
  const controller = new StreamingMixerController(
    mockCtx as unknown as AudioContext,
    ['track-1', 'track-2', 'track-3', 'track-4'],
    {
      onTimeUpdate: () => {},
      onUnderrun: () => {},
    }
  );

  (controller as any).workletNode = { port: mockPort, connect: () => {}, disconnect: () => {} };
  (controller as any).isInitialized = true;

  // Track 1 is 10 seconds long
  const { blob: shortBlob, header: shortHeader } = createVirtualWavBlob(10, 48000);
  controller.setTrackSource(0, shortBlob, shortHeader);

  // Seek to 15 seconds (past EOF of track 0)
  controller.seek(15.0);

  // Trigger refill
  await controller.refillActiveTracks();

  // Worklet should receive track-eof for track 0
  const eofMsg = mockPort.postedMessages.find(m => m.type === 'track-eof');
  assert.ok(eofMsg, 'Worklet port must receive track-eof message for tracks past totalSampleFrames');
  assert.equal(eofMsg.trackIndex, 0);

  controller.destroy();
});
