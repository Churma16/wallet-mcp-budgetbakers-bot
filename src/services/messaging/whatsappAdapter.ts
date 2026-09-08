import fs from 'fs';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  WASocket,
  proto,
  WAMessage,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcodeTerminal from 'qrcode-terminal';
import { applicationLogger } from '../../utils/logger.js';
import {
  MessagingAdapter,
  SupportedMessengerChannel,
  UserMessageCallback,
  IncomingUserMessageEvent,
} from './types.js';

export interface WhatsappSafeguardConfiguration {
  maxReconnectAttempts?: number;
  maxBackoffSeconds?: number;
  messageQueueIntervalMs?: number;
  typingPresenceCooldownMs?: number;
}

export class WhatsappMessagingAdapter implements MessagingAdapter {
  public readonly channelName: SupportedMessengerChannel = 'whatsapp';
  private socketInstance: WASocket | null = null;
  private readonly recentOutgoingMessageIdSet: Set<string> = new Set<string>();
  private readonly maxTrackedOutgoingMessageIds: number = 500;
  private readonly recentIncomingMessageIdSet: Set<string> = new Set<string>();
  private readonly maxTrackedIncomingMessageIds: number = 500;
  private readonly normalizedAllowedPhoneNumber: string;

  private readonly maxReconnectAttempts: number;
  private readonly maxBackoffSeconds: number;
  private readonly messageQueueIntervalMs: number;
  private readonly typingPresenceCooldownMilliseconds: number;
  private readonly lastTypingPresenceTimestampMap: Map<string, number> = new Map<string, number>();

  private consecutiveFailureCount: number = 0;
  private isCircuitBreakerTripped: boolean = false;
  private isConnectingOrReconnecting: boolean = false;
  private activeReconnectTimeout: NodeJS.Timeout | null = null;
  private hasPurgedSessionOnLogout: boolean = false;

  private readonly outboundMessageQueue: Array<{
    task: () => Promise<void>;
    resolve: () => void;
    reject: (reason: unknown) => void;
  }> = [];
  private isProcessingMessageQueue: boolean = false;

  constructor(
    private readonly sessionDataDirectoryPath: string,
    private readonly allowedPhoneNumber: string,
    private readonly onUserMessageReceived: UserMessageCallback,
    safeguardConfiguration?: WhatsappSafeguardConfiguration
  ) {
    this.normalizedAllowedPhoneNumber = this.allowedPhoneNumber.replace(/[^0-9]/g, '');
    this.maxReconnectAttempts = safeguardConfiguration?.maxReconnectAttempts ?? 6;
    this.maxBackoffSeconds = safeguardConfiguration?.maxBackoffSeconds ?? 300;
    this.messageQueueIntervalMs = safeguardConfiguration?.messageQueueIntervalMs ?? 1000;
    this.typingPresenceCooldownMilliseconds = safeguardConfiguration?.typingPresenceCooldownMs ?? 2500;
  }

  private recordIncomingMessageId(messageId: string): void {
    if (this.recentIncomingMessageIdSet.size >= this.maxTrackedIncomingMessageIds) {
      const oldestTrackedId = this.recentIncomingMessageIdSet.values().next().value;
      if (oldestTrackedId) {
        this.recentIncomingMessageIdSet.delete(oldestTrackedId);
      }
    }
    this.recentIncomingMessageIdSet.add(messageId);
  }

  private recordOutgoingMessageId(messageId: string): void {
    if (this.recentOutgoingMessageIdSet.size >= this.maxTrackedOutgoingMessageIds) {
      const oldestTrackedId = this.recentOutgoingMessageIdSet.values().next().value;
      if (oldestTrackedId) {
        this.recentOutgoingMessageIdSet.delete(oldestTrackedId);
      }
    }
    this.recentOutgoingMessageIdSet.add(messageId);
  }

  public getConsecutiveFailureCount(): number {
    return this.consecutiveFailureCount;
  }

  public getCircuitBreakerStatus(): boolean {
    return this.isCircuitBreakerTripped;
  }

  public getOutboundQueueLength(): number {
    return this.outboundMessageQueue.length;
  }

