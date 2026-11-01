import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { applicationLogger } from '../../lib/logger.js';

export interface StoredRecordMessageMapping {
  readonly recordId: string;
  readonly accountId: string;
  readonly createdAt: number;
  note?: string;
  categoryId?: string;
  categoryName?: string;
  labelIds?: string[];
  labels?: string[];
  amount?: number;
  counterParty?: string;
  channel?: string;
}

export interface TransactionMessageStoreSnapshot {
  readonly version: number;
  readonly mappings: [string, StoredRecordMessageMapping][];
}

export const DEFAULT_MESSAGE_MAPPING_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
export const DEFAULT_MAX_MESSAGE_MAPPINGS = 1000;

/**
 * Persistently stores Telegram message_id to Wallet MCP record_id correlations,
 * enabling users to edit recorded transactions by simply replying to the bot's confirmation message.
 */
export class TransactionMessageStore {
  private readonly mappingMap = new Map<string, StoredRecordMessageMapping>();
  private readonly maxTtlMilliseconds: number;
  private readonly maxEntries: number;

  constructor(
    private readonly storageFilePath?: string,
    options?: { maxTtlMilliseconds?: number; maxEntries?: number }
  ) {
    this.maxTtlMilliseconds = options?.maxTtlMilliseconds ?? DEFAULT_MESSAGE_MAPPING_TTL_MS;
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_MESSAGE_MAPPINGS;
    this.loadFromStorage();
  }

  public recordMessageMapping(
    messageId: string,
    data: Omit<StoredRecordMessageMapping, 'createdAt'> & { createdAt?: number }
  ): void {
    if (!messageId) return;

    const entry: StoredRecordMessageMapping = {
      ...data,
      createdAt: data.createdAt ?? Date.now(),
    };

    this.mappingMap.set(messageId, entry);
    this.pruneOldMappings();
    this.saveToStorage();
  }

  public getMessageMapping(messageId: string): StoredRecordMessageMapping | undefined {
    if (!messageId) return undefined;
    const found = this.mappingMap.get(messageId);
    if (!found) return undefined;

    // Verify entry is not expired
    if (Date.now() - found.createdAt > this.maxTtlMilliseconds) {
      this.mappingMap.delete(messageId);
      this.saveToStorage();
      return undefined;
    }

    return found;
  }

  public updateMessageMapping(
    messageId: string,
    updates: Partial<StoredRecordMessageMapping>
  ): void {
    const existing = this.mappingMap.get(messageId);
    if (!existing) return;

    Object.assign(existing, updates);
    this.saveToStorage();
  }

  public hasMapping(messageId: string): boolean {
    return this.getMessageMapping(messageId) !== undefined;
  }

  public clear(): void {
    this.mappingMap.clear();
    this.saveToStorage();
  }

  public size(): number {
    return this.mappingMap.size;
  }

  private pruneOldMappings(): void {
    const now = Date.now();
    for (const [msgId, entry] of this.mappingMap.entries()) {
      if (now - entry.createdAt > this.maxTtlMilliseconds) {
        this.mappingMap.delete(msgId);
      }
    }

    // Cap total entries to avoid unbounded file growth
    if (this.mappingMap.size > this.maxEntries) {
      const sortedEntries = Array.from(this.mappingMap.entries()).sort(
        (a, b) => a[1].createdAt - b[1].createdAt
      );
      const excessCount = this.mappingMap.size - this.maxEntries;
      for (let i = 0; i < excessCount; i++) {
        this.mappingMap.delete(sortedEntries[i][0]);
      }
    }
  }

  private loadFromStorage(): void {
    if (!this.storageFilePath || !fs.existsSync(this.storageFilePath)) {
      return;
    }

    try {
      const rawContent = fs.readFileSync(this.storageFilePath, 'utf-8');
      if (!rawContent || rawContent.trim().length === 0) {
        return;
      }

      const data = JSON.parse(rawContent) as Partial<TransactionMessageStoreSnapshot>;
      if (Array.isArray(data.mappings)) {
        for (const [msgId, mapping] of data.mappings) {
          if (typeof msgId === 'string' && mapping && typeof mapping.recordId === 'string') {
            this.mappingMap.set(msgId, {
              ...mapping,
              createdAt: typeof mapping.createdAt === 'number' && !Number.isNaN(mapping.createdAt) ? mapping.createdAt : Date.now(),
            });
          }
        }
      }

      this.pruneOldMappings();
      applicationLogger.info(
        `Restored ${this.mappingMap.size} message-to-record mapping(s) from '${this.storageFilePath}'.`
      );
    } catch (error) {
      applicationLogger.error(
        `Failed to load message mappings from '${this.storageFilePath}': ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      try {
        if (fs.existsSync(this.storageFilePath)) {
          fs.copyFileSync(this.storageFilePath, `${this.storageFilePath}.corrupted.${Date.now()}`);
        }
      } catch {}
    }
  }

  private saveToStorage(): void {
    if (!this.storageFilePath) {
      return;
    }

    try {
      const storageDir = path.dirname(this.storageFilePath);
      if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true });
      }

      const snapshot: TransactionMessageStoreSnapshot = {
        version: 1,
        mappings: Array.from(this.mappingMap.entries()),
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
    } catch (error) {
      applicationLogger.error(
        `Failed to persist message mappings to '${this.storageFilePath}': ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}
