import fs from 'node:fs';
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  generateMessageIDV2,
  proto,
  useMultiFileAuthState,
  WAMessage,
  WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcodeTerminal from 'qrcode-terminal';
import { applicationLogger } from '../lib/logger.js';
import { digitsOnly } from '../lib/digits.js';
import { calculateExponentialBackoff } from '../lib/resilience.js';
import {
  MediaRejectionStage,
  MessagingAdapter,
  SupportedMessengerChannel,
  UserMessageCallback,
  WhatsappSafeguardConfiguration,
} from './types.js';
import {
  handleMediaDownloadFailure,
  isMediaSizeExceeded,
  rejectOversizedMedia,
} from './mediaPolicy.js';

export type { WhatsappSafeguardConfiguration };

export type WhatsappSocketProvider = () => WASocket | null;

/**
 * LRU-style bounded set tracking recently observed and dispatched WhatsApp message identifiers
 * to prevent duplicate processing and infinite echo feedback loops.
 */
export class MessageIdTracker {
  private readonly trackedIds = new Set<string>();

  constructor(private readonly maximumTrackedIds: number = 500) {}

  public has(messageId: string): boolean {
    return this.trackedIds.has(messageId);
  }

  public record(messageId: string): void {
    if (this.trackedIds.has(messageId)) {
      return;
    }

    if (this.trackedIds.size >= this.maximumTrackedIds) {
      const oldestTrackedId = this.trackedIds.values().next().value;
      if (oldestTrackedId) {
        this.trackedIds.delete(oldestTrackedId);
      }
    }

    this.trackedIds.add(messageId);
  }

  public clear(): void {
    this.trackedIds.clear();
  }
}

interface OutboundQueueItem {
  task: () => Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

/**
 * FIFO serial outbound message queue ensuring rate-limited dispatch and preventing
 * account bans from burst transmissions over WhatsApp socket connections.
 */
export class WhatsappOutboundMessageQueue {
  private readonly queue: OutboundQueueItem[] = [];
  private isProcessing = false;
  private isStopped = false;

  constructor(
    private readonly intervalMilliseconds: number,
    private readonly isConnected: () => boolean
  ) {}

  public get length(): number {
    return this.queue.length;
  }

  public enqueue(task: () => Promise<void>): Promise<void> {
    if (this.isStopped || !this.isConnected()) {
      return Promise.reject(new Error('[error] WhatsApp socket is not connected'));
    }

    return new Promise<void>((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      void this.process().catch(queueError => {
        applicationLogger.error(`Error during outbound queue processing: ${queueError}`);
      });
    });
  }

  public resume(): void {
    this.isStopped = false;
  }

  public stop(): void {
    this.isStopped = true;
    while (this.queue.length > 0) {
      this.queue.shift()?.reject(
        new Error('[error] WhatsApp adapter was stopped, message dispatch cancelled.')
      );
    }
  }

