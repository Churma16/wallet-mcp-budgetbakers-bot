import fs from 'fs';
import path from 'path';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { convert } from 'html-to-text';
import { evaluateEmailThroughGateOne } from './bankRules.js';
import type {
  GateEvaluationResult,
  EmailTransactionDetectedEvent,
  EmailTransactionCallback,
  DeadLetterQueueItem,
  DeadLetterCallback,
  PersistentTransactionCacheStructure,
} from './types.js';
import { calculateExponentialBackoff } from '../lib/resilience.js';
import { applicationLogger } from '../lib/logger.js';

export type {
  GateEvaluationResult,
  EmailTransactionDetectedEvent,
  EmailTransactionCallback,
  DeadLetterQueueItem,
  DeadLetterCallback,
  PersistentTransactionCacheStructure,
};

/**
 * Extracts clean plain-text from email content.
 * Prioritizes converting HTML email bodies using html-to-text to strip <style>, <script>,
 * images, and ads while cleanly formatting tables, line breaks, and ride/order receipts.
 */
export function extractCleanEmailBody(
  rawTextContent?: string | null,
  rawHtmlContent?: string | boolean | null
): string {
  if (typeof rawHtmlContent === 'string' && rawHtmlContent.trim().length > 0) {
    try {
      const converted = convert(rawHtmlContent, {
        wordwrap: false,
        tables: true,
        selectors: [
          { selector: 'img', format: 'skip' },
          { selector: 'a', options: { ignoreHref: true } },
          { selector: 'style', format: 'skip' },
          { selector: 'script', format: 'skip' },
        ],
      });
      const normalized = converted.replace(/\u00a0/g, ' ').trim();
      if (normalized.length > 0) {
        return normalized;
      }
    } catch {
      // Fall through to fallback on parser failure
    }
  }

  if (typeof rawTextContent === 'string' && rawTextContent.trim().length > 0) {
    return rawTextContent.trim();
  }

  return '';
}

/**
 * Manages IMAP connection lifecycle, real-time IDLE event listening, reconnection backoff,
 * duplicate filtering, and Gate 1 evaluation for incoming bank and merchant transaction emails.
 */
export class EmailListenerService {
  private imapClient: ImapFlow | null = null;
  private isServiceRunning: boolean = false;
  private isHandlingIncomingMail: boolean = false;
  private hasPendingScanRequest: boolean = false;
  private isReconnecting: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private fallbackPollTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt: number = 0;
  private readonly reconnectBaseDelayMs: number = 5000;
  private readonly reconnectMaxDelayMs: number = 60000;
  private startupCutoffTimestamp: Date;
  private readonly processedMessageIdSet: Set<string> = new Set<string>();
  private readonly processedReferenceNumberSet: Set<string> = new Set<string>();
  private readonly inFlightMessageIdSet: Set<string> = new Set<string>();
  private readonly failedAttemptMap: Map<string, { attempts: number; lastAttemptAt: number; lastError: string }> = new Map();
  private deadLetterQueue: DeadLetterQueueItem[] = [];
  private readonly cacheFilePath: string;
  private readonly maxCachedItemsCount: number = 2000;

