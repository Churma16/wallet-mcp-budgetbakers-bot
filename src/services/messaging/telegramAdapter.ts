import { Bot } from 'grammy';
import axios from 'axios';
import { applicationLogger } from '../../utils/logger.js';
import {
  MessagingAdapter,
  SupportedMessengerChannel,
  UserMessageCallback,
} from './types.js';
import { convertWhatsAppMarkupToTelegramHtml } from './messageFormatHelper.js';

export class TelegramMessagingAdapter implements MessagingAdapter {
  public readonly channelName: SupportedMessengerChannel = 'telegram';
  private botInstance: Bot | null = null;
  private isRunning: boolean = false;
  private readonly normalizedAllowedUserId: string;

  constructor(
    private readonly botToken: string,
    private readonly allowedUserId: string,
    private readonly onUserMessageReceived: UserMessageCallback
  ) {
    this.normalizedAllowedUserId = this.allowedUserId.trim().replace(/^@/, '');
  }

  public async startConnection(): Promise<void> {
    if (this.botInstance) {
      await this.stopConnection();
    }

    if (!this.botToken) {
      throw new Error('[error] TELEGRAM_BOT_TOKEN is not defined.');
    }

    this.botInstance = new Bot(this.botToken);

    // 1. Security Whitelist Middleware
    this.botInstance.use(async (ctx, next) => {
      const senderUserId = ctx.from?.id ? String(ctx.from.id) : '';
      const senderUsername = ctx.from?.username ? ctx.from.username.toLowerCase() : '';

      if (this.normalizedAllowedUserId) {
        const isNumericMatch = senderUserId === this.normalizedAllowedUserId;
        const isUsernameMatch = senderUsername === this.normalizedAllowedUserId.toLowerCase();

        if (!isNumericMatch && !isUsernameMatch) {
          applicationLogger.security(
            `Telegram ignored message from unauthorized user: ${senderUserId} (@${ctx.from?.username || 'unknown'})`
          );
          return;
        }
      }

      await next();
    });

    // 2. Handle Text Messages
    this.botInstance.on('message:text', async ctx => {
      const textContent = ctx.message.text?.trim();
      if (!textContent) {
        return;
      }

      const chatId = String(ctx.chat.id);
      const senderIdentifier = ctx.from?.id ? String(ctx.from.id) : chatId;

      await this.onUserMessageReceived({
        channel: 'telegram',
        chatIdentifier: chatId,
        senderIdentifier,
        messageType: 'text',
        textPayload: textContent,
      });
    });

    // 3. Handle Photo Messages (e.g. Receipt Photo for Vision)
    this.botInstance.on('message:photo', async ctx => {
      const photoVariants = ctx.message.photo;
      if (!photoVariants || photoVariants.length === 0) {
        return;
      }

      const chatId = String(ctx.chat.id);
      const senderIdentifier = ctx.from?.id ? String(ctx.from.id) : chatId;
      const captionText = ctx.message.caption || '';

      try {
        // Pick the highest resolution photo variant (last in array)
        const highestResolutionPhoto = photoVariants[photoVariants.length - 1];
        const fileMetadata = await ctx.api.getFile(highestResolutionPhoto.file_id);

        if (!fileMetadata.file_path) {
          throw new Error('Telegram file_path is unavailable');
        }

        const downloadFileUrl = `https://api.telegram.org/file/bot${this.botToken}/${fileMetadata.file_path}`;
        const fileDownloadResponse = await axios.get<ArrayBuffer>(downloadFileUrl, {
          responseType: 'arraybuffer',
          timeout: 30000,
        });

        const imageBuffer = Buffer.from(fileDownloadResponse.data);

        await this.onUserMessageReceived({
          channel: 'telegram',
          chatIdentifier: chatId,
          senderIdentifier,
          messageType: 'image',
          textPayload: captionText,
          imageBuffer,
          imageMimeType: 'image/jpeg',
        });
      } catch (downloadError: unknown) {
        applicationLogger.error(`Failed to download incoming Telegram photo: ${downloadError}`);
        applicationLogger.fileDetail('error', 'Telegram Media Download Failure', {
          error: downloadError instanceof Error
            ? { name: downloadError.name, message: downloadError.message, stack: downloadError.stack }
            : String(downloadError),
          chatId,
          senderIdentifier,
        });

        await this.sendTextMessage(
          chatId,
          '⚠️ Gagal mengunduh foto struk dari Telegram. Silakan coba kirim ulang ya!'
        );
      }
    });

    // Global Telegram Error Handler
    this.botInstance.catch(botError => {
      applicationLogger.error(`Telegram Bot encountered an unhandled error: ${botError.message}`);
      applicationLogger.fileDetail('error', 'Telegram Bot Internal Error', {
        error: botError instanceof Error
          ? { name: botError.name, message: botError.message, stack: botError.stack }
          : String(botError),
      });
    });

    // 4. Verify Bot Credentials & Start Long Polling
    try {
      const botProfile = await this.botInstance.api.getMe();
      applicationLogger.success(
        `Telegram Bot connected successfully as @${botProfile.username} (${botProfile.first_name})`
      );

      if (this.normalizedAllowedUserId) {
        applicationLogger.security(`Telegram whitelist active. Only responding to: ${this.normalizedAllowedUserId}`);
      } else {
        applicationLogger.warn('TELEGRAM_ALLOWED_USER_ID is not set in .env. The bot will respond to all users.');
      }

      this.isRunning = true;
      this.botInstance.start({
        onStart: () => {
          applicationLogger.info('Telegram Bot polling loop is running and listening for messages.');
        },
      });
    } catch (startError: unknown) {
      this.isRunning = false;
      applicationLogger.error(`Failed to connect to Telegram Bot API: ${startError}`);
      throw startError;
    }
  }

