import { readFile } from 'node:fs/promises';
import { createPool } from './index.mjs';
const pool = createPool();
try {
  const schema = await readFile(new URL('../db/001_person_events.sql', import.meta.url), 'utf8');
  for (const statement of schema.split(/;\s*(?:\n|$)/).map(value => value.trim()).filter(Boolean)) await pool.query(statement);
  console.log('ai-camera event tables are ready');
} finally { await pool.end(); }
