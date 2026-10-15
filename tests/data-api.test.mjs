import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorized, validateBatch, parseFilters, thaiDay, createStore } from '../server/data-core.mjs';
import { createApiServer } from '../server/index.mjs';
const now = Date.now();
const event = { eventId: 'test:0:1', sessionId: 'test', cameraId: 'rdk-01', trackId: 1, trackEpoch: 0,
  source: 'camera', attireMode: 'student', firstSeen: now - 5000, lastSeen: now,
  confidence: .91, attire: 'target', gender: 'uncertain', ageGroup: 'adult', revision: 1 };

test('validate events and exclude images/unknown fields', () => {
  const [result] = validateBatch({ events: [{ ...event, thumbnail: 'private-image' }] });
  assert.equal(result.thumbnail, undefined);
  for (const override of [{ confidence: NaN }, { revision: -1 }, { eventId: 'wrong' }, { cameraId: "' OR 1=1" }, { lastSeen: now - 9000 }, { attire: 'phone' }]) {
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
  assert.equal((await fetch(url + '/events', { method: 'POST', headers, body: '{}' })).status, 400);
  store.write = async () => { throw Object.assign(new Error('private SQL detail'), { code: 'TEST_OFFLINE' }); };
  const failed = await fetch(url + '/events', { method: 'POST', headers, body: JSON.stringify({ events: [event] }) });
  assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes('private SQL detail'));
});
test('sort identifiers are allowlisted before SQL execution', async () => {
  const store = createStore({ query() { throw new Error('query must not run'); } });
  await assert.rejects(store.events(new URLSearchParams('sort=first_seen_ms;DROP TABLE x')), /เรียงข้อมูล/);
});
