import { EmailTransactionDetectedEvent, EmailListenerService } from '../email/index.js';
import { FinancialAiProvider } from '../brain/index.js';
import { PendingTransactionService } from '../services/pendingTransactionService.js';
import { MessagingGatewayService } from '../gateway/index.js';
import { TransactionCorrelationService } from '../email/index.js';
import { WalletCacheService, WalletMcpClientService } from '../wallet/index.js';
import { coordinateInboundTransactionCandidate } from './inboundTransactionCoordinator.js';
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

    const ruleCategory = detectedEvent.gateResult.matchedBankRule?.ruleCategory;
    const evidenceSourceType =
      ruleCategory === 'MERCHANT_RECEIPT'
        ? 'EMAIL_PAYMENT'
        : 'EMAIL_BANK';

    await coordinateInboundTransactionCandidate(
      {
        parsedData,
        gateResult: detectedEvent.gateResult,
        sourceType: 'EMAIL',
        evidenceSourceType,
        sourceId: detectedEvent.emailSubject,
        sourceDate: detectedEvent.emailDate,
        sourceDisplayName: detectedEvent.gateResult.matchedBankRule?.displayName || 'Merchant',
        fallbackNote: detectedEvent.emailSubject,
        onRecordProcessed: ref => {
          const activeListener = this.emailListenerServiceGetter ? this.emailListenerServiceGetter() : null;
          if (activeListener) {
            activeListener.recordProcessedTransaction(undefined, ref);
          }
        },
      },
      {
        walletCacheService: this.walletCacheService,
        pendingTransactionManager: this.pendingTransactionManager,
        messagingGateway: this.messagingGateway,
        defaultCurrency: this.defaultCurrency,
        correlationService: this.correlationService,
        walletMcpClient: this.walletMcpClient,
      }
    );
  }
}