  public getLastTypingPresenceTimestamp(targetChatIdentifier: string): number | undefined {
    return this.lastTypingPresenceTimestampMap.get(targetChatIdentifier);
  }

  public getTypingPresenceCooldownMilliseconds(): number {
    return this.typingPresenceCooldownMilliseconds;
  }

  public calculateBackoffDelayMilliseconds(attemptIndex: number = this.consecutiveFailureCount): number {
    const baseDelaySeconds = 5;
    const exponentialSeconds = baseDelaySeconds * Math.pow(2, attemptIndex);
    const boundedSeconds = Math.min(this.maxBackoffSeconds, exponentialSeconds);
    const randomJitterMilliseconds = Math.floor(Math.random() * 2000) + 500;
    return boundedSeconds * 1000 + randomJitterMilliseconds;
  }

  public resetSafeguardsState(): void {
    this.consecutiveFailureCount = 0;
    this.isCircuitBreakerTripped = false;
    this.hasPurgedSessionOnLogout = false;
    if (this.activeReconnectTimeout) {
      clearTimeout(this.activeReconnectTimeout);
      this.activeReconnectTimeout = null;
    }
  }

  public handleConnectionClose(disconnectStatusCode: number | undefined, disconnectError: unknown): void {
    if (this.activeReconnectTimeout) {
      clearTimeout(this.activeReconnectTimeout);
      this.activeReconnectTimeout = null;
    }

    // 1. Check: Connection Replaced (Status 440) -> Never auto-reconnect!
    if (disconnectStatusCode === DisconnectReason.connectionReplaced) {
      this.isCircuitBreakerTripped = true;
      applicationLogger.error(
        '[CRITICAL] WhatsApp session was replaced by another device or active client (Status 440). Auto-reconnect aborted to prevent ban.'
      );
      return;
    }

    // 2. Check: Device Logged Out (Status 401)
    if (disconnectStatusCode === DisconnectReason.loggedOut) {
      if (this.hasPurgedSessionOnLogout) {
        this.consecutiveFailureCount++;
        this.isCircuitBreakerTripped = true;
        applicationLogger.error(
          '[CRITICAL] Repeated loggedOut event detected after session purge. Possible account ban or invalid credentials. Halting auto-reconnect.'
        );
        return;
      }

      this.hasPurgedSessionOnLogout = true;
      applicationLogger.info('WhatsApp device logged out or unlinked. Purging invalid session credentials...');
      try {
        if (fs.existsSync(this.sessionDataDirectoryPath)) {
          fs.rmSync(this.sessionDataDirectoryPath, { recursive: true, force: true });
          applicationLogger.success('WhatsApp session directory cleaned up successfully.');
        }
      } catch (sessionCleanupError: unknown) {
        applicationLogger.error(`Failed to clean up WhatsApp session directory: ${sessionCleanupError}`);
      }

      applicationLogger.info('Scheduling single fresh QR code generation in 5 seconds...');
      this.activeReconnectTimeout = setTimeout(() => {
        this.activeReconnectTimeout = null;
        this.startConnection(false).catch(reconnectError => {
          applicationLogger.error(`Error during QR re-initialization: ${reconnectError}`);
        });
      }, 5000);
      return;
    }

    // 3. Check: Restart Required (Status 515 - fast track)
    if (disconnectStatusCode === DisconnectReason.restartRequired) {
      applicationLogger.info('WhatsApp internal restart required (Status 515). Fast-tracking reconnection in 1s...');
      this.activeReconnectTimeout = setTimeout(() => {
        this.activeReconnectTimeout = null;
        this.startConnection(false).catch(reconnectError => {
          applicationLogger.error(`Error during fast-track restart: ${reconnectError}`);
        });
      }, 1000);
      return;
    }

    // 4. Check: Bad Session (Status 500)
    if (disconnectStatusCode === DisconnectReason.badSession) {
      applicationLogger.warn('WhatsApp session corrupted (Status 500). Purging corrupted session credentials...');
      try {
        if (fs.existsSync(this.sessionDataDirectoryPath)) {
          fs.rmSync(this.sessionDataDirectoryPath, { recursive: true, force: true });
        }
      } catch (cleanupError) {
        applicationLogger.error(`Failed to clean corrupted session: ${cleanupError}`);
      }
    }

    // 5. Standard failures (408, 428, 500, undefined, or unknown status code)
    this.consecutiveFailureCount++;
    applicationLogger.warn(
      `WhatsApp connection closed (Status: ${disconnectStatusCode ?? 'unknown'}, Failure Count: ${this.consecutiveFailureCount}/${this.maxReconnectAttempts}): ${disconnectError}`
    );

    if (this.consecutiveFailureCount >= this.maxReconnectAttempts) {
      this.isCircuitBreakerTripped = true;
      applicationLogger.error(
        `[CIRCUIT_BREAKER] Maximum consecutive connection failures (${this.maxReconnectAttempts}) reached. Halting auto-reconnect to protect account from ban.`
      );
      return;
    }

    const backoffDelayMilliseconds = this.calculateBackoffDelayMilliseconds(this.consecutiveFailureCount - 1);
    const delaySeconds = Math.round(backoffDelayMilliseconds / 1000);
    applicationLogger.info(
      `Scheduling WhatsApp reconnection attempt ${this.consecutiveFailureCount} in ${delaySeconds}s (delay: ${backoffDelayMilliseconds}ms)...`
    );

    this.activeReconnectTimeout = setTimeout(() => {
      this.activeReconnectTimeout = null;
      this.startConnection(false).catch(reconnectError => {
        applicationLogger.error(`Error during scheduled reconnection attempt: ${reconnectError}`);
      });
    }, backoffDelayMilliseconds);
  }