  private async process(): Promise<void> {
    if (this.isProcessing) {
      return;
    }
    this.isProcessing = true;

    try {
      while (!this.isStopped && this.queue.length > 0) {
        const queueItem = this.queue.shift();
        if (!queueItem) {
          continue;
        }

        if (!this.isConnected()) {
          queueItem.reject(new Error('[error] WhatsApp socket is not connected'));
          continue;
        }

        try {
          await queueItem.task();
          queueItem.resolve();
        } catch (executionError: unknown) {
          queueItem.reject(executionError);
        }

        if (this.queue.length > 0) {
          await new Promise(resolve => setTimeout(resolve, this.intervalMilliseconds));
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }
}

/**
 * Connection resilience manager for WhatsApp socket lifecycle, providing bounded exponential
 * backoff, circuit breaker trip logic, session cleanup, and automated reconnection scheduling.
 */
export class WhatsappConnectionResilience {
  private consecutiveFailureCount = 0;
  private circuitBreakerTripped = false;
  private activeReconnectTimeout: NodeJS.Timeout | null = null;
  private hasPurgedSessionOnLogout = false;

  constructor(
    private readonly sessionDataDirectoryPath: string,
    private readonly reconnect: () => Promise<void>,
    private readonly maxReconnectAttempts: number,
    private readonly maxBackoffSeconds: number
  ) {}

  public get failureCount(): number {
    return this.consecutiveFailureCount;
  }

  public get isCircuitOpen(): boolean {
    return this.circuitBreakerTripped;
  }

  public get hasActiveReconnect(): boolean {
    return this.activeReconnectTimeout !== null;
  }

  public get reconnectTimeout(): NodeJS.Timeout | null {
    return this.activeReconnectTimeout;
  }

  public calculateBackoffDelayMilliseconds(attemptIndex: number = this.consecutiveFailureCount): number {
    return calculateExponentialBackoff({
      attempt: attemptIndex,
      baseMs: 5000,
      maxMs: this.maxBackoffSeconds * 1000,
      jitterMinMs: 500,
      jitterMaxMs: 2500,
    });
  }

  public reset(): void {
    this.consecutiveFailureCount = 0;
    this.circuitBreakerTripped = false;
    this.hasPurgedSessionOnLogout = false;
    this.cancelScheduledReconnect();
  }

  public prepareManualConnection(): void {
    this.consecutiveFailureCount = 0;
    this.circuitBreakerTripped = false;
  }

  public markConnected(): void {
    this.reset();
  }

  public stop(): void {
    this.cancelScheduledReconnect();
  }

  public handleClose(disconnectStatusCode: number | undefined, disconnectError: unknown): void {
    this.cancelScheduledReconnect();

    if (disconnectStatusCode === DisconnectReason.connectionReplaced) {
      this.circuitBreakerTripped = true;
      applicationLogger.error(
        '[CRITICAL] WhatsApp session was replaced by another device or active client (Status 440). Auto-reconnect aborted to prevent ban.'
      );
      return;
    }

    if (disconnectStatusCode === DisconnectReason.loggedOut) {
      this.handleLoggedOut();
      return;
    }

    if (disconnectStatusCode === DisconnectReason.restartRequired) {
      applicationLogger.info('WhatsApp internal restart required (Status 515). Fast-tracking reconnection in 1s...');
      this.scheduleReconnect(1000, 'fast-track restart');
      return;
    }

    if (disconnectStatusCode === DisconnectReason.badSession) {
      applicationLogger.warn('WhatsApp session corrupted (Status 500). Purging corrupted session credentials...');
      this.purgeSessionDirectory('Failed to clean corrupted session');
    }

    this.consecutiveFailureCount++;
    applicationLogger.warn(
      `WhatsApp connection closed (Status: ${disconnectStatusCode ?? 'unknown'}, Failure Count: ${this.consecutiveFailureCount}/${this.maxReconnectAttempts}): ${disconnectError}`
    );

    if (this.consecutiveFailureCount >= this.maxReconnectAttempts) {
      this.circuitBreakerTripped = true;
      applicationLogger.error(
        `[CIRCUIT_BREAKER] Maximum consecutive connection failures (${this.maxReconnectAttempts}) reached. Halting auto-reconnect to protect account from ban.`
      );
      return;
    }

    const delayMilliseconds = this.calculateBackoffDelayMilliseconds(this.consecutiveFailureCount - 1);
    applicationLogger.info(
      `Scheduling WhatsApp reconnection attempt ${this.consecutiveFailureCount} in ${Math.round(delayMilliseconds / 1000)}s (delay: ${delayMilliseconds}ms)...`
    );
    this.scheduleReconnect(delayMilliseconds, 'scheduled reconnection attempt');
  }

  private handleLoggedOut(): void {
    if (this.hasPurgedSessionOnLogout) {
      this.consecutiveFailureCount++;
      this.circuitBreakerTripped = true;
      applicationLogger.error(
        '[CRITICAL] Repeated loggedOut event detected after session purge. Possible account ban or invalid credentials. Halting auto-reconnect.'
      );
      return;
    }

    this.hasPurgedSessionOnLogout = true;
    applicationLogger.info('WhatsApp device logged out or unlinked. Purging invalid session credentials...');
    this.purgeSessionDirectory('Failed to clean up WhatsApp session directory');
    applicationLogger.info('Scheduling single fresh QR code generation in 5 seconds...');
    this.scheduleReconnect(5000, 'QR re-initialization');
  }

  private purgeSessionDirectory(errorPrefix: string): void {
    try {
      if (fs.existsSync(this.sessionDataDirectoryPath)) {
        fs.rmSync(this.sessionDataDirectoryPath, { recursive: true, force: true });
        applicationLogger.success('WhatsApp session directory cleaned up successfully.');
      }
    } catch (cleanupError: unknown) {
      applicationLogger.error(`${errorPrefix}: ${cleanupError}`);
    }
  }

  private scheduleReconnect(delayMilliseconds: number, context: string): void {
    this.activeReconnectTimeout = setTimeout(() => {
      this.activeReconnectTimeout = null;
      this.reconnect().catch(reconnectError => {
        applicationLogger.error(`Error during ${context}: ${reconnectError}`);
      });
    }, delayMilliseconds);
  }

  private cancelScheduledReconnect(): void {
    if (this.activeReconnectTimeout) {
      clearTimeout(this.activeReconnectTimeout);
      this.activeReconnectTimeout = null;
    }
  }
}

/**
 * Typing presence manager with rate-limiting cooldown to prevent excessive socket
 * presence events from being sent to WhatsApp servers.
 */
export class WhatsappPresenceManager {
  private readonly lastTypingTimestampByChat = new Map<string, number>();

  constructor(
    private readonly getSocket: WhatsappSocketProvider,
    private readonly cooldownMilliseconds: number
  ) {}

  public getLastTypingTimestamp(chatIdentifier: string): number | undefined {
    return this.lastTypingTimestampByChat.get(chatIdentifier);
  }

  public getCooldownMilliseconds(): number {
    return this.cooldownMilliseconds;
  }

  public async sendTyping(chatIdentifier: string): Promise<void> {
    const socket = this.getSocket();
    if (!socket || !chatIdentifier.trim()) {
      return;
    }

    const lastTimestamp = this.lastTypingTimestampByChat.get(chatIdentifier) ?? 0;
    if (this.cooldownMilliseconds > 0 && Date.now() - lastTimestamp < this.cooldownMilliseconds) {
      return;
    }

    try {
      await socket.sendPresenceUpdate('composing', chatIdentifier);
      this.lastTypingTimestampByChat.set(chatIdentifier, Date.now());
    } catch (presenceError: unknown) {
      applicationLogger.fileDetail('warn', 'Failed to send WhatsApp typing presence update', {
        targetChatIdentifier: chatIdentifier,
        error: presenceError instanceof Error ? presenceError.message : String(presenceError),
      });
    }
  }

  public async clearTyping(chatIdentifier: string): Promise<void> {
    const socket = this.getSocket();
    if (!socket || !chatIdentifier.trim()) {
      return;
    }

    try {
      await socket.sendPresenceUpdate('paused', chatIdentifier);
    } catch (presenceError: unknown) {
      applicationLogger.fileDetail('warn', 'Failed to clear WhatsApp typing presence update', {
        targetChatIdentifier: chatIdentifier,
        error: presenceError instanceof Error ? presenceError.message : String(presenceError),
      });
    } finally {
      this.lastTypingTimestampByChat.delete(chatIdentifier);
    }
  }

  public reset(): void {
    this.lastTypingTimestampByChat.clear();
  }
}

/**
 * Processor for incoming WhatsApp messages, handling sender authorization, LID resolution,
 * message deduplication, and media download with size threshold enforcement.
 */
export class WhatsappInboundMessageProcessor {
  private readonly incomingMessageIds = new MessageIdTracker();
  private readonly normalizedAllowedPhoneNumbers: string[];
  private readonly normalizedAllowedPhoneNumber: string;

  constructor(
    normalizedAllowedPhoneNumber: string | string[],
    private readonly onUserMessageReceived: UserMessageCallback,
    private readonly getSocket: WhatsappSocketProvider,
    private readonly outgoingMessageIds: MessageIdTracker,
    private readonly maxMediaDownloadBytes: number,
    private readonly sendTextMessage: (chatIdentifier: string, text: string) => Promise<void>
  ) {
    const rawList = Array.isArray(normalizedAllowedPhoneNumber)
      ? normalizedAllowedPhoneNumber
      : (normalizedAllowedPhoneNumber || '').split(',');
    this.normalizedAllowedPhoneNumbers = rawList
      .map(item => digitsOnly(item))
      .filter(Boolean);
    this.normalizedAllowedPhoneNumber = this.normalizedAllowedPhoneNumbers[0] || '';
  }

  public isTargetingSelf(
    remoteJid: string,
    botUserPhoneNumber?: string,
    botUserLinkedDeviceIdentifier?: string
  ): boolean {
    const [senderRawIdentifier] = remoteJid.split('@');
    const normalizedSenderDigits = digitsOnly(senderRawIdentifier);
    return Boolean(
      (botUserPhoneNumber && normalizedSenderDigits === botUserPhoneNumber) ||
      (botUserLinkedDeviceIdentifier && senderRawIdentifier === botUserLinkedDeviceIdentifier) ||
      (this.normalizedAllowedPhoneNumbers.includes(normalizedSenderDigits))
    );
  }

  public isAuthorizedSender(remoteJid: string, isMessageTargetingSelf: boolean): boolean {
    if (isMessageTargetingSelf) {
      return true;
    }
    if (this.normalizedAllowedPhoneNumbers.length === 0) {
      return false;
    }
    const [senderRawIdentifier, jidDomain] = remoteJid.split('@');
    const senderDigits = digitsOnly(senderRawIdentifier);
    if (jidDomain === 's.whatsapp.net' || jidDomain === 'lid') {
      return this.normalizedAllowedPhoneNumbers.includes(senderDigits);
    }
    return false;
  }

  public async process(incomingMessages: proto.IWebMessageInfo[]): Promise<void> {
    for (const rawMessage of incomingMessages) {
      const remoteJid = rawMessage.key?.remoteJid;
      if (!remoteJid || remoteJid === 'status@broadcast' ||
          remoteJid.endsWith('@g.us') || remoteJid.endsWith('@newsletter')) {
        continue;
      }

      const messageId = rawMessage.key?.id;
      if (messageId && (this.incomingMessageIds.has(messageId) || this.outgoingMessageIds.has(messageId))) {
        continue;
      }
      if (messageId) {
        this.incomingMessageIds.record(messageId);
      }

      const socket = this.getSocket();
      const botPhoneNumber = digitsOnly(socket?.user?.id?.split(':')[0]?.split('@')[0] || '');
      const botLinkedDeviceIdentifier = (socket?.user as { lid?: string } | undefined)?.lid
        ?.split(':')[0]?.split('@')[0] || '';
      let targetsSelf = this.isTargetingSelf(remoteJid, botPhoneNumber, botLinkedDeviceIdentifier);

      // Attempt to resolve LID to PN if sender is an unknown @lid
      if (!targetsSelf && remoteJid.endsWith('@lid') && socket) {
        try {
          const signalRepo = (socket as unknown as { signalRepository?: { lidMapping?: { getPNForLID?: (jid: string) => Promise<string | undefined> } } }).signalRepository;
          const lidStore = signalRepo?.lidMapping;
          if (lidStore && typeof lidStore.getPNForLID === 'function') {
            const mappedPn = await lidStore.getPNForLID(remoteJid);
            if (mappedPn) {
              const mappedDigits = digitsOnly(mappedPn);
              if (
                (botPhoneNumber && mappedDigits === botPhoneNumber) ||
                this.normalizedAllowedPhoneNumbers.includes(mappedDigits)
              ) {
                targetsSelf = true;
              }
            }
          }
        } catch {
          // Best-effort LID lookup; fall back to normal checks
        }
      }

      // Provider metadata rejects echoes to other chats. Messages manually sent to the
      // account's own chat remain supported; bot-authored echoes are rejected above by ID.
      if (rawMessage.key?.fromMe && !targetsSelf) {
        continue;
      }

      if (!targetsSelf && !this.isAuthorizedSender(remoteJid, false)) {
        const reason = this.normalizedAllowedPhoneNumbers.length > 0
          ? `WhatsApp ignored message from unauthorized sender: ${remoteJid}`
          : `WhatsApp ignored non-self message from ${remoteJid}: ALLOWED_PHONE_NUMBER is not configured (fail-closed).`;
        applicationLogger.security(reason);
        continue;
      }

      const messageContent = this.unwrapMessage(rawMessage);
      if (!messageContent) {
        continue;
      }
      await this.handleMessage(rawMessage, messageContent, remoteJid, remoteJid.split('@')[0]);
    }
  }

  private unwrapMessage(rawMessage: proto.IWebMessageInfo): proto.IMessage | null | undefined {
    const directMessage = rawMessage.message;
    if (!directMessage) {
      return null;
    }
    return directMessage.ephemeralMessage?.message ||
      directMessage.viewOnceMessage?.message ||
      directMessage.viewOnceMessageV2?.message ||
      directMessage.documentWithCaptionMessage?.message ||
      directMessage;
  }

  private async handleMessage(
    rawMessage: proto.IWebMessageInfo,
    messageContent: proto.IMessage,
    remoteJid: string,
    senderIdentifier: string
  ): Promise<void> {
    const textBody = messageContent.conversation || messageContent.extendedTextMessage?.text;
    if (textBody?.trim()) {
      await this.onUserMessageReceived({
        channel: 'whatsapp', chatIdentifier: remoteJid, senderIdentifier,
        messageType: 'text', textPayload: textBody.trim(),
      });
      return;
    }

    const imageMessage = messageContent.imageMessage;
    const socket = this.getSocket();
    if (!imageMessage || !socket) {
      return;
    }

    const declaredFileLength = imageMessage.fileLength ? Number(imageMessage.fileLength) : 0;
    if (isMediaSizeExceeded(declaredFileLength, this.maxMediaDownloadBytes)) {
      await this.rejectOversizedMedia(remoteJid, senderIdentifier, declaredFileLength, 'declared_size');
      return;
    }

    try {
      const imageBuffer = await downloadMediaMessage(rawMessage as WAMessage, 'buffer', {}, {
        logger: pino({ level: 'silent' }), reuploadRequest: socket.updateMediaMessage,
      }) as Buffer;
      if (isMediaSizeExceeded(imageBuffer.length, this.maxMediaDownloadBytes)) {
        await this.rejectOversizedMedia(remoteJid, senderIdentifier, imageBuffer.length, 'buffer');
        return;
      }
      await this.onUserMessageReceived({
        channel: 'whatsapp', chatIdentifier: remoteJid, senderIdentifier,
        messageType: 'image', textPayload: imageMessage.caption || '', imageBuffer,
        imageMimeType: imageMessage.mimetype || 'image/jpeg',
      });
    } catch (downloadError: unknown) {
      await handleMediaDownloadFailure({
        channel: 'whatsapp',
        chatIdentifier: remoteJid,
        senderIdentifier,
        downloadError,
        sendTextMessage: this.sendTextMessage,
      });
    }
  }

  private async rejectOversizedMedia(
    remoteJid: string,
    senderIdentifier: string,
    actualBytes: number,
    rejectionStage: MediaRejectionStage
  ): Promise<void> {
    await rejectOversizedMedia({
      channel: 'whatsapp',
      chatIdentifier: remoteJid,
      senderIdentifier,
      maxMediaDownloadBytes: this.maxMediaDownloadBytes,
      actualBytes,
      rejectionStage,
      sendTextMessage: this.sendTextMessage,
    });
  }
}

/**
 * Production WhatsApp messaging adapter integrating Baileys, enforcing strict fail-closed
 * sender whitelisting, outbound queue pacing, and connection resilience with circuit breaking.
 */
export class WhatsappMessagingAdapter implements MessagingAdapter {
  public readonly channelName: SupportedMessengerChannel = 'whatsapp';
  private socketInstance: WASocket | null = null;
  private isConnectingOrReconnecting = false;
  private readonly normalizedAllowedPhoneNumber: string;
  private readonly normalizedAllowedPhoneNumbers: string[];
  private readonly maxMediaDownloadBytes: number;
  private readonly outgoingMessageIds = new MessageIdTracker();
  private readonly connectionResilience: WhatsappConnectionResilience;
  private readonly outboundQueue: WhatsappOutboundMessageQueue;
  private readonly presenceManager: WhatsappPresenceManager;
  private readonly inboundProcessor: WhatsappInboundMessageProcessor;

  constructor(
    private readonly sessionDataDirectoryPath: string,
    allowedPhoneNumber: string | string[],
    private readonly onUserMessageReceived: UserMessageCallback,
    safeguardConfiguration?: WhatsappSafeguardConfiguration
  ) {
    const rawList = Array.isArray(allowedPhoneNumber)
      ? allowedPhoneNumber
      : (allowedPhoneNumber || '').split(',');
    this.normalizedAllowedPhoneNumbers = rawList
      .map(item => digitsOnly(item))
      .filter(Boolean);
    this.normalizedAllowedPhoneNumber = this.normalizedAllowedPhoneNumbers[0] || '';
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
      this.normalizedAllowedPhoneNumbers,
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
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        markOnlineOnConnect: false,
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

  public handleIncomingMessage(
    rawMessage: proto.IWebMessageInfo,
    _messageContent?: proto.IMessage,
    _remoteJid?: string,
    _senderIdentifier?: string
  ): Promise<void> {
    return this.inboundProcessor.process([rawMessage]);
  }

  public get activeReconnectTimeout(): NodeJS.Timeout | null {
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
        const messageId = generateMessageIDV2(socket.user?.id);
        this.outgoingMessageIds.record(messageId);
        await socket.sendMessage(targetChatIdentifier, { text: messageText }, { messageId });
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
