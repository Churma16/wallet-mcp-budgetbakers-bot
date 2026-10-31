import { FinancialAiProvider } from '../brain/index.js';
import { PendingTransactionService } from '../services/pendingTransactionService.js';
import { MessagingGatewayService } from '../services/messaging/index.js';
import { TransactionCorrelationService } from '../services/transactionCorrelationService.js';
import { WalletCacheService, WalletMcpClientService } from '../wallet/index.js';
import { PushNotificationPayload } from '../services/webhook/types.js';
import { evaluateNotificationThroughGate } from '../config/notificationRules.js';
import { coordinateInboundTransactionCandidate } from './inboundTransactionCoordinator.js';
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

    applicationLogger.info(
      `[Gate 1 Passed] Matched package rule: ${gateResult.matchedBankRule?.displayName || payload.packageName}`
    );

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

    // 3. Delegate to shared inbound coordinator
    await coordinateInboundTransactionCandidate(
      {
        parsedData,
        gateResult,
        sourceType: 'PUSH_NOTIFICATION',
        evidenceSourceType: 'PUSH_NOTIFICATION',
        sourceId: `${payload.packageName}:${payload.timestamp || Date.now()}`,
        sourceDate: notificationDate,
        sourceDisplayName: gateResult.matchedBankRule?.displayName || payload.packageName,
        fallbackNote: payload.title || payload.text,
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
