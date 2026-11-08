import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TicketDispatchState } from '../brain/constants.js';
import { applicationLogger } from '../lib/logger.js';
import type {
  PendingTransactionItem,
  PendingAccountSelectionDraft,
  PendingCategorySelectionDraft,
  PendingTransactionDispatchState,
  PendingTransactionStorageSnapshot,
} from './pendingTypes.js';

/**
 * Parsed and revived in-memory state loaded from a pending storage snapshot.
 */
export interface PendingStorageRestoreResult {
  nextTicketSequentialId: number;
  pendingTransactions: Map<number, PendingTransactionItem>;
  pendingAccountSelectionDrafts: Map<number, PendingAccountSelectionDraft>;
  pendingCategorySelectionDrafts: Map<number, PendingCategorySelectionDraft>;
  dispatchStates: Map<number, PendingTransactionDispatchState>;
  recentlyResolvedTicketIds: Map<number, number>;
}

function parseSafeDate(value: unknown, fallback: Date): Date {
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return fallback;
}

function parseSafeOptionalDate(value: unknown): Date | undefined {
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * Loads and revives pending transactions, clarification drafts, and ticket metadata from disk.
 * Returns null if the storage file does not exist or is empty.
 */
export function loadPendingSnapshotFromDisk(
  storageFilePath: string,
  defaultTimeToLiveMilliseconds: number
): PendingStorageRestoreResult | null {
  if (!fs.existsSync(storageFilePath)) {
    return null;
  }

  try {
    const rawContent = fs.readFileSync(storageFilePath, 'utf-8');
    if (!rawContent || rawContent.trim().length === 0) {
      return null;
    }

    const data = JSON.parse(rawContent) as Partial<PendingTransactionStorageSnapshot>;

    const pendingTransactions = new Map<number, PendingTransactionItem>();
    const pendingAccountSelectionDrafts = new Map<number, PendingAccountSelectionDraft>();
    const pendingCategorySelectionDrafts = new Map<number, PendingCategorySelectionDraft>();
    const dispatchStates = new Map<number, PendingTransactionDispatchState>();
    const recentlyResolvedTicketIds = new Map<number, number>();

    if (Array.isArray(data.pendingTransactions)) {
      for (const rawItem of data.pendingTransactions) {
        if (!rawItem || typeof rawItem.ticketId !== 'number') continue;
        const fallbackExpiresAt = new Date(Date.now() + defaultTimeToLiveMilliseconds);
        const revivedItem: PendingTransactionItem = {
          ...rawItem,
          createdAt: parseSafeDate(rawItem.createdAt, new Date()),
          expiresAt: parseSafeDate(rawItem.expiresAt, fallbackExpiresAt),
        };
        pendingTransactions.set(revivedItem.ticketId, revivedItem);
      }
    }

    if (Array.isArray(data.pendingAccountSelectionDrafts)) {
      for (const rawDraft of data.pendingAccountSelectionDrafts) {
        if (!rawDraft || typeof rawDraft.ticketId !== 'number') continue;
        const fallbackExpiresAt = new Date(Date.now() + defaultTimeToLiveMilliseconds);
        const revivedDraft: PendingAccountSelectionDraft = {
          ...rawDraft,
          createdAt: parseSafeDate(rawDraft.createdAt, new Date()),
          expiresAt: parseSafeDate(rawDraft.expiresAt, fallbackExpiresAt),
          sourceReferenceInstant: parseSafeOptionalDate(rawDraft.sourceReferenceInstant),
        };
        pendingAccountSelectionDrafts.set(revivedDraft.ticketId, revivedDraft);
      }
    }

    if (Array.isArray(data.pendingCategorySelectionDrafts)) {
      for (const rawDraft of data.pendingCategorySelectionDrafts) {
        if (!rawDraft || typeof rawDraft.ticketId !== 'number') continue;
        const fallbackExpiresAt = new Date(Date.now() + defaultTimeToLiveMilliseconds);
        const revivedDraft: PendingCategorySelectionDraft = {
          ...rawDraft,
          createdAt: parseSafeDate(rawDraft.createdAt, new Date()),
          expiresAt: parseSafeDate(rawDraft.expiresAt, fallbackExpiresAt),
          sourceReferenceInstant: parseSafeOptionalDate(rawDraft.sourceReferenceInstant),
        };
        pendingCategorySelectionDrafts.set(revivedDraft.ticketId, revivedDraft);
      }
    }

    if (Array.isArray(data.dispatchStates)) {
      for (const [ticketId, state] of data.dispatchStates) {
        if (
          typeof ticketId === 'number' &&
          typeof state === 'string' &&
          (pendingTransactions.has(ticketId) ||
            pendingAccountSelectionDrafts.has(ticketId) ||
            pendingCategorySelectionDrafts.has(ticketId))
        ) {
          const recoveredState: PendingTransactionDispatchState =
            state === TicketDispatchState.Processing
              ? TicketDispatchState.Pending
              : (state as PendingTransactionDispatchState);
          dispatchStates.set(ticketId, recoveredState);
        }
      }
    }

    for (const ticketId of pendingTransactions.keys()) {
      if (!dispatchStates.has(ticketId)) {
        dispatchStates.set(ticketId, TicketDispatchState.Pending);
      }
    }
    for (const ticketId of pendingAccountSelectionDrafts.keys()) {
      if (!dispatchStates.has(ticketId)) {
        dispatchStates.set(ticketId, TicketDispatchState.Pending);
      }
    }
    for (const ticketId of pendingCategorySelectionDrafts.keys()) {
      if (!dispatchStates.has(ticketId)) {
        dispatchStates.set(ticketId, TicketDispatchState.Pending);
      }
    }

    if (Array.isArray(data.recentlyResolvedTicketIds)) {
      for (const [ticketId, timestamp] of data.recentlyResolvedTicketIds) {
        if (typeof ticketId === 'number' && typeof timestamp === 'number') {
          recentlyResolvedTicketIds.set(ticketId, timestamp);
        }
      }
    }

    const allTicketIds = [
      ...Array.from(pendingTransactions.keys()),
      ...Array.from(pendingAccountSelectionDrafts.keys()),
      ...Array.from(pendingCategorySelectionDrafts.keys()),
    ];
    const maxActiveId = allTicketIds.length > 0 ? Math.max(...allTicketIds) : 0;
    let nextTicketSequentialId: number;
    if (typeof data.nextTicketSequentialId === 'number' && data.nextTicketSequentialId > maxActiveId) {
      nextTicketSequentialId = data.nextTicketSequentialId;
    } else {
      nextTicketSequentialId = maxActiveId + 1;
    }

    applicationLogger.info(
      `Restored ${pendingTransactions.size} pending transaction(s), ${pendingAccountSelectionDrafts.size} account draft(s), and ${pendingCategorySelectionDrafts.size} category draft(s) from '${storageFilePath}'.`
    );

    return {
      nextTicketSequentialId,
      pendingTransactions,
      pendingAccountSelectionDrafts,
      pendingCategorySelectionDrafts,
      dispatchStates,
      recentlyResolvedTicketIds,
    };
  } catch (error) {
    applicationLogger.error(
      `Failed to load pending transactions from '${storageFilePath}': ${error instanceof Error ? error.message : String(error)}`
    );
    try {
      if (fs.existsSync(storageFilePath)) {
        fs.copyFileSync(storageFilePath, `${storageFilePath}.corrupted.${Date.now()}`);
      }
    } catch {}
    return null;
  }
}

/**
 * Atomically writes a snapshot of pending transactions and drafts to disk.
 */
export function savePendingSnapshotToDisk(
  storageFilePath: string,
  snapshot: PendingTransactionStorageSnapshot
): void {
  try {
    const storageDir = path.dirname(storageFilePath);
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }

    const serialized = JSON.stringify(snapshot, null, 2);
    const tempPath = `${storageFilePath}.tmp.${Date.now()}.${randomUUID()}`;
    try {
      fs.writeFileSync(tempPath, serialized, 'utf-8');
      fs.renameSync(tempPath, storageFilePath);
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
      `Failed to persist pending transactions to '${storageFilePath}': ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
