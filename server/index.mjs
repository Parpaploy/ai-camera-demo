import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { ApiError, authorized, validateBatch, createStore } from './data-core.mjs';

export function createApiServer({ store, accessKey, adminPassword = process.env.DASHBOARD_ADMIN_PASSWORD }) {
  if (!accessKey || accessKey.length < 24) throw new Error('DATA_API_KEY must contain at least 24 characters');
  if (!adminPassword || adminPassword.length < 16) throw new Error('DASHBOARD_ADMIN_PASSWORD must contain at least 16 characters');
  const sessions = new Map();
  const attempts = new Map();
  const sameSecret = (a, b) => {
    const left = createHash('sha256').update(a).digest();
    const right = createHash('sha256').update(b).digest();
    return timingSafeEqual(left, right);
  };
  const cookieName = 'ai_camera_admin';
  const getSession = req => {
    const pair = (req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`));
    const token = pair?.slice(cookieName.length + 1);
    const expiresAt = token ? sessions.get(token) : 0;
    if (!expiresAt || expiresAt <= Date.now()) { if (token) sessions.delete(token); return false; }
    return true;
  };
  return http.createServer({ requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 8192 }, async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/data/auth/session' && req.method === 'GET') {
        send(200, { data: { authenticated: getSession(req) } }); return;
      }
      if (url.pathname === '/api/data/auth/login' && req.method === 'POST') {
        const address = req.socket.remoteAddress ?? 'unknown';
        const attempt = attempts.get(address) ?? { count: 0, until: 0 };
        if (attempt.until > Date.now()) throw new ApiError(429, 'ลองเข้าสู่ระบบใหม่ภายหลัง');
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 4096) throw new ApiError(413, 'ข้อมูลเกินขนาด'); chunks.push(chunk); }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError(400, 'JSON ไม่ถูกต้อง'); }
        if (body?.username !== 'admin' || typeof body?.password !== 'string' || !sameSecret(body.password, adminPassword)) {
          attempt.count += 1;
          if (attempt.count >= 10) { attempt.count = 0; attempt.until = Date.now() + 5 * 60_000; }
          attempts.set(address, attempt);
          throw new ApiError(401, 'รหัสผ่านไม่ถูกต้อง');
        }
        attempts.delete(address);
        const token = randomBytes(32).toString('base64url');
        sessions.set(token, Date.now() + 8 * 60 * 60_000);
        const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/api/data; HttpOnly; SameSite=Strict; Max-Age=28800${secure}`);
        send(200, { data: { authenticated: true } }); return;
      }
      if (url.pathname === '/api/data/auth/logout' && req.method === 'POST') {
        const pair = (req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`));
        if (pair) sessions.delete(pair.slice(cookieName.length + 1));
        res.setHeader('Set-Cookie', `${cookieName}=; Path=/api/data; HttpOnly; SameSite=Strict; Max-Age=0`);
        send(200, { data: { authenticated: false } }); return;
      }
      if (!getSession(req) && !authorized(req.headers.authorization, accessKey)) {
        throw new ApiError(401, 'กรุณาเข้าสู่ระบบผู้ดูแล');
      }
      if (req.method === 'GET' && url.pathname === '/api/data/health') {
        await store.health(); send(200, { data: { status: 'ok' } }); return;
      }
      const imageMatch = req.method === 'GET' && url.pathname.match(/^\/api\/data\/events\/([^/]{1,480})\/image$/);
      if (imageMatch) {
        let eventId;
        try { eventId = decodeURIComponent(imageMatch[1]); } catch { throw new ApiError(404, 'ไม่พบภาพ crop ของเหตุการณ์นี้'); }
        if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(eventId)) throw new ApiError(404, 'ไม่พบภาพ crop ของเหตุการณ์นี้');
        const image = await store.image(eventId);
        if (!image) { send(404, { error: { message: 'ไม่พบภาพ crop ของเหตุการณ์นี้' } }); return; }
        res.writeHead(200, { 'Content-Type': image.contentType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': image.imageData.length });
        res.end(image.imageData); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/data/events') {
        if (!req.headers['content-type']?.startsWith('application/json')) throw new ApiError(415, 'ต้องส่ง JSON');
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1048576) throw new ApiError(413, 'ข้อมูลเกิน 1 MiB');
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new ApiError(400, 'JSON ไม่ถูกต้อง'); }
        const events = validateBatch(body);
        await store.write(events);
        send(200, { data: { accepted: events.map(e => ({ eventId: e.eventId, revision: e.revision })) } }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/data/dashboard') {
        send(200, { data: await store.dashboard(url.searchParams) }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/data/events') {
        send(200, { data: await store.events(url.searchParams) }); return;
      }
      throw new ApiError(404, 'ไม่พบ API');
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 503;
      // Do not return SQL text, credentials, or connection details to the browser.
      if (status === 503) console.error('Data API database error:', error.code ?? error.name);
      if (!res.headersSent) send(status, { error: { message: status === 503 ? 'ฐานข้อมูลยังไม่พร้อม ตรวจการตั้งค่าเซิร์ฟเวอร์แล้วลองใหม่' : error.message } });
    }
  });
}
export function createPool(env = process.env) {
  for (const key of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) if (!env[key]) throw new Error(`Missing ${key}`);
  return mysql.createPool({ host: env.DB_HOST, port: Number(env.DB_PORT ?? 4000), user: env.DB_USER,
    password: env.DB_PASSWORD, database: env.DB_NAME,
    ssl: env.DB_SSL === 'false' ? undefined : { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionLimit: 4, queueLimit: 20, waitForConnections: true, connectTimeout: 8000,
    enableKeepAlive: true, timezone: 'Z', supportBigNumbers: true,
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool();
  const server = createApiServer({ store: createStore(pool), accessKey: process.env.DATA_API_KEY });
  const host = process.env.DATA_API_HOST ?? '127.0.0.1', port = Number(process.env.DATA_API_PORT ?? 8787);
  server.listen(port, host, () => console.log(`ai-camera Data API: http://${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close(() => { void pool.end().then(() => process.exit(0)); });
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
