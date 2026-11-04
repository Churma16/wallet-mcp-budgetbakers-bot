import { ExtractedEmailTransactionData } from '../brain/types.js';
import { GateEvaluationResult } from '../email/index.js';
import { PendingTransactionService, buildRecordsForPendingItem } from './pending.js';
import { MessagingGatewayService } from '../gateway/index.js';
import { TransactionCorrelationService, TransactionEvidence, TransactionEvidenceSource } from '../email/index.js';
import { WalletCacheService, WalletMcpClientService, WalletRecordItem } from '../wallet/index.js';
import {
  formatPendingEmailTransactionNotification,
  formatEnrichedPendingEmailTransactionNotification,
  formatCorrelatedWalletRecordNotification,
  formatPendingConfirmationSuccess,
} from '../wallet/formatters/humanResponseFormatter.js';
import { TransactionMessageStore } from '../wallet/records/index.js';
import { RuntimeSettingsManager } from '../config/runtimeSettingsManager.js';
import { applicationLogger } from '../lib/logger.js';

export interface InboundTransactionCandidateContext {
  parsedData: ExtractedEmailTransactionData;
  gateResult: GateEvaluationResult;
  sourceType: 'EMAIL' | 'PUSH_NOTIFICATION';
  evidenceSourceType: TransactionEvidenceSource;
  sourceId: string;
  sourceDate: Date;
  sourceDisplayName: string;
  fallbackNote: string;
  onRecordProcessed?: (reference: string) => void;
}

export interface InboundTransactionCoordinatorDependencies {
  walletCacheService: WalletCacheService;
  pendingTransactionManager: PendingTransactionService;
  messagingGateway: MessagingGatewayService;
  defaultCurrency: string;
  correlationService: TransactionCorrelationService;
  walletMcpClient?: WalletMcpClientService;
  transactionMessageStore?: TransactionMessageStore;
  runtimeSettingsManager?: RuntimeSettingsManager;
}

/**
 * Correlates and stages inbound transaction candidates (from Email IMAP or Push Webhook)
 * against active pending queues and upstream Wallet records.
 */
