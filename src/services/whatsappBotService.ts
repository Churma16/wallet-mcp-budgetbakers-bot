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
import { applicationLogger } from '../utils/logger.js';

export interface IncomingUserMessageEvent {
  remoteJid: string;
  senderPhoneNumber: string;
  messageType: 'text' | 'image';
  textPayload?: string;
  imageBuffer?: Buffer;
  imageMimeType?: string;
}

export type UserMessageCallback = (incomingEvent: IncomingUserMessageEvent) => Promise<void>;

export class WhatsappBotService {
  private socketInstance: WASocket | null = null;
  private isReconnecting: boolean = false;
  private readonly recentOutgoingMessageIdSet: Set<string> = new Set<string>();
  private readonly maxTrackedOutgoingMessageIds: number = 500;
  private readonly recentIncomingMessageIdSet: Set<string> = new Set<string>();
  private readonly maxTrackedIncomingMessageIds: number = 500;
  private readonly normalizedAllowedPhoneNumber: string;

  constructor(
    private readonly sessionDataDirectoryPath: string,
    private readonly allowedPhoneNumber: string,
    private readonly onUserMessageReceived: UserMessageCallback
  ) {
    this.normalizedAllowedPhoneNumber = this.allowedPhoneNumber.replace(/[^0-9]/g, '');
  }

  /**
   * Tracks incoming message IDs to prevent duplicate processing from network retries
   */
  private recordIncomingMessageId(messageId: string): void {
    if (this.recentIncomingMessageIdSet.size >= this.maxTrackedIncomingMessageIds) {
      const oldestTrackedId = this.recentIncomingMessageIdSet.values().next().value;
      if (oldestTrackedId) {
        this.recentIncomingMessageIdSet.delete(oldestTrackedId);
      }
    }
    this.recentIncomingMessageIdSet.add(messageId);
  }

  /**
   * Tracks outgoing message IDs to prevent feedback loops in "Message Yourself" mode
   */
  private recordOutgoingMessageId(messageId: string): void {
    if (this.recentOutgoingMessageIdSet.size >= this.maxTrackedOutgoingMessageIds) {
      const oldestTrackedId = this.recentOutgoingMessageIdSet.values().next().value;
      if (oldestTrackedId) {
        this.recentOutgoingMessageIdSet.delete(oldestTrackedId);
      }
    }
    this.recentOutgoingMessageIdSet.add(messageId);
  }

