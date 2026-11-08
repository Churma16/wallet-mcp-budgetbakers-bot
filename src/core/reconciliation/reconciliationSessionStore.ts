import { randomBytes } from 'node:crypto';
import type { ReconciliationComparisonResult } from './types.js';

export interface FormattedTicketReference {
  readonly ticketId: number;
  readonly mutationId: string;
}

export interface ReconciliationSession {
  readonly id: string;
  readonly chatId: string;
  readonly targetAccountName: string;
  readonly result: ReconciliationComparisonResult;
  readonly ticketReferences: readonly FormattedTicketReference[];
  readonly createdAt: number;
  readonly expiresAt: number;
}

/**
 * In-memory TTL session store for active reconciliation queries to power Telegram inline pagination.
 */
export class ReconciliationSessionStore {
  private readonly sessions = new Map<string, ReconciliationSession>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = 2 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  public createSession(
    chatId: string,
    targetAccountName: string,
    result: ReconciliationComparisonResult,
    ticketReferences: readonly FormattedTicketReference[] = []
  ): string {
    this.pruneExpired();
    const id = randomBytes(4).toString('hex');
    const now = Date.now();
    const session: ReconciliationSession = {
      id,
      chatId,
      targetAccountName,
      result,
      ticketReferences,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.sessions.set(id, session);
    return id;
  }

  public getSession(id: string): ReconciliationSession | undefined {
    this.pruneExpired();
    return this.sessions.get(id);
  }

  public deleteSession(id: string): void {
    this.sessions.delete(id);
  }

  public pruneExpired(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.sessions.delete(id);
      }
    }
  }

  public clear(): void {
    this.sessions.clear();
  }
}

export const reconciliationSessionStore = new ReconciliationSessionStore();
