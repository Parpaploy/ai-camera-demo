import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPool } from '../server/index.mjs';
import { createStore, validateBatch, thaiDay } from '../server/data-core.mjs';

test('MySQL: upsert is idempotent, rejects stale revisions, aggregates and paginates', { skip: process.env.RUN_SQL_TESTS !== '1' }, async () => {
  // This test intentionally uses only the isolated test container/database.
  const pool = createPool({ DB_HOST: '127.0.0.1', DB_PORT: '3308', DB_USER: 'root', DB_PASSWORD: 'local-test-only', DB_NAME: 'ai_camera_test', DB_SSL: 'false' });
  try {
    await pool.query(await readFile(new URL('../db/001_person_events.sql', import.meta.url), 'utf8'));
    const store = createStore(pool), now = Date.now(), session = `sqltest-${now}`;
    const e = { eventId: `${session}:0:1`, sessionId: session, cameraId: session, trackId: 1, trackEpoch: 0, source: 'camera', attireMode: 'student', firstSeen: now - 100, lastSeen: now, confidence: .8, attire: 'unclassified', gender: 'uncertain', ageGroup: 'uncertain', revision: 1 };
    await store.write(validateBatch({ events: [e] }));
    await store.write(validateBatch({ events: [{ ...e, revision: 3, attire: 'target', gender: 'female' }] }));
    await store.write(validateBatch({ events: [{ ...e, revision: 2, attire: 'other' }, e] }));
    const sp = new URLSearchParams({ from: thaiDay(now), to: thaiDay(now), camera: session });
    const page = await store.events(sp);
    assert.equal(page.total, 1); assert.equal(page.rows[0].attire, 'target'); assert.equal(page.rows[0].revision, 3);
    const summary = await store.dashboard(sp);
    assert.equal(summary.totals.target, 1); assert.equal(summary.totals.other, 0); assert.equal(summary.buckets.length, new Date(now + 7 * 3600000).getUTCHours() + 1);
    assert.equal(summary.cameras[0].cameraId, session);
    await store.write(Array.from({ length: 30 }, (_, i) => ({ ...e, eventId: `${session}:0:${i + 2}`, trackId: i + 2 })));
    const first = await store.events(sp); sp.set('page', '1');
    const second = await store.events(sp);
    assert.equal(first.total, 31); assert.equal(first.rows.length, 25); assert.equal(second.rows.length, 6);
    assert.equal(new Set([...first.rows, ...second.rows].map(r => r.eventId)).size, 31);
    sp.set('attire', 'target'); const filtered = await store.events(sp); assert.equal(filtered.total, 1);
  } finally { await pool.end(); }
});
