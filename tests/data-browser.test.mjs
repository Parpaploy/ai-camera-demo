import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createApiServer, createPool } from '../server/index.mjs';
import { createStore } from '../server/data-core.mjs';

test('dashboard browser: SQL auth, filters, pagination, offline queue, desktop/mobile', { skip: process.env.RUN_BROWSER_TESTS !== '1', timeout: 90000 }, async () => {
  await import('../scripts/seed-dashboard-test.mjs');
  const key = 'local-test-access-key-only-123456';
  const pool = createPool({ DB_HOST: '127.0.0.1', DB_PORT: '3308', DB_USER: 'root', DB_PASSWORD: 'local-test-only', DB_NAME: 'ai_camera_test', DB_SSL: 'false' });
  const adminPassword = 'local-test-admin-password';
  const server = createApiServer({ store: createStore(pool), accessKey: key, adminPassword });
  await new Promise(resolve => server.listen(8787, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const note = document.createElement('div');
        note.textContent = 'ข้อมูลจำลองสำหรับทดสอบ · ไม่ใช่ข้อมูลจากกล้องจริง';
        note.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:9999;background:#134e4a;color:#fff;padding:5px;text-align:center;font:12px sans-serif';
        document.body.append(note);
      });
    });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://127.0.0.1:5173');
    await page.getByLabel('รหัสผ่าน').fill(adminPassword);
    await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();
    await page.getByRole('heading', { name: 'จำนวนรายชั่วโมง', exact: true }).waitFor();
    await mkdir('/private/tmp/ai-camera-dashboard', { recursive: true });
    await page.screenshot({ path: '/private/tmp/ai-camera-dashboard/desktop.png', fullPage: true });
    await page.getByRole('button', { name: '7 วัน', exact: true }).click();
    await page.getByRole('heading', { name: 'แนวโน้มรายวัน', exact: true }).waitFor();
    await page.screenshot({ path: '/private/tmp/ai-camera-dashboard/trends.png', fullPage: true });
    await page.getByRole('navigation', { name: 'มุมมองข้อมูล' }).getByRole('button', { name: 'ข้อมูลรายบุคคล', exact: true }).click();
    await page.getByRole('button', { name: 'ถัดไป', exact: true }).click();
    await page.getByText(/^หน้า 2 \/ /).waitFor();
    await page.getByRole('button', { name: /YOLO/ }).click();
    await page.getByText(/^หน้า 1 \/ /).waitFor();
    await page.getByRole('navigation', { name: 'มุมมองข้อมูล' }).getByRole('button', { name: 'ภาพรวมวันนี้', exact: true }).click();
    await page.getByRole('heading', { name: 'จำนวนรายชั่วโมง', exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '/private/tmp/ai-camera-dashboard/mobile.png', fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile page must not overflow');
    await page.route('**/api/data/events', route => route.request().method() === 'POST' ? route.abort() : route.continue());
    await page.evaluate(async () => {
      const { queuePersonEvent } = await import('/src/utils/dataSync.ts');
      const now = Date.now();
      queuePersonEvent({ eventId: `browser-${now}:0:1`, sessionId: `browser-${now}`, cameraId: 'browser-retry-test', trackId: 1, trackEpoch: 0, source: 'camera', attireMode: 'student', firstSeen: now, lastSeen: now, confidence: .9, attire: 'target', gender: 'uncertain', ageGroup: 'adult', revision: 1 });
    });
    await page.waitForFunction(async () => (await import('/src/utils/dataSync.ts')).getSyncState().pending > 0);
    await page.evaluate(async () => { await (await import('/src/utils/dataSync.ts')).flushEvents(); });
    assert.ok(await page.evaluate(async () => (await import('/src/utils/dataSync.ts')).getSyncState().pending > 0));
    await page.unroute('**/api/data/events');
    await page.evaluate(async () => { await (await import('/src/utils/dataSync.ts')).flushEvents(); });
    await page.waitForFunction(async () => (await import('/src/utils/dataSync.ts')).getSyncState().pending === 0);
    const [rows] = await pool.query("SELECT COUNT(*) AS n FROM ai_camera_person_events WHERE camera_id = 'browser-retry-test'");
    assert.ok(rows[0].n >= 1);
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); await pool.end(); }
});
