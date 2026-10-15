import type { PersonEvent } from './personEvents';
const LIMIT = 10000;
let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('ai-camera-events-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('outbox', { keyPath: 'eventId' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
  });
}
async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, result: (value: T) => void, fail: (error: Error) => void) => void): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('outbox', mode); let result: T;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? new Error('บันทึกคิวไม่สำเร็จ'));
    tx.onabort = () => reject(tx.error ?? new Error('บันทึกคิวถูกยกเลิก'));
    run(tx.objectStore('outbox'), value => { result = value; }, error => { reject(error); tx.abort(); });
  });
}
export function putEvent(event: PersonEvent): Promise<void> {
  return transaction('readwrite', (store, done, fail) => {
    const request = store.get(event.eventId);
    request.onsuccess = () => {
      if (request.result) {
        if (request.result.revision < event.revision) store.put({ ...event, thumbnail: event.thumbnail ?? request.result.thumbnail });
        done(undefined);
      } else {
        const count = store.count();
        count.onsuccess = () => {
          if (count.result >= LIMIT) fail(new Error('คิวเต็ม 10,000 รายการ กรุณาเชื่อมต่อเพื่อส่งข้อมูลก่อน'));
          else { store.put(event); done(undefined); }
        };
      }
    };
  });
}
export function readBatch(limit = 100): Promise<PersonEvent[]> {
  return transaction('readonly', (store, done) => {
    const request = store.getAll(undefined, limit); request.onsuccess = () => done(request.result);
  });
}
export function pendingCount(): Promise<number> {
  return transaction('readonly', (store, done) => {
    const request = store.count(); request.onsuccess = () => done(request.result);
  });
}
export function acknowledge(events: { eventId: string; revision: number }[]): Promise<void> {
  return transaction('readwrite', (store, done) => {
    for (const e of events) {
      const request = store.get(e.eventId);
      request.onsuccess = () => {
        // An older response must not delete a newer queued classification.
        if (request.result?.revision === e.revision) store.delete(e.eventId);
      };
    }
    done(undefined);
  });
}
