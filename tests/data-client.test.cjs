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
  assert.equal(output.length, 1);
  recorder.classify(1, { attire: 'target', gender: 'female', ageGroup: 'adult', text: 'do not store', thumbnail: 'do not store' });
  assert.equal(output.at(-1).attire, 'target');
  assert.equal(output.at(-1).thumbnail, undefined);
  recorder.resetTracks(); recorder.observe([person], () => true);
  assert.notEqual(output[0].eventId, output.at(-1).eventId);
  recorder.finish();
  const length = output.length;
  recorder.classify(1, { attire: 'other' });
  assert.equal(output.length, length);
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
