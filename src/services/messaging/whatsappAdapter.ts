import makeWASocket, { useMultiFileAuthState, WASocket, proto } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcodeTerminal from 'qrcode-terminal';
import { applicationLogger } from '../../utils/logger.js';
import { MessagingAdapter, SupportedMessengerChannel, UserMessageCallback } from './types.js';
import { WhatsappConnectionResilience } from './whatsapp/connectionResilience.js';
import { WhatsappInboundMessageProcessor } from './whatsapp/inboundMessageProcessor.js';
import { MessageIdTracker } from './whatsapp/messageIdTracker.js';
import { WhatsappOutboundMessageQueue } from './whatsapp/outboundMessageQueue.js';
import { WhatsappPresenceManager } from './whatsapp/presenceManager.js';
import { WhatsappSafeguardConfiguration } from './whatsapp/types.js';

export type { WhatsappSafeguardConfiguration } from './whatsapp/types.js';

export class WhatsappMessagingAdapter implements MessagingAdapter {
  public readonly channelName: SupportedMessengerChannel = 'whatsapp';
  private socketInstance: WASocket | null = null;
  private isConnectingOrReconnecting = false;
  private readonly normalizedAllowedPhoneNumber: string;
  private readonly maxMediaDownloadBytes: number;
  private readonly outgoingMessageIds = new MessageIdTracker();
  private readonly connectionResilience: WhatsappConnectionResilience;
  private readonly outboundQueue: WhatsappOutboundMessageQueue;
  private readonly presenceManager: WhatsappPresenceManager;
  private readonly inboundProcessor: WhatsappInboundMessageProcessor;

  constructor(
    private readonly sessionDataDirectoryPath: string,
    allowedPhoneNumber: string,
    private readonly onUserMessageReceived: UserMessageCallback,
    safeguardConfiguration?: WhatsappSafeguardConfiguration
  ) {
    this.normalizedAllowedPhoneNumber = (allowedPhoneNumber || '').replace(/[^0-9]/g, '');
    this.maxMediaDownloadBytes = safeguardConfiguration?.maxMediaDownloadBytes ?? 10 * 1024 * 1024;
    const getSocket = () => this.socketInstance;

    this.connectionResilience = new WhatsappConnectionResilience(
      this.sessionDataDirectoryPath,
      () => this.startConnection(false),
      safeguardConfiguration?.maxReconnectAttempts ?? 6,
      safeguardConfiguration?.maxBackoffSeconds ?? 300
    );
    this.outboundQueue = new WhatsappOutboundMessageQueue(
      safeguardConfiguration?.messageQueueIntervalMs ?? 1000,
      () => this.socketInstance !== null
    );
    this.presenceManager = new WhatsappPresenceManager(
      getSocket,
      safeguardConfiguration?.typingPresenceCooldownMs ?? 2500
    );
    this.inboundProcessor = new WhatsappInboundMessageProcessor(
      this.normalizedAllowedPhoneNumber,
      this.onUserMessageReceived,
      getSocket,
      this.outgoingMessageIds,
      this.maxMediaDownloadBytes,
      (chatIdentifier, text) => this.sendTextMessage(chatIdentifier, text)
    );
  }

  public isTargetingSelf(remoteJid: string, botPhone?: string, botLid?: string): boolean {
    return this.inboundProcessor.isTargetingSelf(remoteJid, botPhone, botLid);
  }

  public isAuthorizedSender(remoteJid: string, isTargetingSelf: boolean): boolean {
    return this.inboundProcessor.isAuthorizedSender(remoteJid, isTargetingSelf);
  }

  public getMaxMediaDownloadBytes(): number { return this.maxMediaDownloadBytes; }
  public getConsecutiveFailureCount(): number { return this.connectionResilience.failureCount; }
  public getCircuitBreakerStatus(): boolean { return this.connectionResilience.isCircuitOpen; }
  public getOutboundQueueLength(): number { return this.outboundQueue.length; }
  public getLastTypingPresenceTimestamp(chatIdentifier: string): number | undefined {
    return this.presenceManager.getLastTypingTimestamp(chatIdentifier);
  }
  public getTypingPresenceCooldownMilliseconds(): number {
    return this.presenceManager.getCooldownMilliseconds();
  }
  public calculateBackoffDelayMilliseconds(attemptIndex?: number): number {
    return this.connectionResilience.calculateBackoffDelayMilliseconds(attemptIndex);
  }
  public resetSafeguardsState(): void {
    this.connectionResilience.reset();
    this.outboundQueue.resume();
  }
  public handleConnectionClose(statusCode: number | undefined, error: unknown): void {
    this.connectionResilience.handleClose(statusCode, error);
  }

  public async startConnection(isManualTrigger: boolean = true): Promise<void> {
    if (isManualTrigger) this.connectionResilience.prepareManualConnection();
    if (this.connectionResilience.isCircuitOpen) {
      applicationLogger.error(
        `[CIRCUIT_BREAKER] WhatsApp reconnection paused due to ${this.connectionResilience.failureCount} consecutive failures. Resolve issue or restart manually.`
      );
      return;
    }
    if (this.isConnectingOrReconnecting) {
      applicationLogger.warn('WhatsApp connection initialization already in progress, skipping duplicate attempt.');
      return;
    }

    this.isConnectingOrReconnecting = true;
    this.connectionResilience.stop();
    this.outboundQueue.resume();
    try {
      this.removeSocketListeners();
      const { state, saveCreds } = await useMultiFileAuthState(this.sessionDataDirectoryPath);
      this.socketInstance = makeWASocket({
        auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false,
        generateHighQualityLinkPreview: false, syncFullHistory: false,
        shouldSyncHistoryMessage: () => false, markOnlineOnConnect: false,
        getMessage: async () => undefined,
      });
      this.socketInstance.ev.on('creds.update', saveCreds);
      this.socketInstance.ev.on('connection.update', update => this.handleConnectionUpdate(update));
      this.socketInstance.ev.on('messages.upsert', event => { void this.processIncomingMessages(event.messages); });
    } catch (initializationError: unknown) {
      applicationLogger.error(`Failed to initialize WhatsApp connection: ${initializationError}`);
      throw initializationError;
    } finally {
      this.isConnectingOrReconnecting = false;
    }
  }

