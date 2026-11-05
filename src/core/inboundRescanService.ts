import { InboundNotificationStore } from '../gateway/notificationStore.js';
import { NotificationTransactionHandler } from './handlers/inboundHandlers.js';
import { EmailListenerService } from '../email/listener.js';
import { PendingTransactionService } from './pending.js';
import { TransactionCorrelationService } from '../email/correlation.js';
import type { TransactionEvidence } from '../email/types.js';
import { isGenericMerchant, isGenericCategory } from '../email/transactionFusion.js';
import {
  WalletCacheService,
  WalletMcpClientService,
  WalletRecordItem,
  PatchRecordInputPayload,
} from '../wallet/index.js';
import { TransactionMessageStore, EnrichmentPoolService } from '../wallet/records/index.js';
import {
  formatCorrelatedWalletRecordNotification,
  formatRetroactivelyEnrichedWalletRecordNotification,
} from '../wallet/formatters/humanResponseFormatter.js';
import type { InboundRescanResult } from '../wallet/formatters/inboundRescanFormatter.js';
import { MessagingGatewayService } from '../gateway/index.js';
import { applicationLogger } from '../lib/logger.js';

export const MIN_RESCAN_DURATION_MINUTES = 5;
export const MAX_RESCAN_DURATION_MINUTES = 7 * 24 * 60; // 7 days (10080 minutes)
export const DEFAULT_RESCAN_DURATION_MINUTES = 60;

/**
 * Parses user-supplied rescan duration string into minutes.
 * Supports units: m (minutes), h (hours/jam), d (days/hari).
 * Clamps duration between 5 minutes and 7 days.
 */
export function parseRescanDurationMinutes(input?: string): number {
  if (!input || !input.trim()) {
    return DEFAULT_RESCAN_DURATION_MINUTES;
  }

  const trimmed = input.trim().toLowerCase();
  const match = trimmed.match(/^(\d+)(?:\s*(m|min|menit|minutes?|h|hr|jam|hours?|d|hari|days?))?$/i);
  if (!match) {
    return DEFAULT_RESCAN_DURATION_MINUTES;
  }

  const value = Number.parseInt(match[1], 10);
  if (Number.isNaN(value) || value <= 0) {
    return DEFAULT_RESCAN_DURATION_MINUTES;
  }

  const unit = match[2]?.toLowerCase();
  let minutes = value;

  if (unit) {
    if (unit.startsWith('d') || unit.startsWith('hari')) {
      minutes = value * 60 * 24;
    } else if (unit.startsWith('h') || unit.startsWith('jam')) {
      minutes = value * 60;
    }
  }

  return Math.min(Math.max(minutes, MIN_RESCAN_DURATION_MINUTES), MAX_RESCAN_DURATION_MINUTES);
}

export interface InboundRescanServiceDependencies {
  notificationStore: InboundNotificationStore;
  notificationHandler: NotificationTransactionHandler;
  emailListener?: EmailListenerService | null | (() => EmailListenerService | null);
  pendingTransactionManager: PendingTransactionService;
  correlationService: TransactionCorrelationService;
  walletCacheService: WalletCacheService;
  messagingGateway: MessagingGatewayService;
  walletMcpClient?: WalletMcpClientService;
  transactionMessageStore?: TransactionMessageStore;
  enrichmentPoolService?: EnrichmentPoolService;
  defaultCurrency?: string;
}

/**
 * Orchestrates retroactive rescan and replay of inbound financial events:
 * 1. Replays recent push notifications from the persistent InboundNotificationStore.
 * 2. Triggers IMAP email rescan with deduplication cache bypass.
 * 3. Reconciles dangling pending queue tickets against existing Wallet MCP records.
 */
export class InboundRescanService {
  private isRescanRunning = false;

  constructor(private readonly deps: InboundRescanServiceDependencies) {}

  public isRunning(): boolean {
    return this.isRescanRunning;
  }

