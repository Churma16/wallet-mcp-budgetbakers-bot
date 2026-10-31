import { PushNotificationPayload, MessagingGatewayService } from '../../gateway/index.js';
import {
  EmailTransactionDetectedEvent,
  EmailListenerService,
  TransactionCorrelationService,
} from '../../email/index.js';
import { FinancialAiProvider } from '../../brain/index.js';
import { PendingTransactionService } from '../pending.js';
import { WalletCacheService, WalletMcpClientService } from '../../wallet/index.js';
import { coordinateInboundTransactionCandidate } from '../inboundCoordinator.js';
import { evaluateNotificationThroughGate } from '../../config/notificationRules.js';
import { applicationLogger } from '../../lib/logger.js';

/**
 * Processes bank or payment notification emails detected by the email listener service.
 * Performs Gate 2 AI extraction and coordinates multi-source correlation.
 */
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
   * Primary entry point for email transaction detection events.
   */
  public async handleEmailTransactionDetected(
    detectedEvent: EmailTransactionDetectedEvent
  ): Promise<void> {
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
      applicationLogger.info('[Gate 2 Filtered Out] Classified as non-transaction.');
      applicationLogger.fileDetail('email', 'Email Classified as Non-Transaction', {
        emailSubject: detectedEvent.emailSubject,
        parsedData,
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
        sourceDisplayName:
          detectedEvent.gateResult.matchedBankRule?.displayName || 'Merchant',
        fallbackNote: detectedEvent.emailSubject,
        onRecordProcessed: ref => {
          const activeListener = this.emailListenerServiceGetter
            ? this.emailListenerServiceGetter()
            : null;
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

/**
 * Processes push notification payloads received from notification receivers.
 * Performs Gate 1 evaluation, AI extraction, and multi-source correlation.
 */
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
   * Primary entry point for push notification payloads.
   */
  public async handleNotificationReceived(
    payload: PushNotificationPayload
  ): Promise<void> {
    applicationLogger.info(
      `[NotificationWebhook] Processing notification from package: ${payload.packageName}`
    );
    applicationLogger.fileDetail('notification', 'Detected Push Notification Candidate', {
      packageName: payload.packageName,
      title: payload.title,
      text: payload.text,
      timestamp: payload.timestamp,
    });

    // 0. Explicit Test Ping Handler (Companion App connectivity test)
    if (payload.isTest || payload.packageName === 'codes.churma.walletforwarder') {
      applicationLogger.info('[NotificationWebhook] Test ping notification received from companion app.');
      const testTimestamp = payload.timestamp ? new Date(payload.timestamp) : new Date();
      const formattedDate = testTimestamp.toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      const pingMessage = [
        '🧪 *[TEST PING] Wallet Forwarder*',
        '',
        '✅ *Koneksi Webhook Berhasil!*',
        `• *Status*: Terhubung (Bearer Auth Valid)`,
        `• *Perangkat*: ${payload.title || 'Android Companion App'}`,
        `• *Waktu*: ${formattedDate} WIB`,
        '',
        '_Ini adalah pesan uji coba konektivitas. Tidak ada transaksi yang dicatat ke Wallet._',
      ].join('\n');

      await this.messagingGateway.broadcastNotification(pingMessage);
      applicationLogger.info('[NotificationWebhook] Test ping broadcasted successfully to messaging channels.');
      return;
    }

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
    const notificationDate =
      gateResult.originalDate ||
      (payload.timestamp ? new Date(payload.timestamp) : new Date());

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
      applicationLogger.info(
        '[Gate 2 Filtered Out] Notification classified as non-transaction.'
      );
      return;
    }

    const evidenceSourceType = 'PUSH_NOTIFICATION';

    await coordinateInboundTransactionCandidate(
      {
        parsedData,
        gateResult,
        sourceType: 'PUSH_NOTIFICATION',
        evidenceSourceType,
        sourceId: `notif-${payload.packageName}-${notificationDate.getTime()}-${Math.abs(parsedData.amount)}`,
        sourceDate: notificationDate,
        sourceDisplayName:
          gateResult.matchedBankRule?.displayName || payload.packageName,
        fallbackNote: payload.title
          ? `${payload.title} - ${payload.text}`
          : payload.text,
        onRecordProcessed: () => {},
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