  constructor(
    private readonly imapHost: string,
    private readonly imapPort: number,
    private readonly imapUser: string,
    private readonly imapPassword: string,
    private readonly lookbackMinutes: number = 10,
    private readonly onTransactionDetected: EmailTransactionCallback,
    customCacheDirectoryPath?: string,
    private readonly imapClientFactory?: (options: ConstructorParameters<typeof ImapFlow>[0]) => ImapFlow,
    private readonly fallbackPollIntervalMs: number = 5 * 60 * 1000,
    private readonly maxRetryAttempts: number = 3,
    private readonly onDeadLetterRecorded?: DeadLetterCallback
  ) {
    // Only accept emails after startup cutoff (with lookback window)
    const lookbackMilliseconds = this.lookbackMinutes * 60 * 1000;
    this.startupCutoffTimestamp = new Date(Date.now() - lookbackMilliseconds);

    const baseCacheDir = customCacheDirectoryPath || path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(baseCacheDir)) {
      fs.mkdirSync(baseCacheDir, { recursive: true });
    }
    this.cacheFilePath = path.join(baseCacheDir, 'processed_transaction_cache.json');
    this.loadPersistentCache();
  }

  /**
   * Loads cached message IDs and reference numbers from persistent storage
   */
  private loadPersistentCache(): void {
    try {
      if (fs.existsSync(this.cacheFilePath)) {
        const fileContent = fs.readFileSync(this.cacheFilePath, 'utf8');
        const parsedCache: PersistentTransactionCacheStructure = JSON.parse(fileContent);

        if (Array.isArray(parsedCache.processedMessageIds)) {
          parsedCache.processedMessageIds.forEach(id => {
            const cleanId = id.replace(/^<|>$/g, '');
            this.processedMessageIdSet.add(id);
            this.processedMessageIdSet.add(cleanId);
            this.processedMessageIdSet.add(`<${cleanId}>`);
          });
        }
        if (Array.isArray(parsedCache.processedReferenceNumbers)) {
          parsedCache.processedReferenceNumbers.forEach(ref => this.processedReferenceNumberSet.add(ref));
        }
        if (Array.isArray(parsedCache.deadLetterQueue)) {
          this.deadLetterQueue = [...parsedCache.deadLetterQueue];
        }

        applicationLogger.info(
          `Loaded transaction cache: ${this.processedMessageIdSet.size} message IDs, ${this.processedReferenceNumberSet.size} reference numbers, ${this.deadLetterQueue.length} DLQ records.`
        );
      }
    } catch (cacheError) {
      applicationLogger.warn(`Failed to read cache file, starting with fresh cache: ${cacheError}`);
    }
  }

  /**
   * Saves updated cache to persistent disk storage
   */
  private savePersistentCache(): void {
    try {
      // Trim cache if too large
      const messageIdArray = Array.from(this.processedMessageIdSet);
      const referenceNumberArray = Array.from(this.processedReferenceNumberSet);

      const trimmedMessageIds = messageIdArray.slice(-this.maxCachedItemsCount);
      const trimmedReferenceNumbers = referenceNumberArray.slice(-this.maxCachedItemsCount);
      const trimmedDlq = this.deadLetterQueue.slice(-this.maxCachedItemsCount);

      const cachePayload: PersistentTransactionCacheStructure = {
        processedMessageIds: trimmedMessageIds,
        processedReferenceNumbers: trimmedReferenceNumbers,
        deadLetterQueue: trimmedDlq,
      };

      fs.writeFileSync(this.cacheFilePath, JSON.stringify(cachePayload, null, 2), 'utf8');
    } catch (saveError) {
      applicationLogger.warn(`Failed to save transaction cache: ${saveError}`);
    }
  }

  /**
   * Checks whether a message ID has already been marked as processed or terminally failed
   */
  public isMessageAlreadyProcessed(messageId: string): boolean {
    const cleanId = messageId.replace(/^<|>$/g, '');
    return (
      this.processedMessageIdSet.has(messageId) ||
      this.processedMessageIdSet.has(cleanId) ||
      this.processedMessageIdSet.has(`<${cleanId}>`)
    );
  }

  /**
   * Checks whether a message ID is currently in-flight
   */
  public isMessageInFlight(messageId: string): boolean {
    const cleanId = messageId.replace(/^<|>$/g, '');
    return (
      this.inFlightMessageIdSet.has(messageId) ||
      this.inFlightMessageIdSet.has(cleanId) ||
      this.inFlightMessageIdSet.has(`<${cleanId}>`)
    );
  }

  /**
   * Marks a message ID as processed across all formats and removes any failure records
   */
  public markMessageAsProcessed(messageId: string): void {
    const cleanId = messageId.replace(/^<|>$/g, '');
    this.processedMessageIdSet.add(messageId);
    this.failedAttemptMap.delete(messageId);
    this.failedAttemptMap.delete(cleanId);
    this.failedAttemptMap.delete(`<${cleanId}>`);
  }

  /**
   * Claims a message ID in the in-flight set
   */
  private claimMessageInFlight(messageId: string): void {
    this.inFlightMessageIdSet.add(messageId);
  }

  /**
   * Releases a message ID from the in-flight set across all formats
   */
  private releaseMessageInFlight(messageId: string): void {
    const cleanId = messageId.replace(/^<|>$/g, '');
    this.inFlightMessageIdSet.delete(messageId);
    this.inFlightMessageIdSet.delete(cleanId);
    this.inFlightMessageIdSet.delete(`<${cleanId}>`);
  }

  /**
   * Returns current Dead Letter Queue records
   */
  public getDeadLetterQueue(): DeadLetterQueueItem[] {
    return [...this.deadLetterQueue];
  }

  /**
   * Returns recorded failed attempts for a message ID
   */
  public getFailedAttemptCount(messageId: string): number {
    const cleanId = messageId.replace(/^<|>$/g, '');
    return (
      this.failedAttemptMap.get(messageId)?.attempts ||
      this.failedAttemptMap.get(`<${cleanId}>`)?.attempts ||
      this.failedAttemptMap.get(cleanId)?.attempts ||
      0
    );
  }

  /**
   * Clears Dead Letter Queue records
   */
  public clearDeadLetterQueue(): void {
    this.deadLetterQueue = [];
    this.savePersistentCache();
  }

  /**
   * Marks a reference number and message ID as processed in cache
   */
  public recordProcessedTransaction(messageId?: string, referenceNumber?: string): void {
    if (messageId) {
      this.markMessageAsProcessed(messageId);
    }
    if (referenceNumber) {
      this.processedReferenceNumberSet.add(referenceNumber);
    }
    this.savePersistentCache();
  }

  /**
   * Instantiates a new ImapFlow client or uses custom factory if injected
   */
  private createImapClient(): ImapFlow {
    const clientOptions = {
      host: this.imapHost,
      port: this.imapPort,
      secure: true,
      auth: {
        user: this.imapUser,
        pass: this.imapPassword,
      },
      logger: false as const,
    };

    if (this.imapClientFactory) {
      return this.imapClientFactory(clientOptions);
    }
    return new ImapFlow(clientOptions);
  }

  /**
   * Safely clears listeners and closes the active IMAP client
   */
  private cleanupCurrentClient(): void {
    if (this.imapClient) {
      try {
        this.imapClient.removeAllListeners();
        this.imapClient.close();
      } catch {
        // Ignore cleanup failure
      }
      this.imapClient = null;
    }
  }

  /**
   * Schedules a reconnection attempt with exponential backoff and jitter
   */
  private scheduleReconnect(): void {
    if (!this.isServiceRunning || this.isReconnecting || this.reconnectTimer !== null) {
      return;
    }

    const delayMs = calculateExponentialBackoff({
      attempt: this.reconnectAttempt,
      baseMs: this.reconnectBaseDelayMs,
      maxMs: this.reconnectMaxDelayMs,
      jitterMinMs: 500,
      jitterMaxMs: 2000,
    });
    this.reconnectAttempt += 1;

    applicationLogger.warn(
      `Scheduling Gmail IMAP reconnection attempt ${this.reconnectAttempt} in ${(delayMs / 1000).toFixed(1)}s (delay: ${delayMs}ms)...`
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.isServiceRunning) {
        return;
      }

      this.isReconnecting = true;
      try {
        await this.establishConnectionAndListen();
      } catch (reconnectError: unknown) {
        applicationLogger.error(
          `Gmail IMAP reconnection attempt ${this.reconnectAttempt} failed: ${reconnectError}`
        );
        this.isReconnecting = false;
        if (this.isServiceRunning) {
          this.scheduleReconnect();
        }
      } finally {
        this.isReconnecting = false;
      }
    }, delayMs);
  }

  /**
   * Creates a fresh ImapFlow client, establishes connection, and starts the mailbox idle cycle
   */
  private async establishConnectionAndListen(): Promise<void> {
    if (!this.isServiceRunning) {
      return;
    }

    this.cleanupCurrentClient();

    applicationLogger.info('Initializing Gmail IMAP Client...');
    const client = this.createImapClient();
    this.imapClient = client;

    client.on('error', error => {
      applicationLogger.error(`Gmail IMAP Connection Error: ${error.message}`);
    });

    client.on('close', () => {
      applicationLogger.warn('Gmail IMAP socket connection closed.');
      if (this.isServiceRunning) {
        this.scheduleReconnect();
      }
    });

    await client.connect();
    if (!this.isServiceRunning) {
      try {
        client.removeAllListeners();
        client.close();
      } catch {
        // Ignore teardown failure
      }
      if (this.imapClient === client) {
        this.imapClient = null;
      }
      return;
    }

    applicationLogger.success('Connected to Gmail IMAP successfully.');
    this.reconnectAttempt = 0;

    // Run mailbox idle cycle in the background
    this.runMailboxIdleCycle(client).catch(cycleError => {
      applicationLogger.error(`IMAP idle cycle error: ${cycleError}`);
    });
  }

  /**
   * Starts the IMAP connection and enters real-time IDLE mode
   */
  public async startListening(): Promise<void> {
    if (this.isServiceRunning) {
      return;
    }

    if (!this.imapUser || !this.imapPassword) {
      throw new Error('EMAIL_IMAP_USER and EMAIL_IMAP_PASSWORD must be configured in .env');
    }

    this.isServiceRunning = true;
    this.reconnectAttempt = 0;
    this.startFallbackPoll();

    try {
      await this.establishConnectionAndListen();
    } catch (initialConnectError: unknown) {
      applicationLogger.error(`Initial Gmail IMAP connection failed: ${initialConnectError}`);
      if (this.isServiceRunning) {
        this.scheduleReconnect();
      }
      throw initialConnectError;
    }
  }

  /**
   * Opens INBOX, fetches recent messages, and enters the IDLE loop
   */
  private async runMailboxIdleCycle(activeClient?: ImapFlow): Promise<void> {
    const client = activeClient || this.imapClient;
    if (!client || !this.isServiceRunning) {
      return;
    }

    try {
      const mailboxLock = await client.getMailboxLock('INBOX');
      let onExists: (() => Promise<void>) | null = null;

      try {
        applicationLogger.info('INBOX opened. Scanning recent unseen/new messages...');
        await this.scanRecentMessages();

        onExists = async () => {
          applicationLogger.info('New message notification received via IMAP exists event.');
          await this.scanRecentMessages();
        };

        client.on('exists', onExists);

        // Loop IDLE while service is active
        while (this.isServiceRunning && client.usable && this.imapClient === client) {
          try {
            await client.idle();
          } catch (idleError: unknown) {
            // Idle interrupted or ping timeout, loop will continue if still running
            applicationLogger.fileDetail('debug', 'IMAP idle cycle reset', idleError);
            if (!client.usable) {
              break;
            }
          }
        }
      } finally {
        if (onExists) {
          client.off('exists', onExists);
        }
        mailboxLock.release();
      }
    } catch (cycleError: unknown) {
      applicationLogger.error(`Error in IMAP idle cycle: ${cycleError}`);
    }

    if (this.isServiceRunning && this.imapClient === client && !client.usable) {
      this.scheduleReconnect();
    }
  }

  /**
   * Starts periodic fallback scan timer to guard against missed IMAP IDLE socket wakeups
   */
  private startFallbackPoll(): void {
    this.stopFallbackPoll();
    if (this.fallbackPollIntervalMs > 0) {
      this.fallbackPollTimer = setInterval(() => {
        if (
          this.isServiceRunning &&
          this.imapClient &&
          this.imapClient.usable &&
          !this.isHandlingIncomingMail
        ) {
          applicationLogger.fileDetail('debug', 'Triggering periodic fallback IMAP scan');
          void this.scanRecentMessages();
        }
      }, this.fallbackPollIntervalMs);
      this.fallbackPollTimer.unref?.();
    }
  }

  /**
   * Clears the fallback periodic scan timer
   */
  private stopFallbackPoll(): void {
    if (this.fallbackPollTimer) {
      clearInterval(this.fallbackPollTimer);
      this.fallbackPollTimer = null;
    }
  }

  /**
   * Scans messages arriving after the cutoff timestamp, queuing follow-up scans
   * if new exists events arrive while a scan is already in progress.
   */
  public async scanRecentMessages(): Promise<void> {
    if (!this.imapClient || !this.imapClient.usable) {
      return;
    }

    if (this.isHandlingIncomingMail) {
      this.hasPendingScanRequest = true;
      applicationLogger.info('Incoming IMAP event queued: active scan in progress.');
      return;
    }

    this.isHandlingIncomingMail = true;

    try {
      do {
        this.hasPendingScanRequest = false;
        await this.performRecentMessagesScan();
      } while (this.hasPendingScanRequest && this.imapClient?.usable);
    } finally {
      this.isHandlingIncomingMail = false;
      this.hasPendingScanRequest = false;
    }
  }

  /**
   * Executes a single recent message scan pass across the INBOX
   */
  private async performRecentMessagesScan(): Promise<void> {
    if (!this.imapClient || !this.imapClient.usable) {
      return;
    }

    try {
      // Use sliding lookback window with 1-min buffer while never querying before startupCutoffTimestamp
      const searchBufferMs = 60000;
      const slidingLookbackMs = this.lookbackMinutes * 60 * 1000;
      const slidingCutoffDate = new Date(Date.now() - slidingLookbackMs - searchBufferMs);
      const searchDate = new Date(
        Math.max(
          this.startupCutoffTimestamp.getTime() - searchBufferMs,
          slidingCutoffDate.getTime()
        )
      );

      const searchResultUids = await this.imapClient.search(
        { since: searchDate },
        { uid: true }
      );

      if (!searchResultUids || searchResultUids.length === 0) {
        return;
      }

      // Fetch message sources for the matching UIDs
      for (const messageUid of searchResultUids) {
        let currentMessageId: string = String(messageUid);
        let currentSubject: string = '';
        let currentSender: string = '';
        let currentDate: Date = new Date();

        try {
          const fetchResult = await this.imapClient.fetchOne(
            String(messageUid),
            { source: true, envelope: true, uid: true, internalDate: true },
            { uid: true }
          );

          if (!fetchResult || !fetchResult.source) {
            continue;
          }

          // Fast deduplication pre-check from envelope before parsing MIME source
          const envelopeMessageId = fetchResult.envelope?.messageId;
          if (envelopeMessageId) {
            currentMessageId = envelopeMessageId;
          }
          const isEnvelopeAlreadyProcessed = Boolean(
            envelopeMessageId &&
              (this.isMessageAlreadyProcessed(envelopeMessageId) || this.isMessageInFlight(envelopeMessageId))
          );

          if (isEnvelopeAlreadyProcessed) {
            continue;
          }

          // Parse raw RFC822 MIME source
          const parsedMime = await simpleParser(fetchResult.source);
          const emailDate =
            parsedMime.date instanceof Date
              ? parsedMime.date
              : fetchResult.internalDate
                ? new Date(fetchResult.internalDate)
                : new Date();

          const emailSubject = parsedMime.subject || '';
          const senderAddress =
            parsedMime.from?.value?.[0]?.address ||
            parsedMime.from?.text ||
            fetchResult.envelope?.from?.[0]?.address ||
            '';
          const rawMessageId = parsedMime.messageId || envelopeMessageId || String(messageUid);
          currentMessageId = rawMessageId;
          currentSubject = emailSubject;
          currentSender = senderAddress;
          currentDate = emailDate;

          // Fast deduplication check: Has this email message ID already been processed or claimed by another scan?
          if (this.isMessageAlreadyProcessed(rawMessageId) || this.isMessageInFlight(rawMessageId)) {
            continue;
          }

          // Extract clean text content (handles HTML receipts, strips CSS/script, formats tables)
          const cleanBodyText = extractCleanEmailBody(parsedMime.text, parsedMime.html);

          // Evaluate through Gate 1: Logic & Dictionary
          const gateResult = evaluateEmailThroughGateOne(
            emailSubject,
            senderAddress,
            cleanBodyText,
            emailDate,
            this.startupCutoffTimestamp,
            this.processedReferenceNumberSet
          );

          if (!gateResult.passed) {
            // Gate 1 rejection is terminal for this message, so cache immediately to avoid redundant evaluation.
            this.markMessageAsProcessed(rawMessageId);
            this.savePersistentCache();

            applicationLogger.info('[Gate 1 Skip] Email rejected by initial transaction gate.');
            applicationLogger.fileDetail('email', 'Gate 1 Rejected Email Candidate', {
              emailSubject,
              senderAddress,
              reason: gateResult.reason,
            });
            continue;
          }

          applicationLogger.info(
            `[Gate 1 Passed] Matched bank rule: ${gateResult.matchedBankRule?.displayName || 'unknown'}.`
          );
          applicationLogger.fileDetail('email', 'Gate 1 Accepted Email Candidate', {
            emailSubject,
            senderAddress,
            gateResult,
          });

          // Claim the candidate in memory while downstream Gate 2 / pending transaction handling is active.
          this.claimMessageInFlight(rawMessageId);
          try {
            await this.onTransactionDetected({
              gateResult,
              emailSubject,
              emailSender: senderAddress,
              emailDate,
              cleanedBodyText: cleanBodyText.substring(0, 12000), // Rich context limit for LLM prompt efficiency
              rawMessageId,
            });

            // Only persist a transaction candidate after downstream handling succeeds.
            this.markMessageAsProcessed(rawMessageId);
            this.savePersistentCache();
          } finally {
            // Release the in-flight claim. If rejected by downstream error, remains retryable on next scan.
            this.releaseMessageInFlight(rawMessageId);
          }
        } catch (individualMessageError) {
          const errorName = individualMessageError instanceof Error ? individualMessageError.name : 'UnknownError';
          const errorMessage = individualMessageError instanceof Error ? individualMessageError.message : String(individualMessageError);

          const previousAttempts = this.getFailedAttemptCount(currentMessageId);
          const currentAttempts = previousAttempts + 1;
          const cleanId = currentMessageId.replace(/^<|>$/g, '');
          const attemptDetails = {
            attempts: currentAttempts,
            lastAttemptAt: Date.now(),
            lastError: `${errorName}: ${errorMessage}`,
          };
          this.failedAttemptMap.set(currentMessageId, attemptDetails);
          this.failedAttemptMap.set(cleanId, attemptDetails);
          this.failedAttemptMap.set(`<${cleanId}>`, attemptDetails);

          if (currentAttempts >= this.maxRetryAttempts) {
            applicationLogger.error(
              `[DLQ] Email UID ${messageUid} (${currentMessageId}) exceeded maximum retry attempts (${currentAttempts}/${this.maxRetryAttempts}). Moving to Dead Letter Queue.`
            );
            const dlqItem: DeadLetterQueueItem = {
              messageId: currentMessageId,
              subject: currentSubject,
              sender: currentSender,
              date: currentDate.toISOString(),
              attempts: currentAttempts,
              lastError: `${errorName}: ${errorMessage}`,
              failedAt: new Date().toISOString(),
            };
            this.deadLetterQueue.push(dlqItem);
            this.markMessageAsProcessed(currentMessageId);
            this.savePersistentCache();

            if (this.onDeadLetterRecorded) {
              try {
                await this.onDeadLetterRecorded(dlqItem);
              } catch (dlqNotifyError) {
                applicationLogger.warn(`Failed to dispatch DLQ notification for ${currentMessageId}: ${dlqNotifyError}`);
              }
            }
          } else {
            applicationLogger.warn(
              `[Retryable Failure] Email UID ${messageUid} (${currentMessageId}) failed attempt ${currentAttempts}/${this.maxRetryAttempts} (${errorName}: ${errorMessage}). Will retry on subsequent scan.`
            );
          }

          applicationLogger.fileDetail('error', 'Email Transaction Processing Failure', {
            messageUid,
            error: individualMessageError,
            attempts: currentAttempts,
            maxRetryAttempts: this.maxRetryAttempts,
            movedToDlq: currentAttempts >= this.maxRetryAttempts,
          });
        }
      }
    } catch (scanError) {
      applicationLogger.error(`Error during IMAP scan: ${scanError}`);
    }
  }

  /**
   * Gracefully shuts down the IMAP client and listener
   */
  public async stop(): Promise<void> {
    this.isServiceRunning = false;
    this.stopFallbackPoll();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.imapClient) {
      try {
        this.imapClient.removeAllListeners();
        await this.imapClient.logout();
      } catch {
        this.imapClient.close();
      }
      this.imapClient = null;
    }
    applicationLogger.info('Gmail IMAP listener stopped gracefully.');
  }
}
