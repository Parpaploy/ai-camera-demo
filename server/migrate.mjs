import { readFile } from 'node:fs/promises';
import { createPool } from './index.mjs';
const pool = createPool();
try {
  await pool.query(await readFile(new URL('../db/001_person_events.sql', import.meta.url), 'utf8'));
  console.log('ai_camera_person_events is ready');
} finally { await pool.end(); }
