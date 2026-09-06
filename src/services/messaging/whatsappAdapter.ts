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

export class WhatsappMessagingAdapter implements MessagingAdapter {
  public readonly channelName: SupportedMessengerChannel = 'whatsapp';
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
      printQRInTerminal: false,
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
        const isDeviceLoggedOut = disconnectStatusCode === DisconnectReason.loggedOut;
        const shouldReconnect = !isDeviceLoggedOut;

        applicationLogger.warn(`WhatsApp connection closed due to: ${lastDisconnect?.error}, reconnecting: ${shouldReconnect}`);

        if (isDeviceLoggedOut) {
          applicationLogger.info('WhatsApp device logged out or unlinked. Purging invalid session credentials...');
          try {
            if (fs.existsSync(this.sessionDataDirectoryPath)) {
              fs.rmSync(this.sessionDataDirectoryPath, { recursive: true, force: true });
              applicationLogger.success('WhatsApp session directory cleaned up successfully.');
            }
          } catch (sessionCleanupError: unknown) {
            applicationLogger.error(`Failed to clean up WhatsApp session directory: ${sessionCleanupError}`);
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

  public async sendTextMessage(targetChatIdentifier: string, messageText: string): Promise<void> {
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
  }

  public async sendTypingPresence(targetChatIdentifier: string): Promise<void> {
    if (!this.socketInstance) {
      return;
    }

    try {
      await this.socketInstance.sendPresenceUpdate('composing', targetChatIdentifier);
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

    try {
      await this.socketInstance.sendPresenceUpdate('paused', targetChatIdentifier);
    } catch (presenceError: unknown) {
      applicationLogger.fileDetail('warn', 'Failed to clear WhatsApp typing presence update', {
        targetChatIdentifier,
        error: presenceError instanceof Error ? presenceError.message : String(presenceError),
      });
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
