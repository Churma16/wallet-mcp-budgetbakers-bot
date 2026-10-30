import { FinancialAiProvider } from '../brain/index.js';
import { PendingTransactionService } from '../services/pendingTransactionService.js';
import { MessagingGatewayService } from '../services/messaging/index.js';
import { TransactionCorrelationService } from '../services/transactionCorrelationService.js';
import { TransactionEvidence } from '../types/transactionCorrelationTypes.js';
import { WalletCacheService, WalletMcpClientService, WalletRecordItem } from '../wallet/index.js';
import { PushNotificationPayload } from '../services/webhook/types.js';
import { evaluateNotificationThroughGate } from '../config/notificationRules.js';
import {
  formatPendingEmailTransactionNotification,
  formatEnrichedPendingEmailTransactionNotification,
  formatCorrelatedWalletRecordNotification,
} from '../utils/humanResponseFormatter.js';
import { applicationLogger } from '../utils/logger.js';

export class NotificationTransactionHandler {
  constructor(
    private readonly financialAiProvider: FinancialAiProvider,
    private readonly walletCacheService: WalletCacheService,
    private readonly pendingTransactionManager: PendingTransactionService,
    private readonly messagingGateway: MessagingGatewayService,
    private readonly defaultCurrency: string = 'IDR',
    private readonly correlationService: TransactionCorrelationService = new TransactionCorrelationService(),
    private readonly walletMcpClient?: WalletMcpClientService
  ) {}

  /**
   * Processes an incoming Android push notification payload from the webhook receiver.
   * Runs Gate 1 evaluation, AI extraction, and multi-source correlation.
   */
  public async handleNotificationReceived(payload: PushNotificationPayload): Promise<void> {
    applicationLogger.info(`[NotificationWebhook] Processing notification from package: ${payload.packageName}`);
    applicationLogger.fileDetail('notification', 'Detected Push Notification Candidate', {
      packageName: payload.packageName,
      title: payload.title,
      text: payload.text,
      timestamp: payload.timestamp,
    });

    // 1. Gate 1: Rule & Package Evaluation
    const gateResult = evaluateNotificationThroughGate(payload);
    if (!gateResult.passed) {
      applicationLogger.info(`[Gate 1 Skip] Push notification rejected: ${gateResult.reason}`);
      return;
    }

    applicationLogger.info(`[Gate 1 Passed] Matched package rule: ${gateResult.matchedBankRule?.displayName || payload.packageName}`);

    const cachedAccounts = this.walletCacheService.getAccounts();
    const cachedCategories = this.walletCacheService.getCategories();

    const notificationDate = gateResult.originalDate || (payload.timestamp ? new Date(payload.timestamp) : new Date());

    // 2. Gate 2: AI extraction using the financial provider
    const parsedData = await this.financialAiProvider.processEmailTransactionMessage(
      gateResult,
      payload.title,
      payload.packageName,
      payload.text,
      notificationDate,
      cachedAccounts,
      cachedCategories
    );

    if (!parsedData.isTransaction) {
      applicationLogger.info('[Gate 2 Filtered Out] AI classified notification candidate as non-transaction.');
      applicationLogger.fileDetail('ai', 'Gate 2 Filtered Notification Candidate', {
        explanation: parsedData.explanation,
      });
      return;
    }

    // 3. Resolve accounts
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
      const candidateDestAccount = cachedAccounts.find(
        acc =>
          acc.name.toLowerCase() ===
          parsedData.destinationAccountNameHint?.toLowerCase()
      );
      if (candidateDestAccount) {
        resolvedDestinationAccountId = candidateDestAccount.id;
        resolvedDestinationAccountName = candidateDestAccount.name;
      }
    }

    const resolvedCurrency = this.defaultCurrency;

    // 4. Build Transaction Evidence for Correlation
    const extractedRefs: string[] = [];
    if (parsedData.referenceNumber) {
      extractedRefs.push(parsedData.referenceNumber);
    }
    if (gateResult.referenceNumber && !extractedRefs.includes(gateResult.referenceNumber)) {
      extractedRefs.push(gateResult.referenceNumber);
    }

    const matchedAccountItem = cachedAccounts.find(acc => acc.id === resolvedAccountId);

