import { applicationLogger } from '../lib/logger.js';
import { MessagingGatewayService } from '../gateway/coordinator.js';
import { SupportedMessengerChannel } from '../gateway/types.js';
import { ModelFallbackEvent } from '../brain/types.js';
import { getDictionary } from '../i18n/index.js';

export interface ModelFallbackProgressTrackerOptions {
  gateway: MessagingGatewayService;
  channel: SupportedMessengerChannel;
  chatIdentifier: string;
  gracePeriodMs?: number;
  initialMessage?: string;
  cyclingMessage?: string;
}

/**
 * Manages the hybrid grace-period progress indicator for AI model cycling.
 *
 * Responsibilities:
 * 1. Fast Path (< gracePeriodMs): Remains quiet with typing presence only.
 *    If processing finishes quickly without error or fallback, zero status bubbles are sent.
 * 2. Fallback / Slow Path: If grace period elapses or model fallback occurs,
 *    sends a polite, plain-language status bubble and edits it in-place during subsequent model retries.
 * 3. Finalization: Automatically deletes the temporary progress bubble upon cleanup so chat history
 *    remains completely clean for the final transaction card.
 */
export class ModelFallbackProgressTracker {
  private readonly gateway: MessagingGatewayService;
  private readonly channel: SupportedMessengerChannel;
  private readonly chatIdentifier: string;
  private readonly gracePeriodMs: number;
  private readonly initialMessage: string;
  private readonly cyclingMessage: string;

  private graceTimer: NodeJS.Timeout | null = null;
  private statusMessageId: string | null = null;
  private isCleanedUp = false;
  private isSending = false;
  private sendPromise: Promise<void> | null = null;

  constructor(options: ModelFallbackProgressTrackerOptions) {
    this.gateway = options.gateway;
    this.channel = options.channel;
    this.chatIdentifier = options.chatIdentifier;
    this.gracePeriodMs = options.gracePeriodMs ?? 2500;
    this.initialMessage = options.initialMessage ?? getDictionary().aiFallbackStatus.initial;
    this.cyclingMessage = options.cyclingMessage ?? getDictionary().aiFallbackStatus.cycling;
  }

  /**
   * Starts the grace period timer. If processing takes longer than gracePeriodMs,
   * a preliminary plain-language status bubble will be dispatched.
   */
  public start(): void {
    if (this.isCleanedUp) {
      return;
    }

    this.graceTimer = setTimeout(async () => {
      await this.sendInitialStatusMessage();
    }, this.gracePeriodMs);
  }

  /**
   * Callback invoked whenever a model or provider fallback attempt occurs.
   * Immediately clears any pending grace timer and presents or updates the status bubble.
   */
  public async handleFallback(event: ModelFallbackEvent): Promise<void> {
    if (this.isCleanedUp) {
      return;
    }

    // Cancel grace timer immediately since model fallback is active
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }

    applicationLogger.fileDetail('ai', 'Model Fallback Progress Event Triggered', {
      channel: this.channel,
      chatIdentifier: this.chatIdentifier,
      currentModel: event.currentModel,
      nextModel: event.nextModel,
      attemptIndex: event.attemptIndex,
      totalCandidates: event.totalCandidates,
      reason: event.reason,
    });

    if (!this.statusMessageId && !this.isSending) {
      // First status presentation: send initial plain-language status bubble
      await this.sendInitialStatusMessage();
    } else if (this.statusMessageId) {
      // Subsequent fallback attempt: update the existing message in-place
      try {
        await this.gateway.editMessage(
          this.channel,
          this.chatIdentifier,
          this.statusMessageId,
          this.cyclingMessage
        );
      } catch (editError: unknown) {
        applicationLogger.fileDetail('warn', 'Failed to update fallback status message in-place', {
          chatIdentifier: this.chatIdentifier,
          statusMessageId: this.statusMessageId,
          error: editError instanceof Error ? editError.message : String(editError),
        });
      }
    }

    // Refresh typing indicator to assure user active progress continues
    try {
      await this.gateway.sendTypingPresence(this.channel, this.chatIdentifier);
    } catch {
      // Non-critical presence update
    }
  }

  /**
   * Dispatches the initial status message to the chat channel.
   */
  private async sendInitialStatusMessage(): Promise<void> {
    if (this.isCleanedUp || this.statusMessageId || this.isSending) {
      return;
    }

    this.isSending = true;
    this.sendPromise = (async () => {
      try {
        const receipt = await this.gateway.sendMessage(
          this.channel,
          this.chatIdentifier,
          this.initialMessage
        );

        if (this.isCleanedUp) {
          // Race condition: cleanup was executed while sendMessage was in flight
          if (receipt?.messageId) {
            await this.safelyDeleteMessage(receipt.messageId);
          }
        } else if (receipt?.messageId) {
          this.statusMessageId = receipt.messageId;
        }
      } catch (sendError: unknown) {
        applicationLogger.fileDetail('warn', 'Failed to send initial fallback status message', {
          chatIdentifier: this.chatIdentifier,
          error: sendError instanceof Error ? sendError.message : String(sendError),
        });
      } finally {
        this.isSending = false;
        this.sendPromise = null;
      }
    })();

    await this.sendPromise;
  }

  /**
   * Cleans up any pending timers and deletes the active status message bubble.
   * Safe to call multiple times (idempotent).
   */
  public async cleanup(): Promise<void> {
    this.isCleanedUp = true;

    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }

    if (this.sendPromise) {
      await this.sendPromise;
    }

    if (!this.statusMessageId) {
      return;
    }

    const messageIdToDelete = this.statusMessageId;
    this.statusMessageId = null;
    await this.safelyDeleteMessage(messageIdToDelete);
  }

  private async safelyDeleteMessage(messageId: string): Promise<void> {
    try {
      if (typeof this.gateway.deleteMessage === 'function') {
        await this.gateway.deleteMessage(this.channel, this.chatIdentifier, messageId);
      }
    } catch (deleteError: unknown) {
      applicationLogger.fileDetail('warn', 'Failed to delete fallback status message during cleanup', {
        channel: this.channel,
        chatIdentifier: this.chatIdentifier,
        messageId,
        error: deleteError instanceof Error ? deleteError.message : String(deleteError),
      });
    }
  }

  public getStatusMessageId(): string | null {
    return this.statusMessageId;
  }
}
