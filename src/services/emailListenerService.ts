import fs from 'fs';
import path from 'path';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { evaluateEmailThroughGateOne, GateEvaluationResult } from '../utils/emailGateEvaluator.js';
import { applicationLogger } from '../utils/logger.js';

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
    customCacheDirectoryPath?: string
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
    applicationLogger.info('Initializing Gmail IMAP Client...');

    this.imapClient = new ImapFlow({
      host: this.imapHost,
      port: this.imapPort,
      secure: true,
      auth: {
        user: this.imapUser,
        pass: this.imapPassword,
      },
      logger: false,
    });

    this.imapClient.on('error', error => {
      applicationLogger.error(`Gmail IMAP Connection Error: ${error.message}`);
    });

    this.imapClient.on('close', () => {
      applicationLogger.warn('Gmail IMAP socket connection closed.');
      if (this.isServiceRunning) {
        applicationLogger.info('Reconnecting Gmail IMAP in 5 seconds...');
        setTimeout(() => {
          if (this.isServiceRunning) {
            this.runMailboxIdleCycle().catch(err => {
              applicationLogger.error(`IMAP Reconnect cycle failed: ${err.message}`);
            });
          }
        }, 5000);
      }
    });

    await this.imapClient.connect();
    applicationLogger.success('Connected to Gmail IMAP successfully.');

    // Run initial scan and enter IDLE loop
    await this.runMailboxIdleCycle();
  }

  /**
   * Opens INBOX, fetches recent messages, and enters the IDLE loop
   */
  private async runMailboxIdleCycle(): Promise<void> {
    if (!this.imapClient || !this.isServiceRunning) {
      return;
    }

    try {
      const mailboxLock = await this.imapClient.getMailboxLock('INBOX');

      try {
        applicationLogger.info('INBOX opened. Scanning recent unseen/new messages...');
        await this.scanRecentMessages();

        // Listen for new messages while mailbox lock is active
        this.imapClient.on('exists', async () => {
          applicationLogger.info('New message notification received via IMAP exists event.');
          await this.scanRecentMessages();
        });

        // Loop IDLE while service is active
        while (this.isServiceRunning && this.imapClient.usable) {
          try {
            await this.imapClient.idle();
          } catch (idleError: unknown) {
            // Idle interrupted or ping timeout, loop will continue if still running
            applicationLogger.fileDetail('debug', 'IMAP idle cycle reset', idleError);
            break;
          }
        }
      } finally {
        mailboxLock.release();
      }
    } catch (cycleError: unknown) {
      applicationLogger.error(`Error in IMAP idle cycle: ${cycleError}`);
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

          // Extract text content (strip heavy tags if html)
          const rawTextContent = parsedMime.text || '';
          const rawHtmlContent = typeof parsedMime.html === 'string' ? parsedMime.html : '';
          const cleanBodyText = rawTextContent || rawHtmlContent.replace(/<[^>]+>/g, ' ');

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
              cleanedBodyText: cleanBodyText.substring(0, 3000), // Trim for prompt efficiency
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
          applicationLogger.error(`Failed to process email UID ${messageUid}: ${individualMessageError}`);
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
    if (this.imapClient) {
      try {
        await this.imapClient.logout();
      } catch {
        this.imapClient.close();
      }
      this.imapClient = null;
    }
    applicationLogger.info('Gmail IMAP listener stopped gracefully.');
  }
}
