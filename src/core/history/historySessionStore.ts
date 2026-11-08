import { randomBytes } from 'node:crypto';
import type { TransactionHistoryQueryOptions } from '../../wallet/index.js';

export interface HistorySession {
  readonly id: string;
  readonly chatId: string;
  readonly queryOptions?: TransactionHistoryQueryOptions;
  readonly totalPages: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/**
 * In-memory TTL session store for active transaction history queries to power Telegram inline pagination.
 */
export class HistorySessionStore {
  private readonly sessions = new Map<string, HistorySession>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = 2 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  public createSession(
    chatId: string,
    queryOptions?: TransactionHistoryQueryOptions,
    totalPages: number = 1
  ): string {
    this.pruneExpired();
    const id = randomBytes(4).toString('hex');
    const now = Date.now();
    const session: HistorySession = {
      id,
      chatId,
      queryOptions,
      totalPages,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.sessions.set(id, session);
    return id;
  }

  public getSession(id: string): HistorySession | undefined {
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

export const historySessionStore = new HistorySessionStore();
