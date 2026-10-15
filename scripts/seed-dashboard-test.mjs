// Development-only fixture; hard-coded isolated database, never production.
import { createPool } from '../server/index.mjs';
import { createStore } from '../server/data-core.mjs';
const pool = createPool({ DB_HOST: '127.0.0.1', DB_PORT: '3308', DB_USER: 'root', DB_PASSWORD: 'local-test-only', DB_NAME: 'ai_camera_test', DB_SSL: 'false' });
const store = createStore(pool), now = Date.now();
try {
  for (let day = 0; day < 7; day++) {
    const events = Array.from({ length: 60 }, (_, i) => ({
      eventId: `visual-fixture-${day}:0:${i + 1}`, sessionId: `visual-fixture-${day}`, cameraId: ['rdk-lobby-01', 'rdk-lab-02', 'rdk-entry-03'][i % 3], trackId: i + 1, trackEpoch: 0,
      source: i % 9 ? 'camera' : 'image', attireMode: i % 3 ? 'student' : 'medical',
      firstSeen: now - day * 86400000 - i * 240000, lastSeen: now - day * 86400000 - i * 240000 + 1000,
      confidence: .6 + (i % 4) / 10, attire: ['target', 'target', 'other', 'uncertain', 'unclassified'][i % 5],
      gender: ['male', 'female', 'uncertain'][i % 3], ageGroup: ['adult', 'teen', 'elderly', 'uncertain'][i % 4], revision: 1,
    }));
    await store.write(events);
  }
} finally { await pool.end(); }
