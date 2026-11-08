import fs from 'node:fs';
import path from 'node:path';
import { applicationLogger } from '../lib/logger.js';

export interface InboundReferenceEntry {
  readonly reference: string;
  source?: string;
  recordId?: string;
  ticketId?: number;
  amount?: number;
  currency?: string;
  accountId?: string;
  readonly recordedAt: number;
  readonly expiresAt: number;
}

export interface InboundReferenceRegistrySnapshot {
  readonly version: number;
  readonly references: InboundReferenceEntry[];
}

export const DEFAULT_REFERENCE_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours
export const DEFAULT_MAX_REFERENCE_ENTRIES = 1000;

/**
 * Normalizes reference strings for robust case-insensitive comparison
 */
export function normalizeReferenceNumber(ref?: string | null): string {
  return (ref || '').trim().toUpperCase();
}

/**
 * Centralized, persistent cross-gateway reference registry.
 * Enables both EmailListener and NotificationWebhook to discover previously processed
 * booking IDs, order numbers, and transaction reference numbers regardless of ingestion channel.
 */
export class InboundReferenceRegistry {
  private static instance: InboundReferenceRegistry;
  private readonly referencesMap = new Map<string, InboundReferenceEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(
    private readonly storageFilePath?: string,
    options?: { ttlMs?: number; maxEntries?: number }
  ) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_REFERENCE_TTL_MS;
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_REFERENCE_ENTRIES;
    this.loadFromStorage();
  }

  public static getInstance(storageFilePath?: string): InboundReferenceRegistry {
    if (!InboundReferenceRegistry.instance) {
      InboundReferenceRegistry.instance = new InboundReferenceRegistry(storageFilePath);
    }
    return InboundReferenceRegistry.instance;
  }

  public static resetInstance(): void {
    InboundReferenceRegistry.instance = new InboundReferenceRegistry();
  }

  public recordReference(
    reference: string,
    metadata?: {
      source?: string;
      recordId?: string;
      ticketId?: number;
      amount?: number;
      currency?: string;
      accountId?: string;
      ttlMs?: number;
    }
  ): void {
    const normalized = normalizeReferenceNumber(reference);
    if (!normalized || normalized === 'UNKNOWN' || normalized.length < 3) {
      return;
    }

    const now = Date.now();
    const ttl = metadata?.ttlMs ?? this.ttlMs;
    const existing = this.referencesMap.get(normalized);

    const entry: InboundReferenceEntry = {
      reference: normalized,
      source: metadata?.source ?? existing?.source,
      recordId: metadata?.recordId ?? existing?.recordId,
      ticketId: metadata?.ticketId ?? existing?.ticketId,
      amount: metadata?.amount ?? existing?.amount,
      currency: metadata?.currency ?? existing?.currency,
      accountId: metadata?.accountId ?? existing?.accountId,
      recordedAt: existing?.recordedAt ?? now,
      expiresAt: now + ttl,
    };

    this.referencesMap.set(normalized, entry);
    this.pruneExpired();
    this.saveToStorage();
  }

  public recordReferences(
    references: string[],
    metadata?: {
      source?: string;
      recordId?: string;
      ticketId?: number;
      amount?: number;
      currency?: string;
      accountId?: string;
      ttlMs?: number;
    }
  ): void {
    if (!Array.isArray(references) || references.length === 0) return;
    for (const ref of references) {
      this.recordReference(ref, metadata);
    }
  }

  public hasReference(reference?: string | null): boolean {
    const normalized = normalizeReferenceNumber(reference);
    if (!normalized) return false;
    const entry = this.referencesMap.get(normalized);
    if (!entry) return false;

    if (Date.now() > entry.expiresAt) {
      this.referencesMap.delete(normalized);
      this.saveToStorage();
      return false;
    }

    return true;
  }

  public getReference(reference?: string | null): InboundReferenceEntry | undefined {
    const normalized = normalizeReferenceNumber(reference);
    if (!normalized) return undefined;
    const entry = this.referencesMap.get(normalized);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.referencesMap.delete(normalized);
      this.saveToStorage();
      return undefined;
    }

    return entry;
  }

  public getRecordIdForReference(reference?: string | null): string | undefined {
    return this.getReference(reference)?.recordId;
  }

  public getTicketIdForReference(reference?: string | null): number | undefined {
    return this.getReference(reference)?.ticketId;
  }

  public getAllReferences(): string[] {
    this.pruneExpired();
    return Array.from(this.referencesMap.keys());
  }

  public size(): number {
    this.pruneExpired();
    return this.referencesMap.size;
  }

  public clear(): void {
    this.referencesMap.clear();
    this.saveToStorage();
  }

  public pruneExpired(): void {
    const now = Date.now();
    let mutated = false;

    for (const [key, entry] of this.referencesMap.entries()) {
      if (now > entry.expiresAt) {
        this.referencesMap.delete(key);
        mutated = true;
      }
    }

    // Prune excess if over capacity (FIFO by recordedAt)
    if (this.referencesMap.size > this.maxEntries) {
      const sorted = Array.from(this.referencesMap.entries()).sort(
        (a, b) => a[1].recordedAt - b[1].recordedAt
      );
      const excessCount = this.referencesMap.size - this.maxEntries;
      for (let i = 0; i < excessCount; i++) {
        this.referencesMap.delete(sorted[i][0]);
      }
      mutated = true;
    }

    if (mutated) {
      this.saveToStorage();
    }
  }

  private loadFromStorage(): void {
    if (!this.storageFilePath) return;

    try {
      if (!fs.existsSync(this.storageFilePath)) {
        return;
      }

      const raw = fs.readFileSync(this.storageFilePath, 'utf-8');
      if (!raw || !raw.trim()) return;

      const data = JSON.parse(raw) as Partial<InboundReferenceRegistrySnapshot>;
      if (Array.isArray(data.references)) {
        const now = Date.now();
        for (const refItem of data.references) {
          if (refItem && refItem.reference && now <= refItem.expiresAt) {
            this.referencesMap.set(refItem.reference, refItem);
          }
        }
      }
    } catch (readError) {
      applicationLogger.warn(
        `[InboundReferenceRegistry] Failed to load references snapshot: ${
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

      const snapshot: InboundReferenceRegistrySnapshot = {
        version: 1,
        references: Array.from(this.referencesMap.values()),
      };

      const tempFile = `${this.storageFilePath}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tempFile, JSON.stringify(snapshot, null, 2), 'utf-8');
      fs.renameSync(tempFile, this.storageFilePath);
    } catch (saveError) {
      applicationLogger.warn(
        `[InboundReferenceRegistry] Failed to save references snapshot: ${
          saveError instanceof Error ? saveError.message : String(saveError)
        }`
      );
    }
  }
}