  public async rescanInbound(durationMinutes: number): Promise<InboundRescanResult> {
    if (this.isRescanRunning) {
      throw new Error('A rescan is already in progress');
    }

    this.isRescanRunning = true;
    const startTime = Date.now();
    const cutoffTimestampMs = startTime - durationMinutes * 60 * 1000;

    let notificationsReplayed = 0;
    let emailsScanned = 0;
    let emailsDetected = 0;
    let reconciledPendingCount = 0;

    applicationLogger.info(
      `[InboundRescan] Starting rescan pass for lookback window: ${durationMinutes} minutes.`
    );

    try {
      // Step 1: Push Notification Replay from persistent store
      const storedNotifications = this.deps.notificationStore.getNotificationsSince(cutoffTimestampMs);
      applicationLogger.info(
        `[InboundRescan] Found ${storedNotifications.length} stored push notification(s) within lookback window.`
      );

      for (const item of storedNotifications) {
        if (item.payload.isTest || item.payload.packageName === 'codes.churma.walletforwarder') {
          continue;
        }

        try {
          await this.deps.notificationHandler.handleNotificationReceived(item.payload, {
            skipStoreRecord: true,
            isReplay: true,
          });
          notificationsReplayed++;
        } catch (notifErr) {
          applicationLogger.warn(
            `[InboundRescan] Failed to replay notification ${item.id}: ${
              notifErr instanceof Error ? notifErr.message : String(notifErr)
            }`
          );
        }
      }

      // Step 2: Email IMAP Rescan with cache bypass
      const emailListener =
        typeof this.deps.emailListener === 'function'
          ? this.deps.emailListener()
          : this.deps.emailListener;

      if (emailListener && emailListener.isConnected()) {
        try {
          applicationLogger.info(
            `[InboundRescan] Triggering IMAP rescan for the last ${durationMinutes} minute(s)...`
          );
          const emailScanResult = await emailListener.rescanMessages(durationMinutes, {
            bypassProcessedCache: true,
          });
          emailsScanned = emailScanResult.scannedUids;
          emailsDetected = emailScanResult.detectedCount;
          applicationLogger.info(
            `[InboundRescan] IMAP rescan finished: ${emailsScanned} scanned, ${emailsDetected} detected.`
          );
        } catch (emailErr) {
          applicationLogger.warn(
            `[InboundRescan] IMAP rescan encountered an error: ${
              emailErr instanceof Error ? emailErr.message : String(emailErr)
            }`
          );
        }
      } else {
        applicationLogger.info('[InboundRescan] IMAP listener not connected or inactive; skipping email scan.');
      }

      // Step 3: Pending Queue Reconciliation against Wallet MCP
      if (this.deps.pendingTransactionManager.hasPendingTransactions() && this.deps.walletMcpClient) {
        try {
          reconciledPendingCount = await this.reconcilePendingQueueAgainstWalletRecords();
        } catch (reconcileErr) {
          applicationLogger.warn(
            `[InboundRescan] Pending queue reconciliation error: ${
              reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr)
            }`
          );
        }
      }

      const elapsed = Date.now() - startTime;
      applicationLogger.info(
        `[InboundRescan] Rescan pass completed in ${elapsed}ms: ` +
          `notifications=${notificationsReplayed}, emails=${emailsScanned} (detected=${emailsDetected}), reconciledPending=${reconciledPendingCount}.`
      );

      return {
        durationMinutes,
        notificationsReplayed,
        emailsScanned,
        emailsDetected,
        reconciledPendingCount,
      };
    } finally {
      this.isRescanRunning = false;
    }
  }

