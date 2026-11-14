export interface ActiveReconciliationPrompt {
  readonly chatId: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly promptMessageId?: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/**
 * In-memory TTL store for active /reconciliation upload prompts awaiting mutation photos.
 * Defaults to 5 minutes TTL.
 */
export class ReconciliationPromptStore {
  private readonly prompts = new Map<string, ActiveReconciliationPrompt>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  public setPrompt(
    chatId: string,
    account: { id: string; name: string },
    promptMessageId?: string
  ): void {
    this.pruneExpired();
    const now = Date.now();
    this.prompts.set(chatId, {
      chatId,
      accountId: account.id,
      accountName: account.name,
      promptMessageId,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    });
  }

  public getPrompt(chatId: string): ActiveReconciliationPrompt | undefined {
    this.pruneExpired();
    return this.prompts.get(chatId);
  }

  public deletePrompt(chatId: string): void {
    this.prompts.delete(chatId);
  }

  public pruneExpired(): void {
    const now = Date.now();
    for (const [chatId, prompt] of this.prompts.entries()) {
      if (prompt.expiresAt <= now) {
        this.prompts.delete(chatId);
      }
    }
  }

  public clear(): void {
    this.prompts.clear();
  }

  public get size(): number {
    return this.prompts.size;
  }
}

export const reconciliationPromptStore = new ReconciliationPromptStore();
