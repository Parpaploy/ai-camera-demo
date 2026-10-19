import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorized, validateBatch, parseFilters, thaiDay, createStore } from '../server/data-core.mjs';
import { createApiServer } from '../server/index.mjs';
const now = Date.now();
const event = { eventId: 'test:0:1', sessionId: 'test', cameraId: 'rdk-01', trackId: 1, trackEpoch: 0,
  source: 'camera', attireMode: 'student', firstSeen: now - 5000, lastSeen: now,
  confidence: .91, attire: 'target', gender: 'uncertain', ageGroup: 'adult', revision: 1 };

test('validate events and retain bounded JPEG crops only', () => {
  const [result] = validateBatch({ events: [{ ...event, thumbnail: 'data:image/jpeg;base64,/9j/2Q==' }] });
  assert.deepEqual(result.thumbnail, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  for (const override of [{ confidence: NaN }, { revision: -1 }, { eventId: 'wrong' }, { cameraId: "' OR 1=1" }, { lastSeen: now - 9000 }, { attire: 'phone' }, { thumbnail: 'private-image' }]) {
    assert.throws(() => validateBatch({ events: [{ ...event, ...override }] }));
  }
  assert.throws(() => validateBatch({ events: Array(101).fill(event) }));
});
test('Thai calendar filters handle midnight and validate input', () => {
  const f = parseFilters(new URLSearchParams('from=2026-10-15&to=2026-10-15&camera=rdk-01&attire=target'));
  assert.equal(new Date(f.start).toISOString(), '2026-10-14T17:00:00.000Z');
  assert.equal(new Date(f.end).toISOString(), '2026-10-15T17:00:00.000Z');
  assert.equal(thaiDay(f.start - 1), '2026-10-14');
  assert.ok(f.sql.includes('camera_id = ?'));
  for (const query of ['from=2026-02-30', 'from=2020-01-01&to=2026-01-01', 'from=2026-10-20&to=2026-10-10', 'attire=bad', 'minConfidence=NaN']) assert.throws(() => parseFilters(new URLSearchParams(query)));
});
test('API requires key, validates batch, and acknowledges only after write', async t => {
  const key = 'test-key-at-least-24-characters';
  let writes = 0;
  const store = { async health() {}, async write(events) { assert.equal(events[0].eventId, event.eventId); writes++; }, async dashboard() { return { totals: {} }; }, async events() { return { rows: [] }; } };
  const server = createApiServer({ store, accessKey: key, adminPassword: 'test-admin-password-only' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/data`;
  assert.equal((await fetch(url + '/health')).status, 401);
  assert.equal(authorized('Bearer wrong', key), false);
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(url + '/health', { headers })).status, 200);
  const result = await fetch(url + '/events', { method: 'POST', headers, body: JSON.stringify({ events: [event] }) });
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).data.accepted, [{ eventId: event.eventId, revision: 1 }]);
  assert.equal(writes, 1);
  const pending = await fetch(url + '/events', { method: 'POST', headers,
    body: JSON.stringify({ events: [{ ...event, attire: 'unclassified' }] }) });
  assert.equal(pending.status, 200);
  assert.equal((await pending.json()).data.accepted.length, 1, 'discarded legacy queue records must be acknowledged');
  assert.equal(writes, 1, 'pending records must not reach storage');
  assert.equal((await fetch(url + '/events', { method: 'POST', headers, body: '{}' })).status, 400);
  store.write = async () => { throw Object.assign(new Error('private SQL detail'), { code: 'TEST_OFFLINE' }); };
  const failed = await fetch(url + '/events', { method: 'POST', headers, body: JSON.stringify({ events: [event] }) });
  assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes('private SQL detail'));
});
test('store excludes pending writes and hides legacy pending data in all dashboard queries', async () => {
  const calls = [];
  const store = createStore({ async query({ sql }, params) {
    calls.push({ sql, params });
    return [sql.includes('SELECT COUNT(*) AS total') ? [{ total: 0 }] : []];
  } });
  await store.write([{ ...event, attire: 'unclassified', thumbnail: Buffer.from('pending') }]);
  assert.equal(calls.length, 0);
  await store.write([event, { ...event, attire: 'unclassified' }]);
  assert.equal(calls[0].params[0].length, 1);
  calls.length = 0;
  await store.events(new URLSearchParams());
  await store.dashboard(new URLSearchParams());
  assert.equal(calls.length, 7);
  assert.ok(calls.every(({ sql }) => sql.includes("attire <> 'unclassified'")));
});
test('sort identifiers are allowlisted before SQL execution', async () => {
  const store = createStore({ query() { throw new Error('query must not run'); } });
  await assert.rejects(store.events(new URLSearchParams('sort=first_seen_ms;DROP TABLE x')), /เรียงข้อมูล/);
});
