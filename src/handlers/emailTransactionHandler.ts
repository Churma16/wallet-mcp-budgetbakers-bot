import { EmailTransactionDetectedEvent } from '../services/emailListenerService.js';
import { FinancialAiProvider } from '../services/ai/index.js';
import { WalletCacheService } from '../services/walletCacheService.js';
import { PendingTransactionService } from '../services/pendingTransactionService.js';
import { MessagingGatewayService } from '../services/messaging/index.js';
import { formatPendingEmailTransactionNotification } from '../utils/humanResponseFormatter.js';
import { applicationLogger } from '../utils/logger.js';

export class EmailTransactionHandler {
  constructor(
    private readonly financialAiProvider: FinancialAiProvider,
    private readonly walletCacheService: WalletCacheService,
    private readonly pendingTransactionManager: PendingTransactionService,
    private readonly messagingGateway: MessagingGatewayService,
    private readonly defaultCurrency: string = 'IDR'
  ) {}

  /**
   * Processes a bank notification email detected by the IMAP listener service
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
      note: parsedData.note || detectedEvent.emailSubject,
      recordDate: parsedData.recordDate || detectedEvent.emailDate.toISOString(),
      referenceNumber: parsedData.referenceNumber || detectedEvent.gateResult.referenceNumber,
      emailSubject: detectedEvent.emailSubject,
    });

    const totalPendingCount = this.pendingTransactionManager.getAllPendingTransactions().length;
    const notificationText = formatPendingEmailTransactionNotification(pendingItem, totalPendingCount);

    await this.messagingGateway.broadcastNotification(notificationText);
    applicationLogger.success(
      `Dispatched pending transaction notification (#${pendingItem.ticketId}) to active messaging channels.`
    );
  }
}
