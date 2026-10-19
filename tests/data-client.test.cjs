const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { indexedDB } = require('fake-indexeddb');
function load(file) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {}; vm.runInNewContext(code, { exports, indexedDB, console }); return exports;
}
const { PersonEventRecorder } = load('src/utils/personEvents.ts');
const outbox = load('src/utils/eventOutbox.ts');
const person = { trackId: 1, classId: 0, score: .8, box: [0, 0, 1, 1] };
test('one person per session/epoch, batched updates, final classification', () => {
  const output = []; let now = Date.now();
  const recorder = new PersonEventRecorder(e => output.push(e), () => now);
  recorder.begin('session', 'camera-1', 'camera', 'student');
  for (let i = 0; i < 100; i++) { now += 10; recorder.observe([person], () => true); }
  assert.equal(output.length, 0, 'pending people must never be published');
  recorder.attachThumbnail(1, 'one-crop');
  assert.equal(output.length, 0, 'thumbnail must wait for classification');
  recorder.classify(1, { attire: 'target', gender: 'female', ageGroup: 'adult', text: 'do not store', thumbnail: 'do not store' });
  assert.equal(output.at(-1).attire, 'target');
  assert.equal(output.at(-1).thumbnail, 'one-crop');
  recorder.resetTracks(); recorder.observe([person], () => true);
  recorder.classify(1, { attire: 'other' });
  assert.notEqual(output[0].eventId, output.at(-1).eventId);
  recorder.finish();
  const length = output.length;
  recorder.classify(1, { attire: 'other' });
  assert.equal(output.length, length);
});
test('completed tracks publish one image, throttle metadata and flush the final lastSeen', () => {
  const output = []; let now = 1000;
  const recorder = new PersonEventRecorder(e => output.push(e), () => now);
  recorder.begin('throttle', 'camera-1', 'camera', 'student');
  recorder.observe([person], () => true);
  recorder.attachThumbnail(1, 'image');
  recorder.classify(1, { loading: true, attire: 'target' });
  recorder.classify(1, { error: 'AI failed', attire: 'target' });
  assert.equal(output.length, 0);
  recorder.classify(1, { attire: 'uncertain' });
  for (now = 2000; now <= 30000; now += 1000) recorder.observe([person], () => true);
  assert.equal(output.length, 1);
  recorder.observe([person], () => true); // now = 31000
  assert.equal(output.length, 2);
  assert.equal(output[1].thumbnail, undefined);
  now = 32000; recorder.observe([person], () => true);
  now = 36000; recorder.observe([], () => false);
  assert.equal(output.length, 3);
  assert.equal(output[2].lastSeen, 32000);
  assert.equal(new Set(output.map(e => e.eventId)).size, 1);
  recorder.finish(); assert.equal(output.length, 3);
});
test('departed pending tracks are discarded, but in-flight results retain observation times', () => {
  const output = []; let now = 1000;
  const recorder = new PersonEventRecorder(e => output.push(e), () => now);
  recorder.begin('late', 'camera-1', 'camera', 'student');
  recorder.observe([person], () => true);
  recorder.beginAnalysis(1);
  now = 2000; recorder.observe([person], () => true);
  now = 10000; recorder.observe([], () => false);
  recorder.attachThumbnail(1, 'image'); recorder.classify(1, { attire: 'target' });
  recorder.endAnalysis(1);
  assert.equal(output.length, 1);
  assert.equal(output[0].firstSeen, 1000); assert.equal(output[0].lastSeen, 2000);
  recorder.observe([{ ...person, trackId: 2 }], () => true);
  recorder.observe([], () => false); recorder.finish();
  assert.equal(output.length, 1);
});
test('IndexedDB outbox survives reopening and an old ack cannot delete new data', async () => {
  const e = { eventId: 'persist:0:1', revision: 1, attire: 'unclassified' };
  await outbox.putEvent(e);
  await outbox.putEvent({ ...e, revision: 2, attire: 'target' });
  await outbox.putEvent(e);
  await outbox.acknowledge([e]);
  const reopened = load('src/utils/eventOutbox.ts');
  assert.equal(await reopened.pendingCount(), 1);
  const [stored] = await reopened.readBatch();
  assert.equal(stored.revision, 2); assert.equal(stored.attire, 'target');
  await reopened.acknowledge([{ eventId: e.eventId, revision: 2 }]);
  assert.equal(await reopened.pendingCount(), 0);
});
