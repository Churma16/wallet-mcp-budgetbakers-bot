import { applicationLogger } from '../../../utils/logger.js';
import { WhatsappSocketProvider } from './types.js';

export class WhatsappPresenceManager {
  private readonly lastTypingTimestampByChat = new Map<string, number>();

  constructor(
    private readonly getSocket: WhatsappSocketProvider,
    private readonly cooldownMilliseconds: number
  ) {}

  public getLastTypingTimestamp(chatIdentifier: string): number | undefined {
    return this.lastTypingTimestampByChat.get(chatIdentifier);
  }

  public getCooldownMilliseconds(): number {
    return this.cooldownMilliseconds;
  }

  public async sendTyping(chatIdentifier: string): Promise<void> {
    const socket = this.getSocket();
    if (!socket || !chatIdentifier.trim()) {
      return;
    }

    const lastTimestamp = this.lastTypingTimestampByChat.get(chatIdentifier) ?? 0;
    if (this.cooldownMilliseconds > 0 && Date.now() - lastTimestamp < this.cooldownMilliseconds) {
      return;
    }

    try {
      await socket.sendPresenceUpdate('composing', chatIdentifier);
      this.lastTypingTimestampByChat.set(chatIdentifier, Date.now());
    } catch (presenceError: unknown) {
      applicationLogger.fileDetail('warn', 'Failed to send WhatsApp typing presence update', {
        targetChatIdentifier: chatIdentifier,
        error: presenceError instanceof Error ? presenceError.message : String(presenceError),
      });
    }
  }

  public async clearTyping(chatIdentifier: string): Promise<void> {
    const socket = this.getSocket();
    if (!socket || !chatIdentifier.trim()) {
      return;
    }

    try {
      await socket.sendPresenceUpdate('paused', chatIdentifier);
    } catch (presenceError: unknown) {
      applicationLogger.fileDetail('warn', 'Failed to clear WhatsApp typing presence update', {
        targetChatIdentifier: chatIdentifier,
        error: presenceError instanceof Error ? presenceError.message : String(presenceError),
      });
    } finally {
      this.lastTypingTimestampByChat.delete(chatIdentifier);
    }
  }

  public reset(): void {
    this.lastTypingTimestampByChat.clear();
  }
}
