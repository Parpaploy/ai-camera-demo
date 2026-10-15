import { timingSafeEqual, createHash } from 'node:crypto';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = message => { throw new ApiError(400, message); };
const idPattern = /^[A-Za-z0-9_.:-]{1,64}$/;
const enums = {
  source: ['camera', 'image'], attireMode: ['student', 'medical'],
  attire: ['target', 'other', 'uncertain', 'unclassified'],
  gender: ['male', 'female', 'unisex', 'uncertain'],
  ageGroup: ['teen', 'adult', 'elderly', 'uncertain'],
};
export function authorized(header, key) {
  if (!key) return false;
  const hash = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(header ?? ''), hash(`Bearer ${key}`));
}
export function validateBatch(body) {
  if (!body || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > 100) bad('ส่งได้ครั้งละ 1–100 เหตุการณ์');
  return body.events.map(event => {
    if (!event || typeof event !== 'object') bad('รูปแบบเหตุการณ์ไม่ถูกต้อง');
    for (const field of ['sessionId', 'cameraId']) {
      if (typeof event[field] !== 'string' || !idPattern.test(event[field])) bad(`${field} ไม่ถูกต้อง`);
    }
    for (const [field, allowed] of Object.entries(enums)) if (!allowed.includes(event[field])) bad(`${field} ไม่ถูกต้อง`);
    for (const field of ['trackId', 'trackEpoch', 'firstSeen', 'lastSeen', 'revision']) {
      if (!Number.isSafeInteger(event[field]) || event[field] < 0) bad(`${field} ไม่ถูกต้อง`);
    }
    if (event.trackEpoch > 4294967295 || event.trackId < 1 || event.revision < 1) bad('หมายเลข track/revision ไม่ถูกต้อง');
    const expectedId = `${event.sessionId}:${event.trackEpoch}:${event.trackId}`;
    if (event.eventId !== expectedId) bad('eventId ไม่ตรงกับ session/track');
    if (event.firstSeen < 946684800000 || event.lastSeen < event.firstSeen || event.lastSeen > Date.now() + 300000) bad('เวลาของเหตุการณ์ไม่ถูกต้อง');
    if (typeof event.confidence !== 'number' || !Number.isFinite(event.confidence) || event.confidence < 0 || event.confidence > 1) bad('confidence ต้องอยู่ระหว่าง 0–1');
    let thumbnail;
    if (event.thumbnail !== undefined) {
      if (typeof event.thumbnail !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(event.thumbnail)) bad('ภาพ crop ต้องเป็น JPEG base64');
      const encoded = event.thumbnail.slice('data:image/jpeg;base64,'.length);
      const image = Buffer.from(encoded, 'base64');
      if (image.length < 4 || image.length > 96 * 1024 || image.toString('base64') !== encoded || image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) bad('ภาพ crop ต้องเป็น JPEG ไม่เกิน 96 KiB');
      thumbnail = image;
    }
    const result = Object.fromEntries(['eventId', 'sessionId', 'cameraId', 'trackId', 'trackEpoch', 'source', 'attireMode', 'firstSeen', 'lastSeen', 'confidence', 'attire', 'gender', 'ageGroup', 'revision'].map(k => [k, event[k]]));
    if (thumbnail) result.thumbnail = thumbnail;
    return result;
  });
}
export function thaiDay(ms = Date.now()) { return new Date(ms + 7 * 3600000).toISOString().slice(0, 10); }
function dayStart(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) bad('วันที่ต้องเป็น YYYY-MM-DD');
  const ms = Date.parse(`${day}T00:00:00+07:00`);
  if (!Number.isFinite(ms) || thaiDay(ms) !== day) bad('วันที่ไม่ถูกต้อง');
  return ms;
}
export function parseFilters(sp) {
  const from = sp.get('from') ?? thaiDay();
  const to = sp.get('to') ?? from;
  const start = dayStart(from), end = dayStart(to) + 86400000;
  if (end <= start || end - start > 366 * 86400000) bad('เลือกช่วงวันที่ 1–366 วัน');
  const where = ['first_seen_ms >= ?', 'first_seen_ms < ?'], params = [start, end];
  const camera = sp.get('camera');
  if (camera) {
    if (!idPattern.test(camera)) bad('รหัสกล้องไม่ถูกต้อง');
    where.push('camera_id = ?'); params.push(camera);
  }
  for (const [field, column] of [['attireMode', 'attire_mode'], ['source', 'source'], ['gender', 'gender'], ['ageGroup', 'age_group']]) {
    const value = sp.get(field);
    if (value) {
      if (!enums[field].includes(value)) bad(`${field} ไม่ถูกต้อง`);
      where.push(`${column} = ?`); params.push(value);
    }
  }
  const classes = sp.getAll('attire');
  if (classes.length) {
    if (classes.length > 4 || classes.some(c => !enums.attire.includes(c))) bad('ประเภทชุดไม่ถูกต้อง');
    where.push(`attire IN (${classes.map(() => '?').join(',')})`); params.push(...classes);
  }
  const min = sp.get('minConfidence');
  if (min !== null && min !== '') {
    const n = Number(min);
    if (!Number.isFinite(n) || n < 0 || n > 1) bad('confidence ต้องอยู่ระหว่าง 0–1');
    where.push('confidence >= ?'); params.push(n);
  }
  return { from, to, start, end, sql: where.join(' AND '), params };
}
const COLUMNS = `event_id AS eventId, session_id AS sessionId, camera_id AS cameraId,
  track_id AS trackId, track_epoch AS trackEpoch, source, attire_mode AS attireMode,
  first_seen_ms AS firstSeen, last_seen_ms AS lastSeen, confidence, attire, gender,
  age_group AS ageGroup, revision, received_at_ms AS receivedAt,
  EXISTS (SELECT 1 FROM ai_camera_person_event_images img WHERE img.event_id = ai_camera_person_events.event_id) AS imageAvailable`;