  public processIncomingMessages(messages: proto.IWebMessageInfo[]): Promise<void> {
    return this.inboundProcessor.process(messages);
  }

  private handleIncomingMessage(
    rawMessage: proto.IWebMessageInfo,
    _messageContent: proto.IMessage,
    _remoteJid: string,
    _senderIdentifier: string
  ): Promise<void> {
    return this.inboundProcessor.process([rawMessage]);
  }

  private get activeReconnectTimeout(): NodeJS.Timeout | null {
    return this.connectionResilience.reconnectTimeout;
  }

  public enqueueOutboundMessage(task: () => Promise<void>): Promise<void> {
    return this.outboundQueue.enqueue(task);
  }

  public async sendTextMessage(targetChatIdentifier: string, messageText: string): Promise<void> {
    return this.outboundQueue.enqueue(async () => {
      const socket = this.socketInstance;
      if (!socket) throw new Error('[error] WhatsApp socket is not connected');
      try {
        const dispatchedMessage = await socket.sendMessage(targetChatIdentifier, { text: messageText });
        const messageId = dispatchedMessage?.key?.id;
        if (messageId) this.outgoingMessageIds.record(messageId);
        applicationLogger.fileDetail('whatsapp', 'Dispatched WhatsApp Text Message', {
          targetChatIdentifier, messageId, messageLength: messageText.length,
          messagePreview: messageText.substring(0, 120),
        });
      } catch (sendError: unknown) {
        applicationLogger.error(`Failed to send WhatsApp message to ${targetChatIdentifier}: ${sendError}`);
        applicationLogger.fileDetail('error', 'WhatsApp Message Dispatch Failure', {
          targetChatIdentifier, messageText,
          error: sendError instanceof Error
            ? { name: sendError.name, message: sendError.message, stack: sendError.stack }
            : String(sendError),
        });
        throw sendError;
      }
    });
  }

  public sendTypingPresence(chatIdentifier: string): Promise<void> {
    return this.presenceManager.sendTyping(chatIdentifier);
  }
  public clearTypingPresence(chatIdentifier: string): Promise<void> {
    return this.presenceManager.clearTyping(chatIdentifier);
  }

  public async sendBroadcastNotification(messageText: string): Promise<void> {
    if (!this.normalizedAllowedPhoneNumber) {
      applicationLogger.warn('Cannot broadcast WhatsApp notification: ALLOWED_PHONE_NUMBER is not configured.');
      return;
    }
    await this.sendTextMessage(`${this.normalizedAllowedPhoneNumber}@s.whatsapp.net`, messageText);
  }

  public async stopConnection(): Promise<void> {
    this.connectionResilience.stop();
    this.presenceManager.reset();
    this.outboundQueue.stop();
    const socket = this.socketInstance;
    this.socketInstance = null;
    if (socket) {
      try { await socket.end(undefined); }
      catch (error: unknown) { applicationLogger.warn(`Error closing WhatsApp socket: ${error}`); }
    }
  }

  private handleConnectionUpdate(update: {
    connection?: string; lastDisconnect?: { error?: unknown }; qr?: string; isNewLogin?: boolean;
  }): void {
    const { connection, lastDisconnect, qr } = update;
    applicationLogger.fileDetail('whatsapp', 'Connection Lifecycle Update Event', {
      connection, isNewLogin: update.isNewLogin, receivedQr: Boolean(qr),
      lastDisconnectError: lastDisconnect?.error instanceof Error
        ? { name: lastDisconnect.error.name, message: lastDisconnect.error.message,
            stack: lastDisconnect.error.stack,
            statusCode: (lastDisconnect.error as { output?: { statusCode?: number } }).output?.statusCode }
        : lastDisconnect?.error,
    });
    if (qr) {
      console.log('\n');
      applicationLogger.info('WhatsApp Pairing QR Code Generated. Please scan with WhatsApp:');
      qrcodeTerminal.generate(qr, { small: true });
      console.log('[hint] Open WhatsApp -> Linked Devices -> Link a Device and scan the QR code above.\n');
    }
    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
      this.connectionResilience.handleClose(statusCode, lastDisconnect?.error);
    } else if (connection === 'open') {
      this.connectionResilience.markConnected();
      applicationLogger.success('WhatsApp connection successfully established and ready!');
      if (this.normalizedAllowedPhoneNumber) {
        applicationLogger.security(`WhatsApp whitelist active. Only responding to: ${this.normalizedAllowedPhoneNumber}`);
      } else {
        applicationLogger.warn(
          'ALLOWED_PHONE_NUMBER is not set in .env. Inbound non-self WhatsApp messages will be rejected (fail-closed).'
        );
      }
    }
  }

  private removeSocketListeners(): void {
    if (!this.socketInstance) return;
    this.socketInstance.ev.removeAllListeners('creds.update');
    this.socketInstance.ev.removeAllListeners('connection.update');
    this.socketInstance.ev.removeAllListeners('messages.upsert');
    this.socketInstance = null;
  }
}