  public async startConnection(isManualTrigger: boolean = true): Promise<void> {
    if (isManualTrigger) {
      this.consecutiveFailureCount = 0;
      this.isCircuitBreakerTripped = false;
    }

    if (this.isCircuitBreakerTripped) {
      applicationLogger.error(
        `[CIRCUIT_BREAKER] WhatsApp reconnection paused due to ${this.consecutiveFailureCount} consecutive failures. Resolve issue or restart manually.`
      );
      return;
    }

    if (this.isConnectingOrReconnecting) {
      applicationLogger.warn('WhatsApp connection initialization already in progress, skipping duplicate attempt.');
      return;
    }

    this.isConnectingOrReconnecting = true;

    if (this.activeReconnectTimeout) {
      clearTimeout(this.activeReconnectTimeout);
      this.activeReconnectTimeout = null;
    }

    try {
      if (this.socketInstance) {
        this.socketInstance.ev.removeAllListeners('creds.update');
        this.socketInstance.ev.removeAllListeners('connection.update');
        this.socketInstance.ev.removeAllListeners('messages.upsert');
        this.socketInstance = null;
      }

      const { state: authState, saveCreds: saveCredentialsCallback } = await useMultiFileAuthState(
        this.sessionDataDirectoryPath
      );

      const silentLogger = pino({ level: 'silent' });

      this.socketInstance = makeWASocket({
        auth: authState,
        logger: silentLogger,
        printQRInTerminal: false,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        markOnlineOnConnect: false,
        getMessage: async () => undefined,
      });

      this.socketInstance.ev.on('creds.update', saveCredentialsCallback);

      this.socketInstance.ev.on('connection.update', async connectionUpdate => {
        const { connection, lastDisconnect, qr } = connectionUpdate;

        applicationLogger.fileDetail('whatsapp', 'Connection Lifecycle Update Event', {
          connection,
          isNewLogin: connectionUpdate.isNewLogin,
          receivedQr: Boolean(qr),
          lastDisconnectError: lastDisconnect?.error instanceof Error
            ? {
                name: lastDisconnect.error.name,
                message: lastDisconnect.error.message,
                stack: lastDisconnect.error.stack,
                statusCode: (lastDisconnect.error as any)?.output?.statusCode,
              }
            : lastDisconnect?.error,
        });

        if (qr) {
          console.log('\n');
          applicationLogger.info('WhatsApp Pairing QR Code Generated. Please scan with WhatsApp:');
          qrcodeTerminal.generate(qr, { small: true });
          console.log('[hint] Open WhatsApp -> Linked Devices -> Link a Device and scan the QR code above.\n');
        }

        if (connection === 'close') {
          const disconnectStatusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          this.handleConnectionClose(disconnectStatusCode, lastDisconnect?.error);
        } else if (connection === 'open') {
          this.consecutiveFailureCount = 0;
          this.isCircuitBreakerTripped = false;
          this.hasPurgedSessionOnLogout = false;
          if (this.activeReconnectTimeout) {
            clearTimeout(this.activeReconnectTimeout);
            this.activeReconnectTimeout = null;
          }

          applicationLogger.success('WhatsApp connection successfully established and ready!');
          if (this.allowedPhoneNumber) {
            applicationLogger.security(`WhatsApp whitelist active. Only responding to: ${this.allowedPhoneNumber}`);
          } else {
            applicationLogger.warn('ALLOWED_PHONE_NUMBER is not set in .env. WhatsApp will respond to all private chats.');
          }
        }
      });

    this.socketInstance.ev.on('messages.upsert', async messageUpsertEvent => {
      const incomingMessageList = messageUpsertEvent.messages;

      for (const rawMessage of incomingMessageList) {
        const remoteJid = rawMessage.key.remoteJid;
        if (!remoteJid || remoteJid === 'status@broadcast') {
          continue;
        }

        const incomingMessageId = rawMessage.key.id;
        if (incomingMessageId) {
          if (this.recentIncomingMessageIdSet.has(incomingMessageId)) {
            continue;
          }
          this.recordIncomingMessageId(incomingMessageId);
        }

        if (incomingMessageId && this.recentOutgoingMessageIdSet.has(incomingMessageId)) {
          continue;
        }

        const isGroupOrNewsletterChat = remoteJid.endsWith('@g.us') || remoteJid.endsWith('@newsletter');
        if (isGroupOrNewsletterChat) {
          continue;
        }

        const [senderRawIdentifier, jidDomain] = remoteJid.split('@');
        const normalizedSenderDigits = senderRawIdentifier.replace(/[^0-9]/g, '');

        const botUserPhoneNumber =
          this.socketInstance?.user?.id?.split(':')[0]?.split('@')[0]?.replace(/[^0-9]/g, '') || '';
        const botUserLinkedDeviceIdentifier =
          (this.socketInstance?.user as any)?.lid?.split(':')[0]?.split('@')[0] || '';

        const isMessageTargetingSelf = Boolean(
          (botUserPhoneNumber && normalizedSenderDigits === botUserPhoneNumber) ||
          (botUserLinkedDeviceIdentifier && senderRawIdentifier === botUserLinkedDeviceIdentifier) ||
          (this.normalizedAllowedPhoneNumber && normalizedSenderDigits === this.normalizedAllowedPhoneNumber)
        );

        const unwrappedMessageContent = this.extractUnwrappedMessageContent(rawMessage);
        if (!unwrappedMessageContent) {
          continue;
        }

        if (rawMessage.key.fromMe) {
          if (!isMessageTargetingSelf) {
            continue;
          }

          const textContent =
            unwrappedMessageContent.conversation ||
            unwrappedMessageContent.extendedTextMessage?.text ||
            unwrappedMessageContent.imageMessage?.caption ||
            '';

          if (
            textContent.startsWith('✅') ||
            textContent.startsWith('⚠️') ||
            textContent.startsWith('📊 *Saldo Rekening*') ||
            textContent.startsWith('📈 *Status Anggaran*') ||
            textContent.startsWith('[success]') ||
            textContent.startsWith('[error]') ||
            textContent.startsWith('[info]') ||
            textContent.startsWith('[warn]')
          ) {
            continue;
          }
        }

        if (this.normalizedAllowedPhoneNumber && !isMessageTargetingSelf) {
          const isSenderWhitelisted =
            jidDomain === 's.whatsapp.net' && normalizedSenderDigits === this.normalizedAllowedPhoneNumber;

          if (!isSenderWhitelisted) {
            applicationLogger.security(`WhatsApp ignored message from unauthorized sender: ${remoteJid}`);
            continue;
          }
        }

        await this.handleIncomingMessage(rawMessage, unwrappedMessageContent, remoteJid, senderRawIdentifier);
      }
    });
    } catch (connectionInitializationError: unknown) {
      applicationLogger.error(`Failed to initialize WhatsApp connection: ${connectionInitializationError}`);
      throw connectionInitializationError;
    } finally {
      this.isConnectingOrReconnecting = false;
    }
  }