const TABLE = 'ai_camera_person_events';
export function createStore(pool) {
  const query = async (sql, params = []) => (await pool.query({ sql, timeout: 10000 }, params))[0];
  return {
    async health() { await query('SELECT 1'); },
    async write(events) {
      const rows = events.map(e => [e.eventId, e.sessionId, e.cameraId, e.trackId, e.trackEpoch, e.source, e.attireMode, e.firstSeen, e.lastSeen, e.confidence, e.attire, e.gender, e.ageGroup, e.revision, Date.now()]);
      // Immutable identity and first-seen time. Revision prevents delayed retries
      // overwriting newer classification; one batch is a single atomic statement.
      await query(`INSERT INTO ${TABLE} (event_id, session_id, camera_id, track_id, track_epoch,
        source, attire_mode, first_seen_ms, last_seen_ms, confidence, attire, gender, age_group,
        revision, received_at_ms) VALUES ? ON DUPLICATE KEY UPDATE
        last_seen_ms = IF(VALUES(revision) > revision, GREATEST(last_seen_ms, VALUES(last_seen_ms)), last_seen_ms),
        confidence = IF(VALUES(revision) > revision, GREATEST(confidence, VALUES(confidence)), confidence),
        attire = IF(VALUES(revision) > revision, VALUES(attire), attire),
        gender = IF(VALUES(revision) > revision, VALUES(gender), gender),
        age_group = IF(VALUES(revision) > revision, VALUES(age_group), age_group),
        received_at_ms = IF(VALUES(revision) > revision, VALUES(received_at_ms), received_at_ms),
        revision = GREATEST(revision, VALUES(revision))`, [rows]);
      const images = events.filter(e => e.thumbnail).map(e => [e.eventId, 'image/jpeg', e.thumbnail, Date.now()]);
      if (images.length) await query(`INSERT IGNORE INTO ai_camera_person_event_images (event_id, content_type, image_data, created_at_ms) VALUES ?`, [images]);
    },
    async image(eventId) {
      const rows = await query('SELECT content_type AS contentType, image_data AS imageData FROM ai_camera_person_event_images WHERE event_id = ? LIMIT 1', [eventId]);
      if (!rows.length) return null;
      return { contentType: rows[0].contentType, imageData: Buffer.from(rows[0].imageData) };
    },
    async dashboard(sp) {
      const f = parseFilters(sp);
      const hourly = f.from === f.to;
      const step = hourly ? 3600000 : 86400000;
      const bucket = `FLOOR((first_seen_ms - ${f.start}) / ${step})`;
      const [groups, cameras, demographics, latest, cameraGroups] = await Promise.all([
        query(`SELECT ${bucket} AS bucket, attire, COUNT(*) AS count FROM ${TABLE} WHERE ${f.sql} GROUP BY bucket, attire`, f.params),
        query(`SELECT camera_id AS cameraId, COUNT(*) AS count FROM ${TABLE} WHERE ${f.sql} GROUP BY camera_id ORDER BY camera_id`, f.params),
        query(`SELECT gender, age_group AS ageGroup, COUNT(*) AS count FROM ${TABLE} WHERE ${f.sql} GROUP BY gender, age_group`, f.params),
        query(`SELECT ${COLUMNS} FROM ${TABLE} WHERE ${f.sql} ORDER BY first_seen_ms DESC, event_id DESC LIMIT 5`, f.params),
        query(`SELECT ${bucket} AS bucket, camera_id AS cameraId, COUNT(*) AS count FROM ${TABLE} WHERE ${f.sql} GROUP BY bucket, camera_id`, f.params),
      ]);
      const bucketCount = hourly && f.to === thaiDay()
        ? new Date(Date.now() + 7 * 3600000).getUTCHours() + 1
        : Math.round((f.end - f.start) / step);
      const buckets = Array.from({ length: bucketCount }, (_, i) => ({
        key: hourly ? String(i).padStart(2, '0') + ':00' : thaiDay(f.start + i * step),
        date: thaiDay(f.start + i * step), target: 0, other: 0, uncertain: 0, unclassified: 0,
      }));
      for (const g of groups) if (buckets[g.bucket]) buckets[g.bucket][g.attire] = Number(g.count);
      const totals = { target: 0, other: 0, uncertain: 0, unclassified: 0 };
      for (const b of buckets) for (const k of Object.keys(totals)) totals[k] += b[k];
      const cameraSeries = cameras.map(c => ({ cameraId: c.cameraId, buckets: buckets.map((b, i) => ({ key: b.key, date: b.date, count: Number(cameraGroups.find(g => g.cameraId === c.cameraId && Number(g.bucket) === i)?.count ?? 0) })) }));
      return { cameraSeries, from: f.from, to: f.to, granularity: hourly ? 'hour' : 'day', buckets, totals, cameras, demographics, latest, asOf: Date.now(), timezone: 'Asia/Bangkok' };
    },
    async events(sp) {
      const f = parseFilters(sp);
      const sorts = { firstSeen: 'first_seen_ms', lastSeen: 'last_seen_ms', cameraId: 'camera_id', trackId: 'track_id', confidence: 'confidence', attire: 'attire', receivedAt: 'received_at_ms' };
      const sort = sp.get('sort') ?? 'firstSeen';
      const direction = sp.get('direction') ?? 'desc';
      if (!sorts[sort] || !['asc', 'desc'].includes(direction)) bad('การเรียงข้อมูลไม่ถูกต้อง');
      const page = Number(sp.get('page') ?? 0), size = Number(sp.get('size') ?? 25);
      if (!Number.isInteger(page) || page < 0 || page > 100000 || ![25, 50, 100].includes(size)) bad('หน้าหรือจำนวนแถวไม่ถูกต้อง');
      const [counts, rows] = await Promise.all([
        query(`SELECT COUNT(*) AS total FROM ${TABLE} WHERE ${f.sql}`, f.params),
        query(`SELECT ${COLUMNS} FROM ${TABLE} WHERE ${f.sql} ORDER BY ${sorts[sort]} ${direction}, event_id ${direction} LIMIT ? OFFSET ?`, [...f.params, size, page * size]),
      ]);
      return { rows, total: Number(counts[0].total), page, size };
    },
  };
}
