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

  constructor(
    private readonly sessionDataDirectoryPath: string,
    private readonly allowedPhoneNumber: string,
    private readonly onUserMessageReceived: UserMessageCallback
  ) {}

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

        // Ignore group chats and channel/newsletter updates
        const isGroupOrNewsletterChat = remoteJid.endsWith('@g.us') || remoteJid.endsWith('@newsletter');
        if (isGroupOrNewsletterChat) {
          continue;
        }

        const botUserPhoneNumber = this.socketInstance?.user?.id?.split(':')[0]?.split('@')[0] || '';
        const botUserLinkedDeviceIdentifier = (this.socketInstance?.user as any)?.lid?.split(':')[0]?.split('@')[0] || '';

        const isMessageTargetingSelf = Boolean(
          (botUserPhoneNumber && remoteJid.includes(botUserPhoneNumber)) ||
          (botUserLinkedDeviceIdentifier && remoteJid.includes(botUserLinkedDeviceIdentifier)) ||
          (this.allowedPhoneNumber && remoteJid.includes(this.allowedPhoneNumber))
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

          if (
            textContent.startsWith('[success]') ||
            textContent.startsWith('[error]') ||
            textContent.startsWith('[info]') ||
            textContent.startsWith('[warn]')
          ) {
            continue;
          }
        }

        // Extract sender phone number (strip '@s.whatsapp.net', '@lid' or group notation)
        const senderIdentifier = remoteJid.split('@')[0];

        // Apply whitelist check if configured (skip check if chatting with oneself)
        if (this.allowedPhoneNumber && !isMessageTargetingSelf && !remoteJid.includes(this.allowedPhoneNumber)) {
          applicationLogger.security(`Ignored message from unauthorized sender: ${senderIdentifier}`);
          continue;
        }

        await this.handleIncomingMessage(rawMessage, unwrappedMessageContent, remoteJid, senderIdentifier);
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
        console.error('[error] Failed to download incoming image media:', downloadError);
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

    await this.socketInstance.sendMessage(targetRemoteJid, {
      text: messageText,
    });
  }
}
