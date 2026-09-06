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
        console.log('\n[info] WhatsApp Pairing QR Code Generated. Please scan with WhatsApp:\n');
        qrcodeTerminal.generate(qr, { small: true });
        console.log('[hint] Open WhatsApp -> Linked Devices -> Link a Device and scan the QR code above.\n');
      }

      if (connection === 'close') {
        const disconnectStatusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = disconnectStatusCode !== DisconnectReason.loggedOut;

        console.log(`[warn] Connection closed due to: ${lastDisconnect?.error}, reconnecting: ${shouldReconnect}`);

        if (shouldReconnect && !this.isReconnecting) {
          this.isReconnecting = true;
          setTimeout(() => {
            this.isReconnecting = false;
            this.startConnection();
          }, 5000);
        } else if (!shouldReconnect) {
          console.log('[info] Device logged out. Please restart the bot to re-authenticate with a new QR code.');
        }
      } else if (connection === 'open') {
        console.log('[success] WhatsApp connection successfully established and ready!');
        if (this.allowedPhoneNumber) {
          console.log(`[security] Whitelist active. Only responding to: ${this.allowedPhoneNumber}`);
        } else {
          console.log('[warn] ALLOWED_PHONE_NUMBER is not set in .env. The bot will respond to all private chats.');
        }
      }
    });

    // Handle incoming messages
    this.socketInstance.ev.on('messages.upsert', async messageUpsertEvent => {
      const incomingMessageList = messageUpsertEvent.messages;

      for (const rawMessage of incomingMessageList) {
        // Skip messages sent by the bot itself
        if (rawMessage.key.fromMe) {
          continue;
        }

        const remoteJid = rawMessage.key.remoteJid;
        if (!remoteJid || remoteJid === 'status@broadcast') {
          continue;
        }

        // Extract sender phone number (strip '@s.whatsapp.net' or group notation)
        const senderPhoneNumber = remoteJid.split('@')[0];

        // Apply whitelist check if configured
        if (this.allowedPhoneNumber && !remoteJid.includes(this.allowedPhoneNumber)) {
          console.log(`[security] Ignored message from unauthorized sender: ${senderPhoneNumber}`);
          continue;
        }

        await this.handleIncomingMessage(rawMessage, remoteJid, senderPhoneNumber);
      }
    });
  }

  /**
   * Internal parser for incoming raw message
   */
  private async handleIncomingMessage(
    rawMessage: proto.IWebMessageInfo,
    remoteJid: string,
    senderPhoneNumber: string
  ): Promise<void> {
    const messageContent = rawMessage.message;
    if (!messageContent) return;

    // 1. Text Message
    const textBody = messageContent.conversation || messageContent.extendedTextMessage?.text;
    if (textBody && textBody.trim().length > 0) {
      await this.onUserMessageReceived({
        remoteJid,
        senderPhoneNumber,
        messageType: 'text',
        textPayload: textBody.trim(),
      });
      return;
    }

    // 2. Image Message (e.g. Receipt Photo)
    if (messageContent.imageMessage && this.socketInstance) {
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

        const imageCaption = messageContent.imageMessage.caption || '';
        const imageMimeType = messageContent.imageMessage.mimetype || 'image/jpeg';

        await this.onUserMessageReceived({
          remoteJid,
          senderPhoneNumber,
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