  private extractUnwrappedMessageContent(rawMessage: proto.IWebMessageInfo): proto.IMessage | null | undefined {
    const directMessage = rawMessage.message;
    if (!directMessage) return null;

    return (
      directMessage.ephemeralMessage?.message ||
      directMessage.viewOnceMessage?.message ||
      directMessage.viewOnceMessageV2?.message ||
      directMessage.documentWithCaptionMessage?.message ||
      directMessage
    );
  }

  private async handleIncomingMessage(
    rawMessage: proto.IWebMessageInfo,
    unwrappedMessageContent: proto.IMessage,
    remoteJid: string,
    senderIdentifier: string
  ): Promise<void> {
    const textBody =
      unwrappedMessageContent.conversation ||
      unwrappedMessageContent.extendedTextMessage?.text;

    if (textBody && textBody.trim().length > 0) {
      await this.onUserMessageReceived({
        channel: 'whatsapp',
        chatIdentifier: remoteJid,
        senderIdentifier,
        messageType: 'text',
        textPayload: textBody.trim(),
      });
      return;
    }

    if (unwrappedMessageContent.imageMessage && this.socketInstance) {
      try {
        const imageBuffer = (await downloadMediaMessage(
          rawMessage as WAMessage,
          'buffer',
          {},
          {
            logger: pino({ level: 'silent' }),
            reuploadRequest: this.socketInstance.updateMediaMessage,
          }
        )) as Buffer;

        const imageCaption = unwrappedMessageContent.imageMessage.caption || '';
        const imageMimeType = unwrappedMessageContent.imageMessage.mimetype || 'image/jpeg';

        await this.onUserMessageReceived({
          channel: 'whatsapp',
          chatIdentifier: remoteJid,
          senderIdentifier,
          messageType: 'image',
          textPayload: imageCaption,
          imageBuffer,
          imageMimeType,
        });
      } catch (downloadError: unknown) {
        applicationLogger.error(`Failed to download incoming WhatsApp image media from ${senderIdentifier}: ${downloadError}`);
        applicationLogger.fileDetail('error', 'WhatsApp Media Download Failure', {
          error: downloadError instanceof Error
            ? { name: downloadError.name, message: downloadError.message, stack: downloadError.stack }
            : String(downloadError),
          remoteJid,
          senderIdentifier,
        });
      }
    }
  }

