export class MessageIdTracker {
  private readonly trackedIds = new Set<string>();

  constructor(private readonly maximumTrackedIds: number = 500) {}

  public has(messageId: string): boolean {
    return this.trackedIds.has(messageId);
  }

  public record(messageId: string): void {
    if (this.trackedIds.has(messageId)) {
      return;
    }

    if (this.trackedIds.size >= this.maximumTrackedIds) {
      const oldestTrackedId = this.trackedIds.values().next().value;
      if (oldestTrackedId) {
        this.trackedIds.delete(oldestTrackedId);
      }
    }

    this.trackedIds.add(messageId);
  }

  public clear(): void {
    this.trackedIds.clear();
  }
}
