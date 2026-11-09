import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { applicationLogger } from '../../lib/logger.js';
import type { TransactionEvidence } from '../../email/types.js';
import { isGenericMerchant, isGenericCategory, isOnlinePlatformOrGateway } from '../../email/index.js';
import { CommercePlatformRegistry } from '../../config/commercePlatforms.js';

export interface EnrichmentPoolItem {
  readonly recordId: string;
  readonly accountId: string;
  accountName?: string;
  amount: number;
  currency?: string;
  recordDate: string; // ISO 8601 string
  counterParty?: string;
  note?: string;
  categoryId?: string;
  categoryName?: string;
  labels?: string[];
  referenceNumbers?: string[];
  channel?: string;
  notificationMessageIds?: Record<string, string>;
  isBankSynced?: boolean;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface EnrichmentPoolStorageSnapshot {
  readonly version: number;
  readonly candidates: EnrichmentPoolItem[];
}

export const DEFAULT_ENRICHMENT_POOL_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours
export const DEFAULT_MAX_ENRICHMENT_POOL_ITEMS = 500;

/**
 * Checks whether an existing or freshly created transaction record has generic
 * or incomplete metadata (e.g. placeholder merchant, unclassified category, or boilerplate note)
 * that warrants holding it in the enrichment pool for prospective merchant receipt fusion.
 */
export function isEligibleForEnrichmentPool(item: {
  counterParty?: string;
  categoryName?: string;
  categoryId?: string;
  note?: string;
}): boolean {
  const isGenericCp =
    isGenericMerchant(item.counterParty) ||
    isOnlinePlatformOrGateway(item.counterParty) ||
    CommercePlatformRegistry.getInstance().isCommerceMerchant(item.counterParty);
  const isGenericCat = isGenericCategory(item.categoryName) || !item.categoryId;
  const noteLower = (item.note || '').trim().toLowerCase();
  const isBoilerplate =
    !noteLower ||
    noteLower === 'pembayaran qris' ||
    noteLower.startsWith('pembayaran kartu debit') ||
    noteLower.includes('debit card') ||
    noteLower.includes('kartu debit') ||
    noteLower === 'transaksi' ||
    noteLower === (item.counterParty || '').trim().toLowerCase();

  return isGenericCp || isGenericCat || isBoilerplate;
}

/**
 * Persistently stores active Wallet transaction records that are candidates for retroactive enrichment.
 * Retains records within a configurable TTL (default 48 hours) without holding them in the pending queue,
 * enabling fast in-memory matching and retroactive MCP patching when merchant receipts arrive late.
 */
export class EnrichmentPoolService {
  private readonly poolMap = new Map<string, EnrichmentPoolItem>(); // key: recordId
  private readonly maxTtlMilliseconds: number;
  private readonly maxEntries: number;

  constructor(
    private readonly storageFilePath?: string,
    options?: { maxTtlMilliseconds?: number; maxEntries?: number }
  ) {
    this.maxTtlMilliseconds = options?.maxTtlMilliseconds ?? DEFAULT_ENRICHMENT_POOL_TTL_MS;
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENRICHMENT_POOL_ITEMS;
    this.loadFromStorage();
  }

  public addCandidate(
    item: Omit<EnrichmentPoolItem, 'createdAt' | 'expiresAt'> & { ttlMs?: number; createdAt?: number }
  ): void {
    if (!item.recordId) return;

    const createdAt = item.createdAt ?? Date.now();
    const ttl = item.ttlMs ?? this.maxTtlMilliseconds;
    const poolItem: EnrichmentPoolItem = {
      ...item,
      createdAt,
      expiresAt: createdAt + ttl,
    };

    this.poolMap.set(item.recordId, poolItem);
    this.pruneExpired();
    this.saveToStorage();
  }

  public getCandidate(recordId: string): EnrichmentPoolItem | undefined {
    if (!recordId) return undefined;
    const found = this.poolMap.get(recordId);
    if (!found) return undefined;

    if (Date.now() > found.expiresAt) {
      this.poolMap.delete(recordId);
      this.saveToStorage();
      return undefined;
    }

    return found;
  }

  public removeCandidate(recordId: string): boolean {
    if (!recordId) return false;
    const deleted = this.poolMap.delete(recordId);
    if (deleted) {
      this.saveToStorage();
    }
    return deleted;
  }

  public updateCandidate(
    recordId: string,
    updates: Partial<EnrichmentPoolItem>
  ): void {
    const existing = this.getCandidate(recordId);
    if (!existing) return;

    Object.assign(existing, updates);
    this.saveToStorage();
  }

  public getAllCandidates(): EnrichmentPoolItem[] {
    this.pruneExpired();
    return Array.from(this.poolMap.values());
  }

  public findMatchingCandidate(
    evidence: TransactionEvidence,
    maxTimeDifferenceMs: number = 24 * 60 * 60 * 1000
  ): EnrichmentPoolItem | undefined {
    this.pruneExpired();
    const evidenceAmount = Math.abs(evidence.amount);
    const evidenceCurrency = (evidence.currency || 'IDR').toUpperCase();

    for (const item of this.poolMap.values()) {
      if (Math.abs(item.amount) !== evidenceAmount) {
        continue;
      }

      const itemCurrency = (item.currency || 'IDR').toUpperCase();
      if (itemCurrency !== evidenceCurrency) {
        continue;
      }

      if (
        evidence.accountId &&
        item.accountId &&
        evidence.accountId !== 'acc-cash' &&
        evidence.accountId !== item.accountId
      ) {
        continue;
      }

      const itemTime = new Date(item.recordDate).getTime();
      const evidenceTime = new Date(evidence.occurredAt).getTime();
      const timeDiff = Math.abs(evidenceTime - itemTime);
      if (timeDiff > maxTimeDifferenceMs) {
        continue;
      }

      return item;
    }

    return undefined;
  }

  public clear(): void {
    this.poolMap.clear();
    this.saveToStorage();
  }

  public size(): number {
    return this.poolMap.size;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [recordId, item] of this.poolMap.entries()) {
      if (now > item.expiresAt) {
        this.poolMap.delete(recordId);
      }
    }

    if (this.poolMap.size > this.maxEntries) {
      const sorted = Array.from(this.poolMap.entries()).sort(
        (a, b) => a[1].createdAt - b[1].createdAt
      );
      const toRemove = sorted.slice(0, sorted.length - this.maxEntries);
      for (const [oldId] of toRemove) {
        this.poolMap.delete(oldId);
      }
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

      const data = JSON.parse(raw) as Partial<EnrichmentPoolStorageSnapshot>;
      if (Array.isArray(data.candidates)) {
        const now = Date.now();
        for (const candidate of data.candidates) {
          if (candidate.recordId && (!candidate.expiresAt || candidate.expiresAt > now)) {
            this.poolMap.set(candidate.recordId, candidate);
          }
        }
      }
      this.pruneExpired();
    } catch (readError) {
      applicationLogger.warn(
        `Failed to read enrichment pool from ${this.storageFilePath}: ${
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

      const snapshot: EnrichmentPoolStorageSnapshot = {
        version: 1,
        candidates: Array.from(this.poolMap.values()),
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
        `Failed to save enrichment pool to ${this.storageFilePath}: ${
          saveError instanceof Error ? saveError.message : String(saveError)
        }`
      );
    }
  }
}