  public enqueueOutboundMessage(task: () => Promise<void>): Promise<void> {
    if (!this.socketInstance) {
      return Promise.reject(new Error('[error] WhatsApp socket is not connected'));
    }

    return new Promise<void>((resolve, reject) => {
      this.outboundMessageQueue.push({ task, resolve, reject });
      this.processOutboundMessageQueue().catch(queueProcessError => {
        applicationLogger.error(`Error during outbound queue processing: ${queueProcessError}`);
      });
    });
  }

  private async processOutboundMessageQueue(): Promise<void> {
    if (this.isProcessingMessageQueue) {
      return;
    }
    this.isProcessingMessageQueue = true;

    try {
      while (this.outboundMessageQueue.length > 0) {
        const currentQueueItem = this.outboundMessageQueue.shift();
        if (!currentQueueItem) {
          continue;
        }

        if (!this.socketInstance) {
          currentQueueItem.reject(new Error('[error] WhatsApp socket is not connected'));
          continue;
        }

        try {
          await currentQueueItem.task();
          currentQueueItem.resolve();
        } catch (itemExecutionError: unknown) {
          currentQueueItem.reject(itemExecutionError);
        }

        if (this.outboundMessageQueue.length > 0) {
          await new Promise(timerResolve => setTimeout(timerResolve, this.messageQueueIntervalMs));
        }
      }
    } finally {
      this.isProcessingMessageQueue = false;
    }
  }

