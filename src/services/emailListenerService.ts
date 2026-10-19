import fs from 'fs';
import path from 'path';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { convert } from 'html-to-text';
import { evaluateEmailThroughGateOne, GateEvaluationResult } from '../utils/emailGateEvaluator.js';
import { calculateExponentialBackoff } from '../utils/exponentialBackoff.js';
import { applicationLogger } from '../utils/logger.js';

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

export interface EmailTransactionDetectedEvent {
  gateResult: GateEvaluationResult;
  emailSubject: string;
  emailSender: string;
  emailDate: Date;
  cleanedBodyText: string;
  rawMessageId: string;
}

export type EmailTransactionCallback = (event: EmailTransactionDetectedEvent) => Promise<void>;

interface PersistentTransactionCacheStructure {
  processedMessageIds: string[];
  processedReferenceNumbers: string[];
}

export class EmailListenerService {
  private imapClient: ImapFlow | null = null;
  private isServiceRunning: boolean = false;
  private isHandlingIncomingMail: boolean = false;
  private isReconnecting: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt: number = 0;
  private readonly reconnectBaseDelayMs: number = 5000;
  private readonly reconnectMaxDelayMs: number = 60000;
  private startupCutoffTimestamp: Date;
  private readonly processedMessageIdSet: Set<string> = new Set<string>();
  private readonly processedReferenceNumberSet: Set<string> = new Set<string>();
  private readonly inFlightMessageIdSet: Set<string> = new Set<string>();
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
    private readonly imapClientFactory?: (options: ConstructorParameters<typeof ImapFlow>[0]) => ImapFlow
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
          parsedCache.processedMessageIds.forEach(id => this.processedMessageIdSet.add(id));
        }
        if (Array.isArray(parsedCache.processedReferenceNumbers)) {
          parsedCache.processedReferenceNumbers.forEach(ref => this.processedReferenceNumberSet.add(ref));
        }

        applicationLogger.info(
          `Loaded transaction cache: ${this.processedMessageIdSet.size} message IDs, ${this.processedReferenceNumberSet.size} reference numbers.`
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

      const cachePayload: PersistentTransactionCacheStructure = {
        processedMessageIds: trimmedMessageIds,
        processedReferenceNumbers: trimmedReferenceNumbers,
      };

      fs.writeFileSync(this.cacheFilePath, JSON.stringify(cachePayload, null, 2), 'utf8');
    } catch (saveError) {
      applicationLogger.warn(`Failed to save transaction cache: ${saveError}`);
    }
  }

  /**
   * Marks a reference number and message ID as processed in cache
   */
  public recordProcessedTransaction(messageId?: string, referenceNumber?: string): void {
    if (messageId) {
      this.processedMessageIdSet.add(messageId);
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
   * Scans messages arriving after the startupCutoffTimestamp
   */
  public async scanRecentMessages(): Promise<void> {
    if (!this.imapClient || !this.imapClient.usable || this.isHandlingIncomingMail) {
      return;
    }

    this.isHandlingIncomingMail = true;

    try {
      // Search for unseen messages or messages since the cutoff date
      const searchDate = new Date(this.startupCutoffTimestamp.getTime() - 60000); // 1 min buffer
      const searchResultUids = await this.imapClient.search(
        { since: searchDate },
        { uid: true }
      );

      if (!searchResultUids || searchResultUids.length === 0) {
        return;
      }

      // Fetch message sources for the matching UIDs
      for (const messageUid of searchResultUids) {
        try {
          const fetchResult = await this.imapClient.fetchOne(
            String(messageUid),
            { source: true, envelope: true, uid: true, internalDate: true },
            { uid: true }
          );

          if (!fetchResult || !fetchResult.source) {
            continue;
          }

          // Parse raw RFC822 MIME source
          const parsedMime = await simpleParser(fetchResult.source);
          let emailDate: Date;
          if (parsedMime.date instanceof Date) {
            emailDate = parsedMime.date;
          } else if (fetchResult.internalDate instanceof Date) {
            emailDate = fetchResult.internalDate;
          } else if (typeof fetchResult.internalDate === 'string') {
            emailDate = new Date(fetchResult.internalDate);
          } else {
            emailDate = new Date();
          }

          const emailSubject = parsedMime.subject || '';
          const senderAddress =
            parsedMime.from?.value?.[0]?.address ||
            parsedMime.from?.text ||
            fetchResult.envelope?.from?.[0]?.address ||
            '';
          const rawMessageId = parsedMime.messageId || String(messageUid);

          // Fast deduplication check: Has this email message ID already been processed or claimed by another scan?
          if (
            this.processedMessageIdSet.has(rawMessageId) ||
            this.inFlightMessageIdSet.has(rawMessageId)
          ) {
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
            this.processedMessageIdSet.add(rawMessageId);
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
          this.inFlightMessageIdSet.add(rawMessageId);
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
            this.processedMessageIdSet.add(rawMessageId);
            this.savePersistentCache();
          } finally {
            // A rejected callback must leave the candidate retryable on a later scan.
            this.inFlightMessageIdSet.delete(rawMessageId);
          }
        } catch (individualMessageError) {
          const errorName = individualMessageError instanceof Error ? individualMessageError.name : 'UnknownError';
          applicationLogger.error(`Failed to process email UID ${messageUid} (${errorName}).`);
          applicationLogger.fileDetail('error', 'Email Transaction Processing Failure', {
            messageUid,
            error: individualMessageError,
          });
        }
      }
    } catch (scanError) {
      applicationLogger.error(`Error during IMAP scan: ${scanError}`);
    } finally {
      this.isHandlingIncomingMail = false;
    }
  }

  /**
   * Gracefully shuts down the IMAP client and listener
   */
  public async stop(): Promise<void> {
    this.isServiceRunning = false;
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
