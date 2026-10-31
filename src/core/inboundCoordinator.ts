import { ExtractedEmailTransactionData } from '../brain/types.js';
import { GateEvaluationResult } from '../email/index.js';
import { PendingTransactionService } from './pending.js';
import { MessagingGatewayService } from '../gateway/index.js';
import { TransactionCorrelationService, TransactionEvidence, TransactionEvidenceSource } from '../email/index.js';
import { WalletCacheService, WalletMcpClientService, WalletRecordItem } from '../wallet/index.js';
import {
  formatPendingEmailTransactionNotification,
  formatEnrichedPendingEmailTransactionNotification,
  formatCorrelatedWalletRecordNotification,
} from '../wallet/humanResponseFormatter.js';
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

  // Case 2: Correlates with an existing pending candidate (field fusion)
  if (correlationResult.suggestedAction === 'MERGE_PENDING') {
    const existingPending = (
      correlationResult.matchTarget as { type: 'PENDING_TRANSACTION'; pendingItem: any }
    ).pendingItem;

    applicationLogger.info(
      `[Correlation Fused Pending] Correlated ${sourceType} with pending ticket #${existingPending.ticketId}. Merging evidence.`
    );

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
      const totalPendingCount = pendingTransactionManager.getAllPendingTransactions().length;
      const notificationText = formatEnrichedPendingEmailTransactionNotification(
        enrichedItem,
        totalPendingCount,
        sourceDisplayName
      );
      await messagingGateway.broadcastNotification(notificationText);
      applicationLogger.success(
        `Dispatched enriched transaction notification (#${enrichedItem.ticketId}) to active messaging channels.`
      );
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

  const pendingItem = pendingTransactionManager.addPendingTransaction({
    sourceType,
    bankDisplayName: gateResult.matchedBankRule?.displayName || sourceDisplayName,
    accountNameHint: resolvedAccountName,
    matchedAccountId: resolvedAccountId,
    destinationAccountNameHint: resolvedDestinationAccountName,
    matchedDestinationAccountId: resolvedDestinationAccountId,
    counterParty: parsedData.counterParty || '',
    amount: parsedData.amount,
    currency: resolvedCurrency,
    transactionType: parsedData.transactionType,
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

  await messagingGateway.broadcastNotification(notificationText);
  applicationLogger.success(
    `Dispatched pending transaction notification (#${pendingItem.ticketId}) to active messaging channels.`
  );
}
