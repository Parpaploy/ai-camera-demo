const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, dependencies, globals = {}, source = fs.readFileSync(file, "utf8")) {
  const code = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: (name) => dependencies[name], ...globals });
  return exports;
}

test('YOLO releases every tensor on success, decoding failure, and inference failure', async () => {
  let inputs = [], outputs = [], failure = '', creates = 0;
  class Tensor {
    constructor() { inputs.push(this); }
    dispose() { this.disposed = true; }
  }
  const session = {
    inputNames: ['input'], outputNames: ['output'],
    async run() {
      if (failure === 'run') throw new Error('run failed');
      const output = { dims: failure === 'decode' ? null : [1, 5, 1],
        data: new Float32Array([1, 1, 1, 1, 0]), dispose() { this.disposed = true; } };
      outputs.push(output);
      return { output };
    },
  };
  const yolo = load('src/utils/yolo.ts', {
    'onnxruntime-web': { Tensor, env: { wasm: {} }, InferenceSession: {
      async create() { if (++creates === 1) throw new Error('load failed'); return session; },
    } },
    '../constants/demo.const': { MODEL_INPUT_SIZE: 2, DEFAULT_CONF_THRESHOLD: 0.5, DEFAULT_IOU_THRESHOLD: 0.5 },
  }, {
    navigator: { hardwareConcurrency: 4 },
    document: { createElement: () => ({ getContext: () => ({ fillRect() {}, drawImage() {},
      getImageData: () => ({ data: new Uint8Array(16) }) }) }) },
  });
  const source = { naturalWidth: 2, naturalHeight: 2 };
  await assert.rejects(yolo.detectObjects(source), /load failed/);
  for (let i = 0; i < 100; i++) await yolo.detectObjects(source);
  for (failure of ['decode', 'run']) await assert.rejects(yolo.detectObjects(source));
  assert.equal(creates, 2, 'failed model loads must be retryable');
  assert.ok(inputs.every(t => t.disposed));
  assert.ok(outputs.every(t => t.disposed));
});

test('tracker retires departed tracks during a long session', () => {
  const { IouTracker } = load('src/utils/tracker.ts', {});
  const tracker = new IouTracker({ maxMissedFrames: 2 });
  for (let i = 0; i < 10000; i++) {
    const [det] = tracker.update([{ classId: 0, box: [i * 10, 0, 1, 1] }]);
    assert.ok(tracker.hasTrack(det.trackId));
    assert.ok(tracker.activeTrackCount <= 3);
  }
  tracker.reset();
  assert.equal(tracker.activeTrackCount, 0);
});

function cameraHarness(detect, describe = async () => '[TARGET]') {
  let source = fs.readFileSync('src/App.tsx', 'utf8');
  source = source.slice(0, source.indexOf('  return (\n    <div className="min-h-screen')) + `
    return { cameraLoop, stopCamera, cameraLoopActiveRef, loopGenerationRef,
      videoRef, overlayCanvasRef, trackerRef, runningRef, geminiRunningRef };
  }`;
  source = source.replace('import.meta.env.VITE_GEMINI_API_KEY', '"test-key"');
  const yolo = { COCO_CLASSES: ['person'], detectObjects: detect };
  const constants = load('src/constants/demo.const.ts', { '../utils/yolo': yolo });
  const tracker = load('src/utils/tracker.ts', {});
  const timers = [];
  class Video { videoWidth = 16; videoHeight = 16; readyState = 2; pause() {} }
  const app = load('src/App.tsx', {
    react: {
      useRef: current => ({ current }), useCallback: fn => fn, useEffect() {},
      useState: value => [typeof value === 'function' ? value() : value, () => {}],
    },
    './utils/yolo': yolo, './utils/tracker': tracker, './constants/demo.const': constants,
    './components/Dashboard': {},
    './functions/demo.func': { drawBoxes() {}, cropDetectionToDataUrl: () => 'image',
      describePersonImage: describe, parseAttireType: () => 'target', parseGenderType: () => 'uncertain',
      parseAgeGroupType: () => 'uncertain', cleanGeminiText: t => t },
    './utils/detectionHistory': { loadDetectionHistory: () => [] },
  }, {
    sessionStorage: { getItem: () => null }, HTMLVideoElement: Video,
    window: { setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {} },
    performance: { now: () => 10000 }, console,
  }, source).default();
  app.videoRef.current = new Video();
  app.overlayCanvasRef.current = { width: 16, height: 16, getContext: () => ({ clearRect() {} }) };
  app.cameraLoopActiveRef.current = true;
  app.loopGenerationRef.current = 1;
  return { app, timers };
}

test('late inference from a stopped session cannot update or schedule into the next session', async () => {
  let resolve;
  const { app, timers } = cameraHarness(() => new Promise(r => { resolve = r; }));
  const old = app.cameraLoop(1);
  assert.equal(app.runningRef.current, true);
  app.stopCamera();
  app.cameraLoopActiveRef.current = true;
  app.loopGenerationRef.current = 3;
  resolve([{ classId: 0, box: [0, 0, 1, 1], score: 0.9 }]);
  await old;
  assert.equal(app.trackerRef.current.activeTrackCount, 0);
  assert.equal(timers.length, 0);
  assert.equal(app.runningRef.current, false);
});

test('a pending Gemini request does not block the next camera inference', async () => {
  let calls = 0, finishDescription;
  const { app, timers } = cameraHarness(async () => {
    calls++;
    return [{ classId: 0, box: [0, 0, 1, 1], score: 0.9 }];
  }, () => new Promise(r => { finishDescription = r; }));
  await app.cameraLoop(1);
  assert.equal(app.geminiRunningRef.current, true);
  assert.equal(timers.length, 1);
  await timers.shift()();
  assert.equal(calls, 2);
  app.stopCamera();
  finishDescription('[TARGET]');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.trackerRef.current.activeTrackCount, 0);
  assert.equal(app.geminiRunningRef.current, false);
});
