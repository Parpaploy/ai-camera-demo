// Uses configured database; creates and removes only its unique synthetic event.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApiServer, createPool } from '../server/index.mjs';
import { createStore, thaiDay } from '../server/data-core.mjs';

const pool = createPool();
const server = createApiServer({ store: createStore(pool), accessKey: process.env.DATA_API_KEY });
const session = `verify-${randomUUID()}`;
const now = Date.now();
const event = { eventId: `${session}:0:1`, sessionId: session, cameraId: session,
  trackId: 1, trackEpoch: 0, source: 'camera', attireMode: 'student',
  firstSeen: now, lastSeen: now, confidence: .9, attire: 'target',
  gender: 'uncertain', ageGroup: 'uncertain', revision: 1 };
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}/api/data`;
  const headers = { Authorization: `Bearer ${process.env.DATA_API_KEY}`, 'Content-Type': 'application/json' };
  async function request(path, body) {
    const r = await fetch(base + path, { headers, signal: AbortSignal.timeout(20000),
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    assert.equal(r.status, 200, `API ${path} returned ${r.status}`);
    return (await r.json()).data;
  }
  await request('/health');
  for (let i = 0; i < 2; i++) {
    const ack = await request('/events', { events: [event] });
    assert.equal(ack.accepted[0].eventId, event.eventId);
  }
  const query = new URLSearchParams({ from: thaiDay(now), to: thaiDay(now), camera: session });
  const rows = await request(`/events?${query}`);
  assert.equal(rows.total, 1);
  assert.equal(rows.rows[0].eventId, event.eventId);
  const dashboard = await request(`/dashboard?${query}`);
  assert.equal(dashboard.totals.target, 1);
  assert.equal(dashboard.cameraSeries[0].cameraId, session);
  console.log('PASS: TLS database health, API write/read, duplicate protection, dashboard aggregation.');
} catch (error) {
  console.error('Verification failed:', error.code ?? error.name);
  process.exitCode = 1;
} finally {
  try {
    await pool.query('DELETE FROM ai_camera_person_events WHERE event_id = ? AND session_id = ?', [event.eventId, session]);
    console.log('Removed only this run\'s synthetic event.');
  } catch (error) {
    console.error('Synthetic event cleanup failed:', error.code ?? error.name);
    process.exitCode = 1;
  }
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await pool.end();
}
