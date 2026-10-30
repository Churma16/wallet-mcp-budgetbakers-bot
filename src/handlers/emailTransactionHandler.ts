import { EmailTransactionDetectedEvent, EmailListenerService } from '../services/emailListenerService.js';
import { FinancialAiProvider } from '../services/ai/index.js';
import { PendingTransactionService } from '../services/pendingTransactionService.js';
import { MessagingGatewayService } from '../services/messaging/index.js';
import { TransactionCorrelationService } from '../services/transactionCorrelationService.js';
import { TransactionEvidence } from '../types/transactionCorrelationTypes.js';
import { WalletCacheService, WalletMcpClientService, WalletRecordItem } from '../wallet/index.js';
import {
  formatPendingEmailTransactionNotification,
  formatEnrichedPendingEmailTransactionNotification,
  formatCorrelatedWalletRecordNotification,
} from '../utils/humanResponseFormatter.js';
import { applicationLogger } from '../utils/logger.js';

export class EmailTransactionHandler {
  constructor(
    private readonly financialAiProvider: FinancialAiProvider,
    private readonly walletCacheService: WalletCacheService,
    private readonly pendingTransactionManager: PendingTransactionService,
    private readonly messagingGateway: MessagingGatewayService,
    private readonly defaultCurrency: string = 'IDR',
    private readonly correlationService: TransactionCorrelationService = new TransactionCorrelationService(),
    private readonly emailListenerServiceGetter?: () => EmailListenerService | null,
    private readonly walletMcpClient?: WalletMcpClientService
  ) {}

  /**
   * Processes a bank or payment notification email detected by the IMAP listener service.
   * Performs multi-source correlation against existing pending candidates and native Wallet records.
   */
  public async handleEmailTransactionDetected(detectedEvent: EmailTransactionDetectedEvent): Promise<void> {
    applicationLogger.info('Processing detected email transaction candidate.');
    applicationLogger.fileDetail('email', 'Detected Email Transaction Candidate', {
      emailSubject: detectedEvent.emailSubject,
      emailSender: detectedEvent.emailSender,
      gateResult: detectedEvent.gateResult,
    });

    const cachedAccounts = this.walletCacheService.getAccounts();
    const cachedCategories = this.walletCacheService.getCategories();

    const parsedData = await this.financialAiProvider.processEmailTransactionMessage(
      detectedEvent.gateResult,
      detectedEvent.emailSubject,
      detectedEvent.emailSender,
      detectedEvent.cleanedBodyText,
      detectedEvent.emailDate,
      cachedAccounts,
      cachedCategories
    );

    if (!parsedData.isTransaction) {
      applicationLogger.info('[Gate 2 Filtered Out] AI classified candidate as non-transaction.');
      applicationLogger.fileDetail('ai', 'Gate 2 Filtered Email Candidate', {
        explanation: parsedData.explanation,
      });
      return;
    }

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
    const resolvedCurrency = matchedAccountItem?.currency || this.defaultCurrency;

    const ruleCategory = detectedEvent.gateResult.matchedBankRule?.ruleCategory;
    const evidenceSourceType =
      ruleCategory === 'MERCHANT_RECEIPT'
        ? 'EMAIL_PAYMENT'
        : 'EMAIL_BANK';

    const extractedRefs = Array.from(
      new Set([
        ...(parsedData.referenceNumber ? [parsedData.referenceNumber] : []),
        ...(detectedEvent.gateResult.referenceNumber ? [detectedEvent.gateResult.referenceNumber] : []),
      ])
    ).filter(Boolean);

    const incomingEvidence: TransactionEvidence = {
      sourceType: evidenceSourceType,
      sourceId: detectedEvent.emailSubject,
      amount: parsedData.amount,
      currency: resolvedCurrency,
      occurredAt: parsedData.recordDate || detectedEvent.emailDate.toISOString(),
      merchant: parsedData.counterParty || detectedEvent.gateResult.matchedBankRule?.displayName,
      accountHint: resolvedAccountName,
      accountId: resolvedAccountId,
      destinationAccountHint: resolvedDestinationAccountName,
      destinationAccountId: resolvedDestinationAccountId,
      referenceNumbers: extractedRefs,
      note: parsedData.note || detectedEvent.emailSubject,
      categoryId: parsedData.matchedCategoryId,
      categoryName: parsedData.matchedCategoryName,
      transactionType: parsedData.transactionType,
      isBankSyncedAccount: Boolean(matchedAccountItem?.isBankSynced),
    };

    // Query recent Wallet records if MCP client is provided
    let recentRecords: WalletRecordItem[] = [];
    if (this.walletMcpClient) {
      try {
        const page = await this.walletMcpClient.fetchRecords({
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

    const correlationResult = this.correlationService.correlateEvidence(
      incomingEvidence,
      this.pendingTransactionManager.getAllPendingTransactions(),
      recentRecords
    );

    // Case 1: Correlates with existing native Wallet record (bank sync or manual write)
    if (correlationResult.suggestedAction === 'ATTACH_WALLET_RECORD') {
      const matchedRecord = (correlationResult.matchTarget as { type: 'WALLET_RECORD'; record: any }).record;
      applicationLogger.info(
        `[Correlation Matched Wallet Record] Email matches existing Wallet record (${matchedRecord.id}). Skipping duplicate candidate.`
      );

      const activeListener = this.emailListenerServiceGetter ? this.emailListenerServiceGetter() : null;
      if (activeListener) {
        for (const ref of extractedRefs) {
          activeListener.recordProcessedTransaction(undefined, ref);
        }
      }

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
        `[Correlation Fused Pending] Correlated email with pending ticket #${existingPending.ticketId}. Merging evidence.`
      );

      const enrichedItem = this.pendingTransactionManager.enrichPendingTransaction(
        existingPending.ticketId,
        correlationResult.fusedPendingItem || {}
      );

      const activeListener = this.emailListenerServiceGetter ? this.emailListenerServiceGetter() : null;
      if (activeListener) {
        for (const ref of extractedRefs) {
          activeListener.recordProcessedTransaction(undefined, ref);
        }
      }

      if (enrichedItem) {
        const totalPendingCount = this.pendingTransactionManager.getAllPendingTransactions().length;
        const notificationText = formatEnrichedPendingEmailTransactionNotification(
          enrichedItem,
          totalPendingCount,
          detectedEvent.gateResult.matchedBankRule?.displayName || 'Merchant'
        );
        await this.messagingGateway.broadcastNotification(notificationText);
        applicationLogger.success(
          `Dispatched enriched transaction notification (#${enrichedItem.ticketId}) to active messaging channels.`
        );
      }
      return;
    }

    // Case 3: Independent candidate (LOW confidence or CLARIFY)
    let initialNote = parsedData.note || detectedEvent.emailSubject;
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
      sourceType: 'EMAIL',
      bankDisplayName: detectedEvent.gateResult.matchedBankRule?.displayName || 'Bank / E-Wallet',
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
      recordDate: parsedData.recordDate || detectedEvent.emailDate.toISOString(),
      referenceNumber: extractedRefs[0],
      referenceNumbers: extractedRefs,
      evidenceSources: [incomingEvidence.sourceType],
      emailSubject: detectedEvent.emailSubject,
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
