import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PushNotificationPayload } from './webhook.js';
import { applicationLogger } from '../lib/logger.js';

export interface StoredPushNotification {
  readonly id: string;
  readonly receivedAt: number; // Unix epoch ms
  readonly payload: PushNotificationPayload;
}

export interface InboundNotificationSnapshot {
  readonly version: number;
  readonly notifications: StoredPushNotification[];
}

export const DEFAULT_NOTIFICATION_STORE_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours (3 days)
export const DEFAULT_MAX_NOTIFICATION_STORE_ITEMS = 500;

/**
 * Persistently stores incoming mobile push notifications in a rolling JSON buffer.
 * Enables retroactive reprocessing and inbound rescan without relying on fragile
 * log scraping or unpersisted container stdout.
 */
export class InboundNotificationStore {
  private readonly notificationList: StoredPushNotification[] = [];
  private readonly maxTtlMilliseconds: number;
  private readonly maxEntries: number;

  constructor(
    private readonly storageFilePath?: string,
    options?: { maxTtlMilliseconds?: number; maxEntries?: number }
  ) {
    this.maxTtlMilliseconds = options?.maxTtlMilliseconds ?? DEFAULT_NOTIFICATION_STORE_TTL_MS;
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_NOTIFICATION_STORE_ITEMS;
    this.loadFromStorage();
  }

  /**
   * Appends an incoming notification to the persistent history store.
   */
  public recordNotification(payload: PushNotificationPayload): StoredPushNotification {
    const item: StoredPushNotification = {
      id: randomUUID(),
      receivedAt: payload.timestamp ?? Date.now(),
      payload: { ...payload },
    };

    this.notificationList.push(item);
    this.pruneOldNotifications();
    this.saveToStorage();
    return item;
  }

  /**
   * Retrieves all push notifications received on or after the specified timestamp.
   */
  public getNotificationsSince(sinceTimestampMs: number): StoredPushNotification[] {
    this.pruneOldNotifications();
    return this.notificationList.filter(item => {
      const eventTime = item.payload.timestamp ?? item.receivedAt;
      return eventTime >= sinceTimestampMs;
    });
  }

  /**
   * Returns a snapshot of all currently active notifications in the store.
   */
  public getAllNotifications(): StoredPushNotification[] {
    this.pruneOldNotifications();
    return [...this.notificationList];
  }

  public size(): number {
    return this.notificationList.length;
  }

  public clear(): void {
    this.notificationList.length = 0;
    this.saveToStorage();
  }

  private pruneOldNotifications(): void {
    const now = Date.now();
    const cutoff = now - this.maxTtlMilliseconds;

    // Remove expired entries
    let writeIdx = 0;
    for (let i = 0; i < this.notificationList.length; i++) {
      const item = this.notificationList[i];
      const eventTime = item.payload.timestamp ?? item.receivedAt;
      if (eventTime >= cutoff) {
        this.notificationList[writeIdx++] = item;
      }
    }
    this.notificationList.length = writeIdx;

    // Cap total entries
    if (this.notificationList.length > this.maxEntries) {
      const excess = this.notificationList.length - this.maxEntries;
      this.notificationList.splice(0, excess);
    }
  }

  private loadFromStorage(): void {
    if (!this.storageFilePath) return;

    try {
      if (!fs.existsSync(this.storageFilePath)) {
        return;
      }

      const raw = fs.readFileSync(this.storageFilePath, 'utf-8');
      if (!raw.trim()) return;

      const data = JSON.parse(raw) as Partial<InboundNotificationSnapshot>;
      if (Array.isArray(data.notifications)) {
        const now = Date.now();
        const cutoff = now - this.maxTtlMilliseconds;
        for (const item of data.notifications) {
          if (item && item.id && item.payload && item.receivedAt >= cutoff) {
            this.notificationList.push(item);
          }
        }
      }
      this.pruneOldNotifications();
    } catch (readError) {
      applicationLogger.warn(
        `Failed to read inbound notification history from ${this.storageFilePath}: ${
          readError instanceof Error ? readError.message : String(readError)
        }`
      );
    }
  }

  private saveToStorage(): void {
    if (!this.storageFilePath) return;

    try {
      const dir = path.dirname(this.storageFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const snapshot: InboundNotificationSnapshot = {
        version: 1,
        notifications: this.notificationList,
      };

      const serialized = JSON.stringify(snapshot, null, 2);
      const tempPath = `${this.storageFilePath}.tmp.${Date.now()}.${randomUUID()}`;
      try {
        fs.writeFileSync(tempPath, serialized, 'utf-8');
        fs.renameSync(tempPath, this.storageFilePath);
      } catch (writeError) {
        if (fs.existsSync(tempPath)) {
          try {
            fs.unlinkSync(tempPath);
          } catch {}
        }
        throw writeError;
      }
    } catch (saveError) {
      applicationLogger.error(
        `Failed to save inbound notification history to ${this.storageFilePath}: ${
          saveError instanceof Error ? saveError.message : String(saveError)
        }`
      );
    }
  }
}
