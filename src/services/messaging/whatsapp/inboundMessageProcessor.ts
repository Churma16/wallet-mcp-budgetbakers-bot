import { downloadMediaMessage, proto, WAMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { applicationLogger } from '../../../utils/logger.js';
import { UserMessageCallback } from '../types.js';
import { MessageIdTracker } from './messageIdTracker.js';
import { WhatsappSocketProvider } from './types.js';

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
    const normalizedSenderDigits = senderRawIdentifier.replace(/[^0-9]/g, '');
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
      senderRawIdentifier.replace(/[^0-9]/g, '') === this.normalizedAllowedPhoneNumber;
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
      const botPhoneNumber = socket?.user?.id?.split(':')[0]?.split('@')[0]?.replace(/[^0-9]/g, '') || '';
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
    if (declaredFileLength > this.maxMediaDownloadBytes) {
      await this.rejectOversizedMedia(remoteJid, senderIdentifier, declaredFileLength, 'declaredFileLength');
      return;
    }

    try {
      const imageBuffer = await downloadMediaMessage(rawMessage as WAMessage, 'buffer', {}, {
        logger: pino({ level: 'silent' }), reuploadRequest: socket.updateMediaMessage,
      }) as Buffer;
      if (imageBuffer.length > this.maxMediaDownloadBytes) {
        await this.rejectOversizedMedia(remoteJid, senderIdentifier, imageBuffer.length, 'bufferLength');
        return;
      }
      await this.onUserMessageReceived({
        channel: 'whatsapp', chatIdentifier: remoteJid, senderIdentifier,
        messageType: 'image', textPayload: imageMessage.caption || '', imageBuffer,
        imageMimeType: imageMessage.mimetype || 'image/jpeg',
      });
    } catch (downloadError: unknown) {
      applicationLogger.error(`Failed to download incoming WhatsApp image media from ${senderIdentifier}: ${downloadError}`);
      applicationLogger.fileDetail('error', 'WhatsApp Media Download Failure', {
        remoteJid, senderIdentifier,
        error: downloadError instanceof Error
          ? { name: downloadError.name, message: downloadError.message, stack: downloadError.stack }
          : String(downloadError),
      });
      await this.sendTextMessage(remoteJid, '⚠️ Gagal mengunduh foto struk dari WhatsApp. Silakan coba kirim ulang ya!');
    }
  }

  private async rejectOversizedMedia(
    remoteJid: string,
    senderIdentifier: string,
    actualBytes: number,
    sizeField: 'declaredFileLength' | 'bufferLength'
  ): Promise<void> {
    const maxMegabytes = Math.round(this.maxMediaDownloadBytes / (1024 * 1024));
    applicationLogger.warn(
      `[WARN] WhatsApp image media from ${senderIdentifier} exceeds size limit (${(actualBytes / (1024 * 1024)).toFixed(1)} MB > ${maxMegabytes} MB). Media rejected.`
    );
    applicationLogger.fileDetail('warn', 'WhatsApp Oversized Media Rejected', {
      remoteJid, senderIdentifier, [sizeField]: actualBytes, maxMediaDownloadBytes: this.maxMediaDownloadBytes,
    });
    await this.sendTextMessage(
      remoteJid,
      `⚠️ Ukuran foto melebihi batas maksimal (${maxMegabytes} MB). Silakan kirim foto dengan ukuran lebih kecil ya!`
    );
  }
}