    const incomingEvidence: TransactionEvidence = {
      sourceType: 'PUSH_NOTIFICATION',
      sourceId: `${payload.packageName}:${payload.timestamp || Date.now()}`,
      amount: parsedData.amount,
      currency: resolvedCurrency,
      occurredAt: parsedData.recordDate || notificationDate.toISOString(),
      merchant: parsedData.counterParty,
      accountHint: resolvedAccountName,
      accountId: resolvedAccountId,
      destinationAccountHint: resolvedDestinationAccountName,
      destinationAccountId: resolvedDestinationAccountId,
      referenceNumbers: extractedRefs,
      note: parsedData.note || payload.text,
      categoryId: parsedData.matchedCategoryId,
      categoryName: parsedData.matchedCategoryName,
      transactionType: parsedData.transactionType,
      isBankSyncedAccount: Boolean(matchedAccountItem?.isBankSynced),
      rawPayload: {
        packageName: payload.packageName,
        title: payload.title,
        text: payload.text,
      },
    };

    // 5. Fetch recent native Wallet records for correlation
    let recentWalletRecords: WalletRecordItem[] = [];
    if (this.walletMcpClient) {
      try {
        const page = await this.walletMcpClient.fetchRecords({
          limit: 10,
          sort: 'newest',
        });
        recentWalletRecords = page?.records || [];
      } catch (err: any) {
        applicationLogger.warn(
          `Failed to fetch recent Wallet records for correlation: ${err?.message || err}`
        );
      }
    }

    // 6. Correlate Evidence against Pending Candidates & Wallet Records
    const pendingCandidates = this.pendingTransactionManager.getAllPendingTransactions();
    const correlationResult = this.correlationService.correlateEvidence(
      incomingEvidence,
      pendingCandidates,
      recentWalletRecords
    );

    // Case 1: Correlates with existing Wallet record (deduplicate)
    if (correlationResult.suggestedAction === 'ATTACH_WALLET_RECORD') {
      const matchedRecord = (correlationResult.matchTarget as { type: 'WALLET_RECORD'; record: any }).record;
      applicationLogger.info(
        `[Correlation Matched Wallet Record] Push notification matches existing Wallet record (${matchedRecord.id}). Skipping duplicate candidate.`
      );

      const notif = formatCorrelatedWalletRecordNotification(
        matchedRecord.id,
        incomingEvidence.merchant || matchedRecord.counterParty || 'Transaksi',
        incomingEvidence.amount,
        incomingEvidence.currency
      );
      await this.messagingGateway.broadcastNotification(notif);
      return;
    }

    // Case 2: Correlates with an existing pending candidate (field fusion)
    if (correlationResult.suggestedAction === 'MERGE_PENDING') {
      const existingPending = (
        correlationResult.matchTarget as { type: 'PENDING_TRANSACTION'; pendingItem: any }
      ).pendingItem;

      applicationLogger.info(
        `[Correlation Fused Pending] Correlated push notification with pending ticket #${existingPending.ticketId}. Merging evidence.`
      );

      const enrichedItem = this.pendingTransactionManager.enrichPendingTransaction(
        existingPending.ticketId,
        correlationResult.fusedPendingItem || {}
      );

      if (enrichedItem) {
        const totalPendingCount = this.pendingTransactionManager.getAllPendingTransactions().length;
        const notificationText = formatEnrichedPendingEmailTransactionNotification(
          enrichedItem,
          totalPendingCount,
          gateResult.matchedBankRule?.displayName || payload.packageName
        );
        await this.messagingGateway.broadcastNotification(notificationText);
        applicationLogger.success(
          `Dispatched enriched transaction notification (#${enrichedItem.ticketId}) to active messaging channels.`
        );
      }
      return;
    }

    // Case 3: Independent candidate
    let initialNote = parsedData.note || payload.title || payload.text;
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

    const pendingItem = this.pendingTransactionManager.addPendingTransaction({
      sourceType: 'PUSH_NOTIFICATION',
      bankDisplayName: gateResult.matchedBankRule?.displayName || 'Push Notif',
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
      recordDate: parsedData.recordDate || notificationDate.toISOString(),
      referenceNumber: extractedRefs[0],
      referenceNumbers: extractedRefs,
      evidenceSources: [incomingEvidence.sourceType],
      isBankSyncedAccount: incomingEvidence.isBankSyncedAccount,
      clarificationPrompt: isClarification ? correlationResult.clarificationPrompt : undefined,
    });

    const totalPendingCount = this.pendingTransactionManager.getAllPendingTransactions().length;
    let notificationText = formatPendingEmailTransactionNotification(pendingItem, totalPendingCount);

    if (isClarification && correlationResult.clarificationPrompt) {
      notificationText = `⚠️ *Perlu Klarifikasi*\n${correlationResult.clarificationPrompt}\n\n${notificationText}`;
    }

    await this.messagingGateway.broadcastNotification(notificationText);
    applicationLogger.success(
      `Dispatched pending transaction notification (#${pendingItem.ticketId}) to active messaging channels.`
    );
  }
}
