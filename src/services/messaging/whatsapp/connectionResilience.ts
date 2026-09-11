import fs from 'fs';
import { randomInt } from 'node:crypto';
import { DisconnectReason } from '@whiskeysockets/baileys';
import { applicationLogger } from '../../../utils/logger.js';

export class WhatsappConnectionResilience {
  private consecutiveFailureCount = 0;
  private circuitBreakerTripped = false;
  private activeReconnectTimeout: NodeJS.Timeout | null = null;
  private hasPurgedSessionOnLogout = false;

  constructor(
    private readonly sessionDataDirectoryPath: string,
    private readonly reconnect: () => Promise<void>,
    private readonly maxReconnectAttempts: number,
    private readonly maxBackoffSeconds: number
  ) {}

  public get failureCount(): number {
    return this.consecutiveFailureCount;
  }

  public get isCircuitOpen(): boolean {
    return this.circuitBreakerTripped;
  }

  public get hasActiveReconnect(): boolean {
    return this.activeReconnectTimeout !== null;
  }

  public get reconnectTimeout(): NodeJS.Timeout | null {
    return this.activeReconnectTimeout;
  }

  public calculateBackoffDelayMilliseconds(attemptIndex: number = this.consecutiveFailureCount): number {
    const exponentialSeconds = 5 * Math.pow(2, attemptIndex);
    return Math.min(this.maxBackoffSeconds, exponentialSeconds) * 1000 + randomInt(500, 2500);
  }

  public reset(): void {
    this.consecutiveFailureCount = 0;
    this.circuitBreakerTripped = false;
    this.hasPurgedSessionOnLogout = false;
    this.cancelScheduledReconnect();
  }

  public prepareManualConnection(): void {
    this.consecutiveFailureCount = 0;
    this.circuitBreakerTripped = false;
  }

  public markConnected(): void {
    this.reset();
  }

  public stop(): void {
    this.cancelScheduledReconnect();
  }

  public handleClose(disconnectStatusCode: number | undefined, disconnectError: unknown): void {
    this.cancelScheduledReconnect();

    if (disconnectStatusCode === DisconnectReason.connectionReplaced) {
      this.circuitBreakerTripped = true;
      applicationLogger.error(
        '[CRITICAL] WhatsApp session was replaced by another device or active client (Status 440). Auto-reconnect aborted to prevent ban.'
      );
      return;
    }

    if (disconnectStatusCode === DisconnectReason.loggedOut) {
      this.handleLoggedOut();
      return;
    }

    if (disconnectStatusCode === DisconnectReason.restartRequired) {
      applicationLogger.info('WhatsApp internal restart required (Status 515). Fast-tracking reconnection in 1s...');
      this.scheduleReconnect(1000, 'fast-track restart');
      return;
    }

    if (disconnectStatusCode === DisconnectReason.badSession) {
      applicationLogger.warn('WhatsApp session corrupted (Status 500). Purging corrupted session credentials...');
      this.purgeSessionDirectory('Failed to clean corrupted session');
    }

    this.consecutiveFailureCount++;
    applicationLogger.warn(
      `WhatsApp connection closed (Status: ${disconnectStatusCode ?? 'unknown'}, Failure Count: ${this.consecutiveFailureCount}/${this.maxReconnectAttempts}): ${disconnectError}`
    );

    if (this.consecutiveFailureCount >= this.maxReconnectAttempts) {
      this.circuitBreakerTripped = true;
      applicationLogger.error(
        `[CIRCUIT_BREAKER] Maximum consecutive connection failures (${this.maxReconnectAttempts}) reached. Halting auto-reconnect to protect account from ban.`
      );
      return;
    }

    const delayMilliseconds = this.calculateBackoffDelayMilliseconds(this.consecutiveFailureCount - 1);
    applicationLogger.info(
      `Scheduling WhatsApp reconnection attempt ${this.consecutiveFailureCount} in ${Math.round(delayMilliseconds / 1000)}s (delay: ${delayMilliseconds}ms)...`
    );
    this.scheduleReconnect(delayMilliseconds, 'scheduled reconnection attempt');
  }

  private handleLoggedOut(): void {
    if (this.hasPurgedSessionOnLogout) {
      this.consecutiveFailureCount++;
      this.circuitBreakerTripped = true;
      applicationLogger.error(
        '[CRITICAL] Repeated loggedOut event detected after session purge. Possible account ban or invalid credentials. Halting auto-reconnect.'
      );
      return;
    }

    this.hasPurgedSessionOnLogout = true;
    applicationLogger.info('WhatsApp device logged out or unlinked. Purging invalid session credentials...');
    this.purgeSessionDirectory('Failed to clean up WhatsApp session directory');
    applicationLogger.info('Scheduling single fresh QR code generation in 5 seconds...');
    this.scheduleReconnect(5000, 'QR re-initialization');
  }

  private purgeSessionDirectory(errorPrefix: string): void {
    try {
      if (fs.existsSync(this.sessionDataDirectoryPath)) {
        fs.rmSync(this.sessionDataDirectoryPath, { recursive: true, force: true });
        applicationLogger.success('WhatsApp session directory cleaned up successfully.');
      }
    } catch (cleanupError: unknown) {
      applicationLogger.error(`${errorPrefix}: ${cleanupError}`);
    }
  }

  private scheduleReconnect(delayMilliseconds: number, context: string): void {
    this.activeReconnectTimeout = setTimeout(() => {
      this.activeReconnectTimeout = null;
      this.reconnect().catch(reconnectError => {
        applicationLogger.error(`Error during ${context}: ${reconnectError}`);
      });
    }, delayMilliseconds);
  }

  private cancelScheduledReconnect(): void {
    if (this.activeReconnectTimeout) {
      clearTimeout(this.activeReconnectTimeout);
      this.activeReconnectTimeout = null;
    }
  }
}
