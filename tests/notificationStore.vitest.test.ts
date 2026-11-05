import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  InboundNotificationStore,
  DEFAULT_NOTIFICATION_STORE_TTL_MS,
  DEFAULT_MAX_NOTIFICATION_STORE_ITEMS,
} from '../src/gateway/notificationStore.js';
import type { PushNotificationPayload } from '../src/gateway/webhook.js';

describe('InboundNotificationStore', () => {
  let tempDir: string;
  let storagePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-store-test-'));
    storagePath = path.join(tempDir, 'data', 'inbound_notifications.json');
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  });

  const samplePayload: PushNotificationPayload = {
    packageName: 'com.grabtaxi.passenger',
    title: 'Grab',
    text: 'Pembayaran Rp 65.800 berhasil via Jago',
    timestamp: Date.now(),
  };

  it('initializes cleanly with non-existent storage file', () => {
    const store = new InboundNotificationStore(storagePath);
    expect(store.size()).toBe(0);
    expect(store.getAllNotifications()).toEqual([]);
  });

  it('records notifications, generates ids, and persists atomically to storage', () => {
    const store = new InboundNotificationStore(storagePath);
    const recorded = store.recordNotification(samplePayload);

    expect(recorded.id).toBeDefined();
    expect(recorded.receivedAt).toBeGreaterThan(0);
    expect(recorded.payload).toEqual(samplePayload);
    expect(store.size()).toBe(1);

    // Verify written to storage file
    expect(fs.existsSync(storagePath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
    expect(content.version).toBe(1);
    expect(content.notifications).toHaveLength(1);
    expect(content.notifications[0].payload.packageName).toBe('com.grabtaxi.passenger');
  });

  it('reloads saved notifications on a new instance', () => {
    const store1 = new InboundNotificationStore(storagePath);
    store1.recordNotification(samplePayload);

    const store2 = new InboundNotificationStore(storagePath);
    expect(store2.size()).toBe(1);
    const loaded = store2.getAllNotifications();
    expect(loaded[0].payload.title).toBe('Grab');
  });

  it('filters notifications correctly via getNotificationsSince', () => {
    const store = new InboundNotificationStore(storagePath);
    const now = Date.now();

    store.recordNotification({
      ...samplePayload,
      text: 'Notification 1 (old)',
      timestamp: now - 60000,
    });

    store.recordNotification({
      ...samplePayload,
      text: 'Notification 2 (recent)',
      timestamp: now - 10000,
    });

    const recent = store.getNotificationsSince(now - 30000);
    expect(recent).toHaveLength(1);
    expect(recent[0].payload.text).toBe('Notification 2 (recent)');

    const all = store.getNotificationsSince(now - 120000);
    expect(all).toHaveLength(2);
  });

  it('prunes entries older than max TTL', () => {
    const shortTtlMs = 1000;
    const store = new InboundNotificationStore(storagePath, { maxTtlMilliseconds: shortTtlMs });

    // Manually inject expired entry
    store.recordNotification({
      ...samplePayload,
      timestamp: Date.now() - 5000,
    });

    // Recording another recent one triggers pruning
    store.recordNotification({
      ...samplePayload,
      text: 'Fresh notif',
      timestamp: Date.now(),
    });

    expect(store.size()).toBe(1);
    expect(store.getAllNotifications()[0].payload.text).toBe('Fresh notif');
  });

  it('caps entries when exceeding maxEntries limit', () => {
    const store = new InboundNotificationStore(storagePath, { maxEntries: 3 });

    store.recordNotification({ ...samplePayload, text: 'Notif 1' });
    store.recordNotification({ ...samplePayload, text: 'Notif 2' });
    store.recordNotification({ ...samplePayload, text: 'Notif 3' });
    expect(store.size()).toBe(3);

    store.recordNotification({ ...samplePayload, text: 'Notif 4' });
    expect(store.size()).toBe(3);

    const notifications = store.getAllNotifications();
    expect(notifications.map(n => n.payload.text)).toEqual(['Notif 2', 'Notif 3', 'Notif 4']);
  });

  it('clears all notifications and wipes persistent file', () => {
    const store = new InboundNotificationStore(storagePath);
    store.recordNotification(samplePayload);
    expect(store.size()).toBe(1);

    store.clear();
    expect(store.size()).toBe(0);

    const reloaded = new InboundNotificationStore(storagePath);
    expect(reloaded.size()).toBe(0);
  });
});