  /**
   * Initializes and starts the WhatsApp connection
   */
  public async startConnection(): Promise<void> {
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
      printQRInTerminal: false, // We handle printing manually with qrcode-terminal
    });

    // Save session credentials on updates
    this.socketInstance.ev.on('creds.update', saveCredentialsCallback);

    // Handle connection lifecycle events
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
        const isDeviceLoggedOut = disconnectStatusCode === DisconnectReason.loggedOut;
        const shouldReconnect = !isDeviceLoggedOut;

        applicationLogger.warn(`Connection closed due to: ${lastDisconnect?.error}, reconnecting: ${shouldReconnect}`);

        if (isDeviceLoggedOut) {
          applicationLogger.info('Device logged out or unlinked. Purging invalid session credentials...');
          try {
            if (fs.existsSync(this.sessionDataDirectoryPath)) {
              fs.rmSync(this.sessionDataDirectoryPath, { recursive: true, force: true });
              applicationLogger.success('Session directory cleaned up successfully.');
            }
          } catch (sessionCleanupError: unknown) {
            applicationLogger.error(`Failed to clean up session directory: ${sessionCleanupError}`);
          }

          applicationLogger.info('Re-initializing WhatsApp connection to generate a fresh QR code in 3 seconds...');
          setTimeout(() => {
            this.startConnection();
          }, 3000);
          return;
        }

        if (shouldReconnect && !this.isReconnecting) {
          this.isReconnecting = true;
          setTimeout(() => {
            this.isReconnecting = false;
            this.startConnection();
          }, 5000);
        }
      } else if (connection === 'open') {
        applicationLogger.success('WhatsApp connection successfully established and ready!');
        if (this.allowedPhoneNumber) {
          applicationLogger.security(`Whitelist active. Only responding to: ${this.allowedPhoneNumber}`);
        } else {
          applicationLogger.warn('ALLOWED_PHONE_NUMBER is not set in .env. The bot will respond to all private chats.');
        }
      }
    });

    // Handle incoming messages
    this.socketInstance.ev.on('messages.upsert', async messageUpsertEvent => {
      const incomingMessageList = messageUpsertEvent.messages;

      for (const rawMessage of incomingMessageList) {
        const remoteJid = rawMessage.key.remoteJid;
        if (!remoteJid || remoteJid === 'status@broadcast') {
          continue;
        }

        // Check incoming message ID for deduplication (idempotency against network retries)
        const incomingMessageId = rawMessage.key.id;
        if (incomingMessageId) {
          if (this.recentIncomingMessageIdSet.has(incomingMessageId)) {
            continue;
          }
          this.recordIncomingMessageId(incomingMessageId);
        }

        // Ignore messages sent by this bot instance
        if (incomingMessageId && this.recentOutgoingMessageIdSet.has(incomingMessageId)) {
          continue;
        }

        // Ignore group chats and channel/newsletter updates
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

        // If message is sent from the authenticated account (fromMe):
        // Allow ONLY if it is sent to oneself ("Message Yourself" feature)
        if (rawMessage.key.fromMe) {
          if (!isMessageTargetingSelf) {
            continue;
          }

          // Guard against feedback loops: ignore bot's own responses
          const textContent =
            unwrappedMessageContent.conversation ||
            unwrappedMessageContent.extendedTextMessage?.text ||
            unwrappedMessageContent.imageMessage?.caption ||
            '';

          // Heuristic fallback guard for self-chat
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

        // Apply strict whitelist check if configured (skip check if chatting with oneself)
        if (this.normalizedAllowedPhoneNumber && !isMessageTargetingSelf) {
          const isSenderWhitelisted =
            jidDomain === 's.whatsapp.net' && normalizedSenderDigits === this.normalizedAllowedPhoneNumber;

          if (!isSenderWhitelisted) {
            applicationLogger.security(`Ignored message from unauthorized sender: ${remoteJid}`);
            continue;
          }
        }

        await this.handleIncomingMessage(rawMessage, unwrappedMessageContent, remoteJid, senderRawIdentifier);
      }
    });
  }

  /**
   * Helper to unwrap nested messages (ephemeral, view-once, document-with-caption)
   */
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

  /**
   * Internal parser for incoming raw message
   */
  private async handleIncomingMessage(
    rawMessage: proto.IWebMessageInfo,
    unwrappedMessageContent: proto.IMessage,
    remoteJid: string,
    senderIdentifier: string
  ): Promise<void> {
    // 1. Text Message
    const textBody =
      unwrappedMessageContent.conversation ||
      unwrappedMessageContent.extendedTextMessage?.text;

    if (textBody && textBody.trim().length > 0) {
      await this.onUserMessageReceived({
        remoteJid,
        senderPhoneNumber: senderIdentifier,
        messageType: 'text',
        textPayload: textBody.trim(),
      });
      return;
    }

    // 2. Image Message (e.g. Receipt Photo)
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
          remoteJid,
          senderPhoneNumber: senderIdentifier,
          messageType: 'image',
          textPayload: imageCaption,
          imageBuffer,
          imageMimeType,
        });
      } catch (downloadError: unknown) {
        applicationLogger.error(`Failed to download incoming image media from ${senderIdentifier}: ${downloadError}`);
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

  /**
   * Send a text message reply to a WhatsApp contact
   */
  public async sendTextMessageReply(targetRemoteJid: string, messageText: string): Promise<void> {
    if (!this.socketInstance) {
      throw new Error('[error] WhatsApp socket is not connected');
    }

    try {
      const dispatchedMessage = await this.socketInstance.sendMessage(targetRemoteJid, {
        text: messageText,
      });

      const outgoingMessageId = dispatchedMessage?.key?.id;
      if (outgoingMessageId) {
        this.recordOutgoingMessageId(outgoingMessageId);
      }

      applicationLogger.fileDetail('whatsapp', 'Dispatched WhatsApp Text Message', {
        targetRemoteJid,
        messageId: outgoingMessageId,
        messageLength: messageText.length,
        messagePreview: messageText.substring(0, 120),
      });
    } catch (sendError: unknown) {
      applicationLogger.error(`Failed to send WhatsApp message to ${targetRemoteJid}: ${sendError}`);
      applicationLogger.fileDetail('error', 'WhatsApp Message Dispatch Failure', {
        targetRemoteJid,
        messageText,
        error: sendError instanceof Error
          ? { name: sendError.name, message: sendError.message, stack: sendError.stack }
          : String(sendError),
      });
      throw sendError;
    }
  }

  /**
   * Sends typing presence indicator ("composing") to a WhatsApp chat
   */
  public async sendTypingPresence(targetRemoteJid: string): Promise<void> {
    if (!this.socketInstance) {
      return;
    }

    try {
      await this.socketInstance.sendPresenceUpdate('composing', targetRemoteJid);
    } catch (presenceError: unknown) {
      applicationLogger.fileDetail('warn', 'Failed to send WhatsApp typing presence update', {
        targetRemoteJid,
        error: presenceError instanceof Error ? presenceError.message : String(presenceError),
      });
    }
  }

  /**
   * Clears typing presence indicator ("paused") from a WhatsApp chat
   */
  public async clearTypingPresence(targetRemoteJid: string): Promise<void> {
    if (!this.socketInstance) {
      return;
    }

    try {
      await this.socketInstance.sendPresenceUpdate('paused', targetRemoteJid);
    } catch (presenceError: unknown) {
      applicationLogger.fileDetail('warn', 'Failed to clear WhatsApp typing presence update', {
        targetRemoteJid,
        error: presenceError instanceof Error ? presenceError.message : String(presenceError),
      });
    }
  }
}
