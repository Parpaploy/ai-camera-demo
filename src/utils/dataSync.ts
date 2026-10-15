import { acknowledge, pendingCount, putEvent, readBatch } from './eventOutbox';
import type { PersonEvent } from './personEvents';

const CAMERA_KEY = 'ai-camera-device-id';
const listeners = new Set<() => void>();
let state = { pending: 0, sending: false, error: '', lastSent: 0, authorized: false, storageError: '', dropped: 0 };
const publish = (update: Partial<typeof state>) => { state = { ...state, ...update }; listeners.forEach(fn => fn()); };
export const subscribeSync = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getSyncState = () => state;
export function getCameraId(): string {
  try {
    const id = localStorage.getItem(CAMERA_KEY);
    if (id && /^[A-Za-z0-9_.:-]{1,64}$/.test(id)) return id;
    const generated = `camera-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(CAMERA_KEY, generated); return generated;
  } catch { return 'camera-local'; }
}
export function setCameraId(id: string) {
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(id)) throw new Error('ใช้ตัวอักษรอังกฤษ ตัวเลข จุด ขีด หรือ _ ไม่เกิน 64 ตัว');
  localStorage.setItem(CAMERA_KEY, id);
}
export async function dataRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (init.signal?.aborted) abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(abort, 15000);
  try {
    const response = await fetch(`/api/data${path}`, { ...init, signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...init.headers }, cache: 'no-store' });
    let body;
    try { body = await response.json(); } catch { throw new Error('ติดต่อ Data API ไม่ได้ กรุณาเริ่มบริการ npm run data:dev'); }
    if (!response.ok) {
      if (response.status === 401 && path !== '/auth/login') publish({ authorized: false });
      throw new Error(body.error?.message ?? `Data API: HTTP ${response.status}`);
    }
    return body.data as T;
  } finally { clearTimeout(timeout); init.signal?.removeEventListener('abort', abort); }
}
export async function connectData() {
  const result = await dataRequest<{ authenticated: boolean }>('/auth/session');
  publish({ authorized: result.authenticated, error: '' });
}
export async function loginData(password: string) {
  const result = await dataRequest<{ authenticated: boolean }>('/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'admin', password }),
  });
  publish({ authorized: result.authenticated, error: '' });
  void flushEvents();
}
export async function disconnectData() {
  await dataRequest('/auth/logout', { method: 'POST' });
  publish({ authorized: false, error: '' });
}
// Bounded staging coalesces updates before IndexedDB writes, independently of inference.
const staged = new Map<string, PersonEvent>();
let draining = false;
export function queuePersonEvent(event: PersonEvent) {
  if (staged.size >= 1000 && !staged.has(event.eventId)) {
    publish({ dropped: state.dropped + 1, storageError: 'คิวในหน่วยความจำเต็ม บางเหตุการณ์ยังบันทึกไม่ได้ กรุณาตรวจพื้นที่จัดเก็บ' }); return;
  }
  const previous = staged.get(event.eventId);
  staged.set(event.eventId, previous && !event.thumbnail ? { ...event, thumbnail: previous.thumbnail } : event); void drain();
}
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (staged.size) {
      const event = staged.values().next().value!;
      await putEvent(event);
      if (staged.get(event.eventId)?.revision === event.revision) staged.delete(event.eventId);
    }
    publish({ pending: await pendingCount(), storageError: '' });
  } catch (error) {
    publish({ storageError: error instanceof Error ? error.message : 'เขียนคิวส่งข้อมูลไม่ได้' });
  } finally { draining = false; }
}
let flushing = false;
export async function flushEvents() {
  if (flushing || !state.authorized) return;
  flushing = true;
  publish({ sending: true });
  try {
    const batch = await readBatch(4);
    if (batch.length) {
      const result = await dataRequest<{ accepted: { eventId: string; revision: number }[] }>('/events', { method: 'POST', body: JSON.stringify({ events: batch }) });
      if (!Array.isArray(result.accepted) || result.accepted.length !== batch.length || batch.some(e => !result.accepted.some(a => a.eventId === e.eventId && a.revision === e.revision))) throw new Error('เซิร์ฟเวอร์ยังยืนยันข้อมูลไม่ครบ จะเก็บคิวไว้และลองใหม่');
      await acknowledge(result.accepted);
      publish({ lastSent: Date.now() });
    }
    publish({ pending: await pendingCount(), error: '' });
  } catch (error) { publish({ error: error instanceof Error ? error.message : 'ส่งข้อมูลไม่ได้ จะลองใหม่' }); }
  finally { flushing = false; publish({ sending: false }); }
}
export function startDataSync() {
  let disposed = false; let timer: number;
  const tick = async () => {
    await drain();
    if (!state.authorized && !state.error) {
      try { await connectData(); } catch (error) {
        publish({ error: error instanceof Error ? error.message : 'ติดต่อฐานข้อมูลไม่ได้' });
      }
    }
    await flushEvents();
    if (!disposed) timer = window.setTimeout(tick, 5000);
  };
  const online = () => { void flushEvents(); };
  window.addEventListener('online', online);
  void tick();
  return () => { disposed = true; clearTimeout(timer); window.removeEventListener('online', online); };
}