  /**
   * Evaluates all active PENDING items in the queue against recent Wallet MCP records.
   * If a pending transaction corresponds to an existing record, retroactively enriches
   * the Wallet record and dismisses the redundant pending ticket.
   */
  private async reconcilePendingQueueAgainstWalletRecords(): Promise<number> {
    if (!this.deps.walletMcpClient) {
      return 0;
    }

    let recentRecords: WalletRecordItem[] = [];
    try {
      const page = await this.deps.walletMcpClient.fetchRecords({
        limit: 50,
        sort: 'newest',
      });
      recentRecords = page?.records || [];
    } catch (err) {
      applicationLogger.warn(
        `[InboundRescan] Failed to fetch Wallet records for pending reconciliation: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return 0;
    }

    if (recentRecords.length === 0) {
      return 0;
    }

    const poolCandidates = this.deps.enrichmentPoolService?.getAllCandidates() || [];
    const combinedRecords: WalletRecordItem[] = [...recentRecords];
    const existingRecordIds = new Set(recentRecords.map(r => r.id));

    for (const candidate of poolCandidates) {
      if (!existingRecordIds.has(candidate.recordId)) {
        existingRecordIds.add(candidate.recordId);
        combinedRecords.push({
          id: candidate.recordId,
          accountId: candidate.accountId,
          accountName: candidate.accountName,
          amount: candidate.amount,
          currency: candidate.currency || this.deps.defaultCurrency || 'IDR',
          recordDate: candidate.recordDate,
          recordType: candidate.amount < 0 ? 'expense' : 'income',
          counterParty: candidate.counterParty,
          note: candidate.note,
          category: candidate.categoryId
            ? { id: candidate.categoryId, name: candidate.categoryName || '' }
            : undefined,
          labels: candidate.labels?.map(lbl => ({ id: lbl, name: lbl })),
        });
      }
    }

    let reconciledCount = 0;
    const allPending = this.deps.pendingTransactionManager.getAllPendingTransactions();

    for (const item of allPending) {
      const state = this.deps.pendingTransactionManager.getPendingTransactionState(item.ticketId);
      if (state !== 'PENDING') {
        continue;
      }

      const evidence: TransactionEvidence = {
        sourceType: item.sourceType === 'PUSH_NOTIFICATION' ? 'PUSH_NOTIFICATION' : 'EMAIL_BANK',
        sourceId: `pending-${item.ticketId}`,
        amount: item.amount,
        currency: item.currency || this.deps.defaultCurrency || 'IDR',
        occurredAt: item.recordDate,
        merchant: item.counterParty,
        accountHint: item.accountNameHint,
        accountId: item.matchedAccountId,
        categoryId: item.matchedCategoryId,
        categoryName: item.matchedCategoryName,
        note: item.note,
        referenceNumbers: item.referenceNumbers || (item.referenceNumber ? [item.referenceNumber] : []),
        transactionType: item.transactionType,
      };

      const correlationResult = this.deps.correlationService.correlateEvidence(
        evidence,
        [],
        combinedRecords
      );

      if (correlationResult.suggestedAction === 'ATTACH_WALLET_RECORD') {
        const matchedRecord = (
          correlationResult.matchTarget as { type: 'WALLET_RECORD'; record: WalletRecordItem }
        ).record;

        applicationLogger.info(
          `[InboundRescan] Matched pending ticket #${item.ticketId} with Wallet record ${matchedRecord.id}.`
        );

        const poolCandidate = this.deps.enrichmentPoolService?.getCandidate(matchedRecord.id);
        const categories = this.deps.walletCacheService.getCategories();

        let incomingCategoryId = evidence.categoryId;
        let incomingCategoryName = evidence.categoryName;
        if (!incomingCategoryId && incomingCategoryName) {
          const matchedCat = categories.find(
            c => c.name.toLowerCase() === incomingCategoryName!.toLowerCase()
          );
          if (matchedCat) {
            incomingCategoryId = matchedCat.id;
            incomingCategoryName = matchedCat.name;
          }
        }

        const currentCategoryName = matchedRecord.category?.name || poolCandidate?.categoryName;
        const hasGenericCategory = !currentCategoryName || isGenericCategory(currentCategoryName);
        const incomingHasSpecificCategory = Boolean(
          incomingCategoryName && !isGenericCategory(incomingCategoryName)
        );
        const shouldPatchCategory = hasGenericCategory && incomingHasSpecificCategory && Boolean(incomingCategoryId);

        const currentMerchant = matchedRecord.counterParty || poolCandidate?.counterParty;
        const hasGenericMerchant = !currentMerchant || isGenericMerchant(currentMerchant);
        const incomingHasSpecificMerchant = Boolean(
          evidence.merchant && !isGenericMerchant(evidence.merchant)
        );
        const shouldPatchMerchant = hasGenericMerchant && incomingHasSpecificMerchant;

        const currentNote = matchedRecord.note || poolCandidate?.note || '';
        const noteLower = currentNote.trim().toLowerCase();
        const isBoilerplateNote =
          !noteLower ||
          noteLower === 'pembayaran qris' ||
          noteLower.startsWith('pembayaran kartu debit') ||
          noteLower === 'transaksi' ||
          noteLower === (currentMerchant || '').trim().toLowerCase();
        const incomingNote =
          evidence.note && evidence.note !== item.referenceNumber ? evidence.note : undefined;
        const shouldPatchNote = isBoilerplateNote && Boolean(incomingNote && incomingNote !== currentNote);

        const hasCoreEnrichment = shouldPatchMerchant || shouldPatchCategory || shouldPatchNote;

        if (hasCoreEnrichment) {
          try {
            const patchPayload: PatchRecordInputPayload = {
              id: matchedRecord.id,
            };
            if (shouldPatchMerchant && evidence.merchant) {
              patchPayload.counterParty = evidence.merchant;
            }
            if (shouldPatchCategory && incomingCategoryId) {
              patchPayload.categoryId = incomingCategoryId;
            }
            if (shouldPatchNote && incomingNote) {
              patchPayload.note = incomingNote;
            }

            await this.deps.walletMcpClient.patchRecords([patchPayload]);
            applicationLogger.success(
              `[InboundRescan] Successfully enriched Wallet MCP record ${matchedRecord.id} from ticket #${item.ticketId}.`
            );

            this.deps.enrichmentPoolService?.removeCandidate(matchedRecord.id);

            if (this.deps.transactionMessageStore) {
              this.deps.transactionMessageStore.updateMessageMappingsByRecordId(matchedRecord.id, {
                ...(patchPayload.counterParty ? { counterParty: patchPayload.counterParty } : {}),
                ...(patchPayload.categoryId
                  ? { categoryId: patchPayload.categoryId, categoryName: incomingCategoryName }
                  : {}),
                ...(patchPayload.note ? { note: patchPayload.note } : {}),
              });
            }

            const enrichedNotif = formatRetroactivelyEnrichedWalletRecordNotification({
              recordId: matchedRecord.id,
              merchant:
                patchPayload.counterParty ||
                matchedRecord.counterParty ||
                evidence.merchant ||
                'Transaksi',
              amount: evidence.amount,
              currency: evidence.currency,
              categoryName: incomingCategoryName || currentCategoryName,
              accountName:
                matchedRecord.accountName ||
                poolCandidate?.accountName ||
                item.accountNameHint ||
                'Wallet',
              note: patchPayload.note || matchedRecord.note || poolCandidate?.note,
            });

            await this.deps.messagingGateway.broadcastNotification(enrichedNotif);
          } catch (patchErr) {
            applicationLogger.warn(
              `[InboundRescan] Failed to patch record ${matchedRecord.id}: ${
                patchErr instanceof Error ? patchErr.message : String(patchErr)
              }`
            );
          }
        } else {
          const notif = formatCorrelatedWalletRecordNotification(
            matchedRecord.id,
            evidence.merchant || matchedRecord.counterParty || 'Transaksi',
            evidence.amount,
            evidence.currency
          );
          await this.deps.messagingGateway.broadcastNotification(notif);
        }

        // Dismiss the superseded pending ticket
        this.deps.pendingTransactionManager.rejectPendingTransaction(item.ticketId);
        reconciledCount++;
      }
    }

    return reconciledCount;
  }
}