  public async sendTextMessage(targetChatIdentifier: string, messageText: string): Promise<void> {
    return this.enqueueOutboundMessage(async () => {
      if (!this.socketInstance) {
        throw new Error('[error] WhatsApp socket is not connected');
      }

      try {
        const dispatchedMessage = await this.socketInstance.sendMessage(targetChatIdentifier, {
          text: messageText,
        });

        const outgoingMessageId = dispatchedMessage?.key?.id;
        if (outgoingMessageId) {
          this.recordOutgoingMessageId(outgoingMessageId);
        }

        applicationLogger.fileDetail('whatsapp', 'Dispatched WhatsApp Text Message', {
          targetChatIdentifier,
          messageId: outgoingMessageId,
          messageLength: messageText.length,
          messagePreview: messageText.substring(0, 120),
        });
      } catch (sendError: unknown) {
        applicationLogger.error(`Failed to send WhatsApp message to ${targetChatIdentifier}: ${sendError}`);
        applicationLogger.fileDetail('error', 'WhatsApp Message Dispatch Failure', {
          targetChatIdentifier,
          messageText,
          error: sendError instanceof Error
            ? { name: sendError.name, message: sendError.message, stack: sendError.stack }
            : String(sendError),
        });
        throw sendError;
      }
    });
  }

  public async sendTypingPresence(targetChatIdentifier: string): Promise<void> {
    if (!this.socketInstance) {
      return;
    }

    if (!targetChatIdentifier || targetChatIdentifier.trim().length === 0) {
      return;
    }

    const currentTimestamp = Date.now();
    const lastDispatchedTimestamp = this.lastTypingPresenceTimestampMap.get(targetChatIdentifier) || 0;

    if (
      this.typingPresenceCooldownMilliseconds > 0 &&
      currentTimestamp - lastDispatchedTimestamp < this.typingPresenceCooldownMilliseconds
    ) {
      return;
    }

    try {
      await this.socketInstance.sendPresenceUpdate('composing', targetChatIdentifier);
      this.lastTypingPresenceTimestampMap.set(targetChatIdentifier, Date.now());
    } catch (presenceError: unknown) {
      applicationLogger.fileDetail('warn', 'Failed to send WhatsApp typing presence update', {
        targetChatIdentifier,
        error: presenceError instanceof Error ? presenceError.message : String(presenceError),
      });
    }
  }

  public async clearTypingPresence(targetChatIdentifier: string): Promise<void> {
    if (!this.socketInstance) {
      return;
    }

    if (!targetChatIdentifier || targetChatIdentifier.trim().length === 0) {
      return;
    }

    try {
      await this.socketInstance.sendPresenceUpdate('paused', targetChatIdentifier);
    } catch (presenceError: unknown) {
      applicationLogger.fileDetail('warn', 'Failed to clear WhatsApp typing presence update', {
        targetChatIdentifier,
        error: presenceError instanceof Error ? presenceError.message : String(presenceError),
      });
    } finally {
      this.lastTypingPresenceTimestampMap.delete(targetChatIdentifier);
    }
  }

  public async sendBroadcastNotification(messageText: string): Promise<void> {
    if (!this.normalizedAllowedPhoneNumber) {
      applicationLogger.warn('Cannot broadcast WhatsApp notification: ALLOWED_PHONE_NUMBER is not configured.');
      return;
    }

    const recipientJid = `${this.normalizedAllowedPhoneNumber}@s.whatsapp.net`;
    await this.sendTextMessage(recipientJid, messageText);
  }

  public async stopConnection(): Promise<void> {
    if (this.activeReconnectTimeout) {
      clearTimeout(this.activeReconnectTimeout);
      this.activeReconnectTimeout = null;
    }

    this.isConnectingOrReconnecting = false;
    this.lastTypingPresenceTimestampMap.clear();

    // Drain and reject all pending outbound messages in queue (EC-4)
    while (this.outboundMessageQueue.length > 0) {
      const pendingQueueItem = this.outboundMessageQueue.shift();
      if (pendingQueueItem) {
        pendingQueueItem.reject(new Error('[error] WhatsApp adapter was stopped, message dispatch cancelled.'));
      }
    }
    this.isProcessingMessageQueue = false;

    if (this.socketInstance) {
      try {
        this.socketInstance.end(undefined);
      } catch (error: unknown) {
        applicationLogger.warn(`Error closing WhatsApp socket: ${error}`);
      }
      this.socketInstance = null;
    }
  }
}