export async function coordinateInboundTransactionCandidate(
  context: InboundTransactionCandidateContext,
  deps: InboundTransactionCoordinatorDependencies
): Promise<void> {
  const {
    parsedData,
    gateResult,
    sourceType,
    evidenceSourceType,
    sourceId,
    sourceDate,
    sourceDisplayName,
    fallbackNote,
    onRecordProcessed,
  } = context;

  const {
    walletCacheService,
    pendingTransactionManager,
    messagingGateway,
    defaultCurrency,
    correlationService,
    walletMcpClient,
  } = deps;

  const cachedAccounts = walletCacheService.getAccounts();

  // 1. Resolve accounts
  let resolvedAccountId = parsedData.matchedAccountId;
  let resolvedAccountName = parsedData.accountNameHint;
  if (!resolvedAccountId) {
    const defaultAccount = cachedAccounts[0];
    resolvedAccountId = defaultAccount?.id || '';
    resolvedAccountName = defaultAccount?.name || 'Cash';
  }

  let resolvedDestinationAccountId = parsedData.matchedDestinationAccountId;
  let resolvedDestinationAccountName = parsedData.destinationAccountNameHint;
  if (
    parsedData.transactionType === 'TRANSFER' &&
    !resolvedDestinationAccountId &&
    parsedData.destinationAccountNameHint
  ) {
    const matchedDestinationAccount = cachedAccounts.find(account =>
      account.name.toLowerCase().includes(parsedData.destinationAccountNameHint!.toLowerCase())
    );
    if (matchedDestinationAccount) {
      resolvedDestinationAccountId = matchedDestinationAccount.id;
      resolvedDestinationAccountName = matchedDestinationAccount.name;
    }
  }

  const matchedAccountItem = cachedAccounts.find(account => account.id === resolvedAccountId);
  const resolvedCurrency = matchedAccountItem?.currency || defaultCurrency;

  const extractedRefs = Array.from(
    new Set([
      ...(parsedData.referenceNumber ? [parsedData.referenceNumber] : []),
      ...(gateResult.referenceNumber ? [gateResult.referenceNumber] : []),
    ])
  ).filter(Boolean);

  const incomingEvidence: TransactionEvidence = {
    sourceType: evidenceSourceType,
    sourceId,
    amount: parsedData.amount,
    currency: resolvedCurrency,
    occurredAt: parsedData.recordDate || sourceDate.toISOString(),
    merchant: parsedData.counterParty || gateResult.matchedBankRule?.displayName,
    accountHint: resolvedAccountName,
    accountId: resolvedAccountId,
    destinationAccountHint: resolvedDestinationAccountName,
    destinationAccountId: resolvedDestinationAccountId,
    referenceNumbers: extractedRefs,
    note: parsedData.note || fallbackNote,
    categoryId: parsedData.matchedCategoryId,
    categoryName: parsedData.matchedCategoryName,
    transactionType: parsedData.transactionType,
    isBankSyncedAccount: Boolean(matchedAccountItem?.isBankSynced),
  };

  // 2. Query recent Wallet records if MCP client is provided
  let recentRecords: WalletRecordItem[] = [];
  if (walletMcpClient) {
    try {
      const page = await walletMcpClient.fetchRecords({
        limit: 10,
        sort: 'newest',
      });
      recentRecords = page?.records || [];
    } catch (fetchRecordsError) {
      applicationLogger.warn(
        `Failed to fetch recent Wallet records for correlation: ${
          fetchRecordsError instanceof Error ? fetchRecordsError.message : String(fetchRecordsError)
        }`
      );
    }
  }

  const correlationResult = correlationService.correlateEvidence(
    incomingEvidence,
    pendingTransactionManager.getAllPendingTransactions(),
    recentRecords
  );

  // Case 1: Correlates with existing native Wallet record (bank sync or manual write)
  if (correlationResult.suggestedAction === 'ATTACH_WALLET_RECORD') {
    const matchedRecord = (correlationResult.matchTarget as { type: 'WALLET_RECORD'; record: any }).record;
    applicationLogger.info(
      `[Correlation Matched Wallet Record] ${sourceType} matches existing Wallet record (${matchedRecord.id}). Skipping duplicate candidate.`
    );

    if (onRecordProcessed) {
      for (const ref of extractedRefs) {
        onRecordProcessed(ref);
      }
    }

    const notif = formatCorrelatedWalletRecordNotification(
      matchedRecord.id,
      incomingEvidence.merchant || matchedRecord.counterParty || 'Transaksi',
      incomingEvidence.amount,
      incomingEvidence.currency
    );
    await messagingGateway.broadcastNotification(notif);
    return;
  }

  // Case 1.5: Correlates with an existing unlinked record as a paired transfer counterpart
  if (correlationResult.suggestedAction === 'PAIR_TRANSFER_EXISTING') {
    const matchedRecord = (correlationResult.matchTarget as { type: 'WALLET_RECORD'; record: any }).record;
    applicationLogger.info(
      `[Correlation Paired Transfer] ${sourceType} correlates with existing unlinked Wallet record (${matchedRecord.id}). Proposing transfer binding via pairingMode: 'existing'.`
    );
  }

  // Case 2: Correlates with an existing pending candidate (field fusion)
  if (correlationResult.suggestedAction === 'MERGE_PENDING') {
    const existingPending = (
      correlationResult.matchTarget as { type: 'PENDING_TRANSACTION'; pendingItem: any }
    ).pendingItem;

    applicationLogger.info(
      `[Correlation Fused Pending] Correlated ${sourceType} with pending ticket #${existingPending.ticketId}. Merging evidence.`
    );

    // Guard: Check if ticket is still active pending (not already confirmed, cancelled, or resolving)
    const currentPending = pendingTransactionManager.getPendingTransaction(existingPending.ticketId);
    const isProcessing =
      typeof pendingTransactionManager.isTicketProcessing === 'function' &&
      pendingTransactionManager.isTicketProcessing(existingPending.ticketId);

    if (!currentPending || isProcessing) {
      applicationLogger.info(
        `[Correlation Fused Pending] Ticket #${existingPending.ticketId} is no longer active pending (processing or resolved). Skipping edit.`
      );
      if (onRecordProcessed) {
        for (const ref of extractedRefs) {
          onRecordProcessed(ref);
        }
      }
      return;
    }

    const enrichedItem = pendingTransactionManager.enrichPendingTransaction(
      existingPending.ticketId,
      correlationResult.fusedPendingItem || {}
    );

    if (onRecordProcessed) {
      for (const ref of extractedRefs) {
        onRecordProcessed(ref);
      }
    }

    if (enrichedItem) {
      const activeSettings = (deps.runtimeSettingsManager || RuntimeSettingsManager.getInstance()).getSettings();
      const isAutoRecordEnriched = Boolean(activeSettings.autoRecordEnriched);

      const hasValidAccount = Boolean(
        enrichedItem.matchedAccountId &&
        (cachedAccounts.length === 0 || cachedAccounts.some(acc => acc.id === enrichedItem.matchedAccountId))
      );

      const categories = walletCacheService.getCategories();
      const resolvedCategory = enrichedItem.matchedCategoryId
        ? categories.find(c => c.id === enrichedItem.matchedCategoryId)
        : (enrichedItem.matchedCategoryName
            ? categories.find(c => c.name.toLowerCase() === enrichedItem.matchedCategoryName?.trim().toLowerCase())
            : undefined);

      const hasValidCategory = Boolean(
        (resolvedCategory &&
          resolvedCategory.isAssignable !== false &&
          resolvedCategory.group?.id !== 'system_categories' &&
          enrichedItem.matchedCategoryName !== 'Unknown') ||
        (!resolvedCategory &&
          categories.length === 0 &&
          enrichedItem.matchedCategoryName &&
          enrichedItem.matchedCategoryName !== 'Unknown')
      );

      const isTransferEligible =
        enrichedItem.transactionType !== 'TRANSFER' ||
        Boolean(enrichedItem.transfer?.pairingMode === 'existing' || enrichedItem.matchedDestinationAccountId);

      const isEligibleForAutoRecord =
        isAutoRecordEnriched &&
        Boolean(walletMcpClient) &&
        hasValidAccount &&
        hasValidCategory &&
        enrichedItem.amount !== 0 &&
        isTransferEligible;

      if (isEligibleForAutoRecord && walletMcpClient) {
        try {
          applicationLogger.mcp(
            `[Auto-Record Enriched] Ticket #${enrichedItem.ticketId} qualifies for immediate dispatch. Recording to Wallet MCP...`
          );

          if (resolvedCategory && !enrichedItem.matchedCategoryId) {
            enrichedItem.matchedCategoryId = resolvedCategory.id;
          }

          const recordsToCreate = buildRecordsForPendingItem(enrichedItem, walletCacheService);
          const createResult = await walletMcpClient.createRecords(recordsToCreate);
          const createdId = createResult?.results?.[0]?.id;

          pendingTransactionManager.resolvePendingTransaction(enrichedItem.ticketId);
          applicationLogger.success(
            `[Auto-Record Enriched] Ticket #${enrichedItem.ticketId} successfully recorded to Wallet MCP (recordId=${createdId || 'n/a'}).`
          );

          if (onRecordProcessed) {
            const allRefs = [
              ...(enrichedItem.referenceNumbers || []),
              ...(enrichedItem.referenceNumber ? [enrichedItem.referenceNumber] : []),
            ];
            for (const ref of allRefs) {
              onRecordProcessed(ref);
            }
          }

          const successNotification = formatPendingConfirmationSuccess(enrichedItem);
          let wasEdited = false;
          if (
            enrichedItem.notificationMessageIds &&
            Object.keys(enrichedItem.notificationMessageIds).length > 0 &&
            typeof messagingGateway.editBroadcastNotification === 'function'
          ) {
            wasEdited = await messagingGateway.editBroadcastNotification(
              enrichedItem.notificationMessageIds,
              successNotification
            );
          }

          let finalReceipts: Record<string, any> = {};
          if (wasEdited && enrichedItem.notificationMessageIds) {
            for (const [channel, messageId] of Object.entries(enrichedItem.notificationMessageIds)) {
              finalReceipts[channel] = { messageId };
            }
          } else {
            finalReceipts = (await messagingGateway.broadcastNotification(successNotification)) || {};
          }

          if (deps.transactionMessageStore && createdId) {
            for (const [channel, receipt] of Object.entries(finalReceipts)) {
              const messageId =
                typeof receipt === 'object' && receipt !== null && 'messageId' in receipt
                  ? String(receipt.messageId)
                  : typeof receipt === 'string'
                    ? receipt
                    : undefined;

              if (messageId) {
                deps.transactionMessageStore.recordMessageMapping(messageId, {
                  recordId: createdId,
                  accountId: enrichedItem.matchedAccountId,
                  accountName: enrichedItem.bankDisplayName || enrichedItem.accountNameHint,
                  currency: enrichedItem.currency,
                  recordDate: enrichedItem.recordDate,
                  note: enrichedItem.note,
                  categoryId: enrichedItem.matchedCategoryId,
                  categoryName: enrichedItem.matchedCategoryName,
                  labels: enrichedItem.labels,
                  amount: enrichedItem.amount,
                  counterParty: enrichedItem.counterParty,
                  channel,
                  isTransfer: enrichedItem.transactionType === 'TRANSFER',
                });
              }
            }
          }

          return;
        } catch (autoRecordError) {
          applicationLogger.error(
            `[Auto-Record Error] Ticket #${enrichedItem.ticketId} auto-record failed: ${
              autoRecordError instanceof Error ? autoRecordError.message : String(autoRecordError)
            }. Retaining in pending queue.`
          );
        }
      }

      const totalPendingCount = pendingTransactionManager.getAllPendingTransactions().length;
      const notificationText = formatEnrichedPendingEmailTransactionNotification(
        enrichedItem,
        totalPendingCount,
        sourceDisplayName
      );

      let wasEdited = false;
      if (
        enrichedItem.notificationMessageIds &&
        Object.keys(enrichedItem.notificationMessageIds).length > 0 &&
        typeof messagingGateway.editBroadcastNotification === 'function'
      ) {
        wasEdited = await messagingGateway.editBroadcastNotification(
          enrichedItem.notificationMessageIds,
          notificationText
        );
      }

      if (!wasEdited) {
        await messagingGateway.broadcastNotification(notificationText);
        applicationLogger.success(
          `Dispatched enriched transaction notification (#${enrichedItem.ticketId}) to active messaging channels.`
        );
      } else {
        applicationLogger.success(
          `Successfully updated in-place notification bubble for enriched transaction (#${enrichedItem.ticketId}).`
        );
      }
    }
    return;
  }

  // Case 3: Independent candidate (LOW confidence or CLARIFY)
  let initialNote = parsedData.note || fallbackNote;
  const isClarification =
    correlationResult.suggestedAction === 'CLARIFY' &&
    Boolean(correlationResult.clarificationPrompt);
  const clarifyTargetTicketId =
    correlationResult.matchTarget.type === 'PENDING_TRANSACTION'
      ? correlationResult.matchTarget.pendingItem.ticketId
      : undefined;

  if (isClarification) {
    initialNote = clarifyTargetTicketId
      ? `[Klarifikasi: #${clarifyTargetTicketId}] ${initialNote}`
      : `[Klarifikasi] ${initialNote}`;
  }

  const matchedTransferRecord =
    correlationResult.suggestedAction === 'PAIR_TRANSFER_EXISTING' &&
    correlationResult.matchTarget.type === 'WALLET_RECORD'
      ? correlationResult.matchTarget.record
      : undefined;

  const resolvedTransferDestinationAccountName = matchedTransferRecord
    ? matchedTransferRecord.accountName ||
      cachedAccounts.find(account => account.id === matchedTransferRecord.accountId)?.name ||
      resolvedDestinationAccountName
    : resolvedDestinationAccountName;

  const pendingItem = pendingTransactionManager.addPendingTransaction({
    sourceType,
    bankDisplayName: gateResult.matchedBankRule?.displayName || sourceDisplayName,
    accountNameHint: resolvedAccountName,
    matchedAccountId: resolvedAccountId,
    destinationAccountNameHint: resolvedTransferDestinationAccountName,
    counterParty: parsedData.counterParty || '',
    amount: parsedData.amount,
    currency: resolvedCurrency,
    transactionType: matchedTransferRecord ? 'TRANSFER' : parsedData.transactionType,
    matchedDestinationAccountId: matchedTransferRecord
      ? matchedTransferRecord.accountId
      : resolvedDestinationAccountId,
    transfer: correlationResult.proposedTransfer || (matchedTransferRecord
      ? { pairingMode: 'existing', recordId: matchedTransferRecord.id, accountId: matchedTransferRecord.accountId }
      : undefined),
    matchedCategoryId: parsedData.matchedCategoryId,
    matchedCategoryName: parsedData.matchedCategoryName,
    note: initialNote,
    recordDate: parsedData.recordDate || sourceDate.toISOString(),
    referenceNumber: extractedRefs[0],
    referenceNumbers: extractedRefs,
    evidenceSources: [incomingEvidence.sourceType],
    emailSubject: sourceType === 'EMAIL' ? fallbackNote : undefined,
    isBankSyncedAccount: incomingEvidence.isBankSyncedAccount,
    clarificationPrompt: isClarification ? correlationResult.clarificationPrompt : undefined,
  });

  const totalPendingCount = pendingTransactionManager.getAllPendingTransactions().length;
  let notificationText = formatPendingEmailTransactionNotification(pendingItem, totalPendingCount);

  if (isClarification && correlationResult.clarificationPrompt) {
    notificationText = `⚠️ *Perlu Klarifikasi*\n${correlationResult.clarificationPrompt}\n\n${notificationText}`;
  }

  const receipts = await messagingGateway.broadcastNotification(notificationText);
  if (
    receipts &&
    typeof receipts === 'object' &&
    Object.keys(receipts).length > 0 &&
    typeof pendingTransactionManager.updateNotificationMessageIds === 'function'
  ) {
    pendingTransactionManager.updateNotificationMessageIds(pendingItem.ticketId, receipts);
  }

  applicationLogger.success(
    `Dispatched pending transaction notification (#${pendingItem.ticketId}) to active messaging channels.`
  );
}
