import { Bot, GrammyError, HttpError } from 'grammy';
import axios from 'axios';
import { applicationLogger } from '../../utils/logger.js';
import {
  AdapterConnectionState,
  MessagingAdapter,
  SupportedMessengerChannel,
  UserMessageCallback,
} from './types.js';
import { convertWhatsAppMarkupToTelegramHtml } from './messageFormatHelper.js';

export interface TelegramSafeguardConfiguration {
  maxStartupAttempts?: number;
  startupRetryBaseDelayMs?: number;
  startupRetryMaxDelayMs?: number;
}

export class TelegramMessagingAdapter implements MessagingAdapter {
  public readonly channelName: SupportedMessengerChannel = 'telegram';
  private botInstance: Bot | null = null;
  private isRunning: boolean = false;
  private readonly normalizedAllowedUserId: string;

  private readonly maxStartupAttempts: number;
  private readonly startupRetryBaseDelayMs: number;
  private readonly startupRetryMaxDelayMs: number;

  constructor(
    private readonly botToken: string,
    private readonly allowedUserId: string,
    private readonly onUserMessageReceived: UserMessageCallback,
    safeguardConfiguration?: TelegramSafeguardConfiguration
  ) {
    this.normalizedAllowedUserId = this.allowedUserId.trim().replace(/^@/, '');
    this.maxStartupAttempts = safeguardConfiguration?.maxStartupAttempts ?? 5;
    this.startupRetryBaseDelayMs = safeguardConfiguration?.startupRetryBaseDelayMs ?? 2000;
    this.startupRetryMaxDelayMs = safeguardConfiguration?.startupRetryMaxDelayMs ?? 15000;
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
        const rawErrorMessage = downloadError instanceof Error ? downloadError.message : String(downloadError);
        const sanitizedDownloadError = this.botToken
          ? rawErrorMessage.replaceAll(this.botToken, '[REDACTED_TELEGRAM_TOKEN]')
          : rawErrorMessage;
        applicationLogger.error(`Failed to download incoming Telegram photo: ${sanitizedDownloadError}`);
        applicationLogger.fileDetail('error', 'Telegram Media Download Failure', {
          error: downloadError instanceof Error
            ? {
                name: downloadError.name,
                message: this.botToken
                  ? downloadError.message.replaceAll(this.botToken, '[REDACTED_TELEGRAM_TOKEN]')
                  : downloadError.message,
                stack: downloadError.stack
                  ? (this.botToken ? downloadError.stack.replaceAll(this.botToken, '[REDACTED_TELEGRAM_TOKEN]') : downloadError.stack)
                  : undefined,
              }
            : sanitizedDownloadError,
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
      const botProfile = await this.executeWithStartupRetry(
        () => this.botInstance!.api.getMe(),
        'Telegram api.getMe()'
      );
      const safeBotUsername = String(botProfile.username || 'unknown').replace(/[^\w]/g, '');
      const safeBotFirstName = String(botProfile.first_name || 'Bot').replace(/[^\w\s]/g, '');
      applicationLogger.success(
        `Telegram Bot connected successfully as @${safeBotUsername} (${safeBotFirstName})`
      );

      if (this.normalizedAllowedUserId) {
        applicationLogger.security(`Telegram whitelist active. Only responding to: ${this.normalizedAllowedUserId}`);
      } else {
        applicationLogger.warn('TELEGRAM_ALLOWED_USER_ID is not set in .env. The bot will respond to all users.');
      }

      this.isRunning = true;
      const onPollingStarted = (): void => {
        applicationLogger.info('Telegram Bot polling loop is running and listening for messages.');
      };
      this.botInstance.start({
        onStart: onPollingStarted,
      });
    } catch (startError: unknown) {
      this.isRunning = false;
      const rawStartErrorMessage = startError instanceof Error ? startError.message : String(startError);
      const sanitizedStartError = this.botToken
        ? rawStartErrorMessage.replaceAll(this.botToken, '[REDACTED_TELEGRAM_TOKEN]')
        : rawStartErrorMessage;
      applicationLogger.error(`Failed to connect to Telegram Bot API: ${sanitizedStartError}`);
      throw startError;
    }
  }

  public getMaxStartupAttempts(): number {
    return this.maxStartupAttempts;
  }

  public getStartupRetryBaseDelayMs(): number {
    return this.startupRetryBaseDelayMs;
  }

  public getStartupRetryMaxDelayMs(): number {
    return this.startupRetryMaxDelayMs;
  }

  public calculateBackoffDelayMilliseconds(attemptIndex: number): number {
    const exponentialDelay = this.startupRetryBaseDelayMs * Math.pow(2, attemptIndex);
    const boundedDelay = Math.min(this.startupRetryMaxDelayMs, exponentialDelay);
    const randomJitterMilliseconds = Math.floor(Math.random() * 1000) + 500;
    return boundedDelay + randomJitterMilliseconds;
  }

  public isRetryableNetworkError(error: unknown): boolean {
    if (!error) {
      return false;
    }

    if (error instanceof GrammyError) {
      // 401 Unauthorized or 404 Not Found indicates invalid token or non-existent bot
      if (error.error_code === 401 || error.error_code === 404) {
        return false;
      }
      // Rate limits (429) or Telegram internal errors (5xx) are transient and retryable
      if (error.error_code === 429 || error.error_code >= 500) {
        return true;
      }
      return false;
    }

    if (error instanceof HttpError) {
      return true;
    }

    const errorCode = (error as { code?: string })?.code;
    const retryableNetworkCodes = [
      'ECONNRESET',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'ENOTFOUND',
      'ECONNREFUSED',
      'EHOSTUNREACH',
      'EPIPE',
    ];
    if (errorCode && retryableNetworkCodes.includes(errorCode)) {
      return true;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    const retryableSubstrings = [
      'network request for',
      'getaddrinfo',
      'eai_again',
      'econnreset',
      'etimedout',
      'enotfound',
      'socket hang up',
      'timeout',
    ];
    return retryableSubstrings.some(substring =>
      errorMessage.toLowerCase().includes(substring)
    );
  }

  public async executeWithStartupRetry<T>(
    operation: () => Promise<T>,
    operationDescription: string = 'Telegram Bot API initialization'
  ): Promise<T> {
    let lastEncounteredError: unknown;

    for (let attemptIndex = 0; attemptIndex < this.maxStartupAttempts; attemptIndex++) {
      try {
        return await operation();
      } catch (error: unknown) {
        lastEncounteredError = error;
        const isRetryable = this.isRetryableNetworkError(error);

        if (!isRetryable) {
          applicationLogger.error(
            `Non-retryable error encountered during ${operationDescription}: ${error instanceof Error ? error.message : String(error)}`
          );
          throw error;
        }

        const isLastAttempt = attemptIndex === this.maxStartupAttempts - 1;
        if (isLastAttempt) {
          applicationLogger.error(
            `All ${this.maxStartupAttempts} startup attempts exhausted for ${operationDescription}. Final error: ${error instanceof Error ? error.message : String(error)}`
          );
          break;
        }

        const delayMilliseconds = this.calculateBackoffDelayMilliseconds(attemptIndex);
        applicationLogger.warn(
          `[WARN] ${operationDescription} failed (attempt ${attemptIndex + 1}/${this.maxStartupAttempts}): ${error instanceof Error ? error.message : String(error)}. Retrying in ${(delayMilliseconds / 1000).toFixed(1)}s...`
        );

        await new Promise(resolve => setTimeout(resolve, delayMilliseconds));
      }
    }

    throw lastEncounteredError;
  }

  public getConnectionState(): AdapterConnectionState {
    return this.isRunning ? 'connected' : 'idle';
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