  public async sendTextMessage(targetChatIdentifier: string, messageText: string): Promise<void> {
    if (!this.botInstance) {
      throw new Error('[error] Telegram bot is not initialized');
    }

    const formattedHtmlText = convertWhatsAppMarkupToTelegramHtml(messageText);

    try {
      await this.botInstance.api.sendMessage(targetChatIdentifier, formattedHtmlText, {
        parse_mode: 'HTML',
      });

      applicationLogger.fileDetail('telegram', 'Dispatched Telegram HTML Message', {
        targetChatIdentifier,
        messageLength: messageText.length,
        preview: messageText.substring(0, 120),
      });
    } catch (htmlSendError: unknown) {
      // Fallback: If HTML formatting throws parse error (e.g. unclosed tag), send plain text
      applicationLogger.warn(
        `Telegram HTML parse failed, falling back to plain text for chat ${targetChatIdentifier}: ${htmlSendError}`
      );

      try {
        await this.botInstance.api.sendMessage(targetChatIdentifier, messageText);
        applicationLogger.fileDetail('telegram', 'Dispatched Telegram Plain Text Message (Fallback)', {
          targetChatIdentifier,
          messageLength: messageText.length,
        });
      } catch (fallbackError: unknown) {
        applicationLogger.error(`Failed to send Telegram message to ${targetChatIdentifier}: ${fallbackError}`);
        throw fallbackError;
      }
    }
  }

  public async sendTypingPresence(targetChatIdentifier: string): Promise<void> {
    if (!this.botInstance) {
      return;
    }

    try {
      await this.botInstance.api.sendChatAction(targetChatIdentifier, 'typing');
    } catch (presenceError: unknown) {
      applicationLogger.fileDetail('warn', 'Failed to send Telegram typing action', {
        targetChatIdentifier,
        error: presenceError instanceof Error ? presenceError.message : String(presenceError),
      });
    }
  }

  public async clearTypingPresence(_targetChatIdentifier: string): Promise<void> {
    // Telegram automatically clears typing presence after 5 seconds or upon sending a message
  }

  public async sendBroadcastNotification(messageText: string): Promise<void> {
    if (!this.normalizedAllowedUserId) {
      applicationLogger.warn('Cannot broadcast Telegram notification: TELEGRAM_ALLOWED_USER_ID is not configured.');
      return;
    }

    await this.sendTextMessage(this.normalizedAllowedUserId, messageText);
  }

  public async stopConnection(): Promise<void> {
    if (this.botInstance && this.isRunning) {
      try {
        await this.botInstance.stop();
      } catch (stopError: unknown) {
        applicationLogger.warn(`Error stopping Telegram bot: ${stopError}`);
      }
      this.isRunning = false;
      this.botInstance = null;
    }
  }
}
