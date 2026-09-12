import { downloadMediaMessage, proto, WAMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { applicationLogger } from '../../../utils/logger.js';
import { digitsOnly } from '../../../utils/digitNormalization.js';
import { UserMessageCallback } from '../types.js';
import { MessageIdTracker } from './messageIdTracker.js';
import { WhatsappSocketProvider } from './types.js';
import {
  isMediaSizeExceeded,
  rejectOversizedMedia,
  handleMediaDownloadFailure,
  MediaRejectionStage,
} from '../mediaPolicy.js';

export class WhatsappInboundMessageProcessor {
  private readonly incomingMessageIds = new MessageIdTracker();

  constructor(
    private readonly normalizedAllowedPhoneNumber: string,
    private readonly onUserMessageReceived: UserMessageCallback,
    private readonly getSocket: WhatsappSocketProvider,
    private readonly outgoingMessageIds: MessageIdTracker,
    private readonly maxMediaDownloadBytes: number,
    private readonly sendTextMessage: (chatIdentifier: string, text: string) => Promise<void>
  ) {}

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
      (this.normalizedAllowedPhoneNumber && normalizedSenderDigits === this.normalizedAllowedPhoneNumber)
    );
  }

  public isAuthorizedSender(remoteJid: string, isMessageTargetingSelf: boolean): boolean {
    if (isMessageTargetingSelf) {
      return true;
    }
    if (!this.normalizedAllowedPhoneNumber) {
      return false;
    }
    const [senderRawIdentifier, jidDomain] = remoteJid.split('@');
    return jidDomain === 's.whatsapp.net' &&
      digitsOnly(senderRawIdentifier) === this.normalizedAllowedPhoneNumber;
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
      const targetsSelf = this.isTargetingSelf(remoteJid, botPhoneNumber, botLinkedDeviceIdentifier);

      // Provider metadata rejects echoes to other chats. Messages manually sent to the
      // account's own chat remain supported; bot-authored echoes are rejected above by ID.
      if (rawMessage.key?.fromMe && !targetsSelf) {
        continue;
      }

      if (!targetsSelf && !this.isAuthorizedSender(remoteJid, false)) {
        const reason = this.normalizedAllowedPhoneNumber
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
