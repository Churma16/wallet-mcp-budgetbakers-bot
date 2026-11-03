import { Bot, Context, GrammyError, HttpError } from 'grammy';
import axios from 'axios';
import { applicationLogger } from '../lib/logger.js';
import { calculateExponentialBackoff } from '../lib/resilience.js';
import {
  AdapterConnectionState,
  MediaRejectionStage,
  MessagingAdapter,
  SendTextMessageOptions,
  SentMessageReceipt,
  SupportedMessengerChannel,
  TelegramSafeguardConfiguration,
  UserMessageCallback,
} from './types.js';
import {
  handleMediaDownloadFailure,
  isMediaPayloadSizeLimitExceeded,
  isMediaSizeExceeded,
  rejectOversizedMedia,
} from './mediaPolicy.js';
import {
  createTelegramGuideInlineKeyboard,
  createTelegramMainReplyKeyboard,
  getTelegramBotCommands,
  getTelegramGuideTopicContent,
} from './telegramMenu.js';
import {
  escapeHtmlEntities,
  formatTelegramHtml,
  convertWhatsAppMarkupToTelegramHtml,
} from './formatters/telegramFormatter.js';
import { getActiveLanguage } from '../i18n/index.js';

export type { TelegramSafeguardConfiguration };
export { escapeHtmlEntities, formatTelegramHtml, convertWhatsAppMarkupToTelegramHtml };

/**
 * Messaging adapter integrating the Telegram Bot API via Grammy, enforcing fail-closed
 * user authorization, long-polling resilience, interactive menus, and media download protections.
 */
export class TelegramMessagingAdapter implements MessagingAdapter {
  public readonly channelName: SupportedMessengerChannel = 'telegram';
  private botInstance: Bot | null = null;
  private isRunning: boolean = false;
  private readonly normalizedAllowedUserId: string;

  private readonly maxStartupAttempts: number;
  private readonly startupRetryBaseDelayMs: number;
  private readonly startupRetryMaxDelayMs: number;
  private readonly maxMediaDownloadBytes: number;

  constructor(
    private readonly botToken: string,
    private readonly allowedUserId: string,
    private readonly onUserMessageReceived: UserMessageCallback,
    safeguardConfiguration?: TelegramSafeguardConfiguration
  ) {
    const rawAllowedUserId = (this.allowedUserId || '').trim().replace(/^@/, '');
    this.normalizedAllowedUserId = /^\d+$/.test(rawAllowedUserId) ? rawAllowedUserId : '';
    this.maxStartupAttempts = safeguardConfiguration?.maxStartupAttempts ?? 5;
    this.startupRetryBaseDelayMs = safeguardConfiguration?.startupRetryBaseDelayMs ?? 2000;
    this.startupRetryMaxDelayMs = safeguardConfiguration?.startupRetryMaxDelayMs ?? 15000;
    this.maxMediaDownloadBytes = safeguardConfiguration?.maxMediaDownloadBytes ?? (10 * 1024 * 1024);
  }

  public isAuthorizedSender(senderUserId: string, _senderUsername?: string): boolean {
    if (!this.normalizedAllowedUserId) {
      return false;
    }

    const cleanSenderUserId = (senderUserId || '').trim();
    return cleanSenderUserId === this.normalizedAllowedUserId;
  }

  public async handleInboundMiddleware(ctx: Context, next: () => Promise<void>): Promise<void> {
    const senderUserId = ctx.from?.id ? String(ctx.from.id) : '';
    const senderUsername = ctx.from?.username ? ctx.from.username : undefined;

    if (!this.isAuthorizedSender(senderUserId, senderUsername)) {
      if (!this.normalizedAllowedUserId) {
        applicationLogger.security(
          '[SECURITY] Telegram rejected message: TELEGRAM_ALLOWED_USER_ID is not configured or invalid. Fail-closed authorization active.'
        );
      } else {
        applicationLogger.security(
          `[SECURITY] Telegram ignored message from unauthorized user: ${senderUserId} (@${ctx.from?.username || 'unknown'})`
        );
      }

      if (ctx.callbackQuery) {
        try {
          await ctx.answerCallbackQuery({ text: 'Akses ditolak / Unauthorized', show_alert: true });
        } catch {
          // Ignore failure to answer unauthorized callback
        }
      }
      return;
    }

    await next();
  }

  public async startConnection(): Promise<void> {
    if (this.botInstance) {
      await this.stopConnection();
    }

    if (!this.botToken) {
      throw new Error('[error] TELEGRAM_BOT_TOKEN is not defined.');
    }

    this.botInstance = new Bot(this.botToken);
    this.setupBotHandlers(this.botInstance);

    // Verify Bot Credentials & Start Long Polling
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

      // Register official bot commands menu
      try {
        const botCommands = getTelegramBotCommands();
        await this.executeWithStartupRetry(
          () => this.botInstance!.api.setMyCommands(botCommands),
          'Telegram api.setMyCommands()'
        );
        applicationLogger.info(`[INFO] Registered ${botCommands.length} Telegram bot commands successfully.`);
      } catch (setCommandsError: unknown) {
        applicationLogger.warn(
          `[WARN] Failed to register Telegram bot commands: ${setCommandsError instanceof Error ? setCommandsError.message : String(setCommandsError)}`
        );
      }

      if (this.normalizedAllowedUserId) {
        applicationLogger.security(`Telegram whitelist active. Only responding to: ${this.normalizedAllowedUserId}`);
      } else {
        applicationLogger.warn(
          'TELEGRAM_ALLOWED_USER_ID is not set in .env. Inbound Telegram messages will be rejected (fail-closed).'
        );
      }

      this.isRunning = true;
      const onPollingStarted = (): void => {
        applicationLogger.info('Telegram Bot polling loop is running and listening for messages.');
      };
      void this.botInstance
        .start({
          onStart: onPollingStarted,
        })
        .catch((pollingError: unknown) => {
          applicationLogger.error(
            `Telegram Bot polling error: ${pollingError instanceof Error ? pollingError.message : String(pollingError)}`
          );
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

  public getMaxMediaDownloadBytes(): number {
    return this.maxMediaDownloadBytes;
  }

  public calculateBackoffDelayMilliseconds(attemptIndex: number): number {
    return calculateExponentialBackoff({
      attempt: attemptIndex,
      baseMs: this.startupRetryBaseDelayMs,
      maxMs: this.startupRetryMaxDelayMs,
      jitterMinMs: 500,
      jitterMaxMs: 1500,
    });
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

  public async sendTextMessage(
    targetChatIdentifier: string,
    messageText: string,
    options?: SendTextMessageOptions
  ): Promise<SentMessageReceipt> {
    if (!this.botInstance) {
      throw new Error('[error] Telegram bot is not initialized');
    }

    if (options?.isHelpMenu) {
      const currentLanguage = getActiveLanguage();
      const formattedHtmlText = formatTelegramHtml(messageText);
      const replyKeyboard = createTelegramMainReplyKeyboard(currentLanguage);

      try {
        const sentMenu = await this.botInstance.api.sendMessage(targetChatIdentifier, formattedHtmlText, {
          parse_mode: 'HTML',
          reply_markup: replyKeyboard,
        });

        const guideOverview = getTelegramGuideTopicContent('home', currentLanguage);
        if (guideOverview) {
          await this.botInstance.api.sendMessage(targetChatIdentifier, guideOverview.text, {
            parse_mode: 'HTML',
            reply_markup: guideOverview.replyMarkup,
          });
        }

        return { messageId: String(sentMenu.message_id) };
      } catch (htmlSendError: unknown) {
        applicationLogger.warn(
          `Telegram HTML parse failed for help menu, falling back to plain text for chat ${targetChatIdentifier}: ${htmlSendError}`
        );

        const fallbackSent = await this.botInstance.api.sendMessage(targetChatIdentifier, messageText, {
          reply_markup: replyKeyboard,
        });
        return { messageId: String(fallbackSent.message_id) };
      }
    }

    const formattedHtmlText = formatTelegramHtml(messageText);
    const replyMarkup = options?.replyMarkup as any;

    try {
      const sentMessage = await this.botInstance.api.sendMessage(targetChatIdentifier, formattedHtmlText, {
        parse_mode: 'HTML',
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });

      applicationLogger.fileDetail('telegram', 'Dispatched Telegram HTML Message', {
        targetChatIdentifier,
        messageLength: messageText.length,
        preview: messageText.substring(0, 120),
      });

      return { messageId: String(sentMessage.message_id) };
    } catch (htmlSendError: unknown) {
      // Fallback: If HTML formatting throws parse error (e.g. unclosed tag), send plain text
      applicationLogger.warn(
        `Telegram HTML parse failed, falling back to plain text for chat ${targetChatIdentifier}: ${htmlSendError}`
      );

      try {
        const fallbackSent = await this.botInstance.api.sendMessage(targetChatIdentifier, messageText, {
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
        applicationLogger.fileDetail('telegram', 'Dispatched Telegram Plain Text Message (Fallback)', {
          targetChatIdentifier,
          messageLength: messageText.length,
        });

        return { messageId: String(fallbackSent.message_id) };
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

  public async sendBroadcastNotification(messageText: string): Promise<SentMessageReceipt | void> {
    if (!this.normalizedAllowedUserId) {
      applicationLogger.warn('Cannot broadcast Telegram notification: TELEGRAM_ALLOWED_USER_ID is not configured.');
      return;
    }

    return await this.sendTextMessage(this.normalizedAllowedUserId, messageText);
  }

  public async editBroadcastNotification(
    messageId: string,
    messageText: string
  ): Promise<boolean> {
    if (!this.botInstance || !this.normalizedAllowedUserId) {
      return false;
    }

    const numericMessageId = Number(messageId);
    if (!Number.isFinite(numericMessageId)) {
      return false;
    }

    const formattedHtmlText = formatTelegramHtml(messageText);

    try {
      await this.botInstance.api.editMessageText(
        this.normalizedAllowedUserId,
        numericMessageId,
        formattedHtmlText,
        { parse_mode: 'HTML' }
      );
      return true;
    } catch (htmlEditError: unknown) {
      const errorMessage = htmlEditError instanceof Error ? htmlEditError.message : String(htmlEditError);
      if (errorMessage.includes('message is not modified')) {
        return true;
      }

      applicationLogger.warn(
        `Telegram HTML edit failed, trying plain text fallback for message ${messageId}: ${htmlEditError}`
      );

      try {
        await this.botInstance.api.editMessageText(
          this.normalizedAllowedUserId,
          numericMessageId,
          messageText
        );
        return true;
      } catch (fallbackEditError: unknown) {
        applicationLogger.warn(
          `Telegram plain text edit also failed for message ${messageId}: ${fallbackEditError}`
        );
        return false;
      }
    }
  }

  public setupBotHandlers(bot: Bot): void {
    // 1. Security Whitelist Middleware
    bot.use(async (ctx, next) => {
      await this.handleInboundMiddleware(ctx, next);
    });

    // 2. Handle Interactive Guide Callback Queries
    bot.on('callback_query:data', async ctx => {
      const callbackData = ctx.callbackQuery.data;
      if (!callbackData) {
        await ctx.answerCallbackQuery();
        return;
      }

      if (callbackData.startsWith('guide:')) {
        const topic = callbackData.replace('guide:', '');
        const currentLanguage = getActiveLanguage();
        const guideContent = getTelegramGuideTopicContent(topic, currentLanguage);
        if (guideContent) {
          try {
            await ctx.editMessageText(guideContent.text, {
              parse_mode: 'HTML',
              reply_markup: guideContent.replyMarkup,
            });
          } catch (editError: unknown) {
            applicationLogger.fileDetail('telegram', 'Guide message edit unchanged or ignored', {
              error: editError instanceof Error ? editError.message : String(editError),
            });
          }
        }
        await ctx.answerCallbackQuery();
      } else {
        await ctx.answerCallbackQuery();
      }
    });

    // 3. Handle Text Messages
    bot.on('message:text', async ctx => {
      const textContent = ctx.message.text?.trim();
      if (!textContent) {
        return;
      }

      const chatId = String(ctx.chat.id);
      const senderIdentifier = ctx.from?.id ? String(ctx.from.id) : chatId;
      const replyTo = ctx.message.reply_to_message;
      const replyToMessageId = replyTo ? String(replyTo.message_id) : undefined;
      const replyToMessageText = replyTo?.text || replyTo?.caption || undefined;

      await this.onUserMessageReceived({
        channel: 'telegram',
        chatIdentifier: chatId,
        senderIdentifier,
        messageType: 'text',
        textPayload: textContent,
        replyToMessageId,
        replyToMessageText,
      });
    });

    // 4. Handle Photo Messages (e.g. Receipt Photo for Vision)
    bot.on('message:photo', async ctx => {
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

        if (
          highestResolutionPhoto.file_size &&
          isMediaSizeExceeded(highestResolutionPhoto.file_size, this.maxMediaDownloadBytes)
        ) {
          await this.rejectOversizedPhoto(
            chatId,
            senderIdentifier,
            highestResolutionPhoto.file_size,
            'declared_size'
          );
          return;
        }

        const fileMetadata = await ctx.api.getFile(highestResolutionPhoto.file_id);

        if (!fileMetadata.file_path) {
          throw new Error('Telegram file_path is unavailable');
        }

        if (
          fileMetadata.file_size &&
          isMediaSizeExceeded(fileMetadata.file_size, this.maxMediaDownloadBytes)
        ) {
          await this.rejectOversizedPhoto(
            chatId,
            senderIdentifier,
            fileMetadata.file_size,
            'metadata'
          );
          return;
        }

        const downloadFileUrl = `https://api.telegram.org/file/bot${this.botToken}/${fileMetadata.file_path}`;
        const fileDownloadResponse = await axios.get<ArrayBuffer>(downloadFileUrl, {
          responseType: 'arraybuffer',
          timeout: 30000,
          maxContentLength: this.maxMediaDownloadBytes,
          maxBodyLength: this.maxMediaDownloadBytes,
        });

        const imageBuffer = Buffer.from(fileDownloadResponse.data);

        if (isMediaSizeExceeded(imageBuffer.length, this.maxMediaDownloadBytes)) {
          await this.rejectOversizedPhoto(
            chatId,
            senderIdentifier,
            imageBuffer.length,
            'buffer'
          );
          return;
        }

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
        if (isMediaPayloadSizeLimitExceeded(downloadError)) {
          await this.rejectOversizedPhoto(
            chatId,
            senderIdentifier,
            undefined,
            'download_stream',
            {
              error:
                downloadError instanceof Error
                  ? { name: downloadError.name, message: downloadError.message }
                  : String(downloadError),
            }
          );
          return;
        }

        await handleMediaDownloadFailure({
          channel: 'telegram',
          chatIdentifier: chatId,
          senderIdentifier,
          downloadError,
          sendTextMessage: async (targetChatIdentifier, messageText) => {
            await this.sendTextMessage(targetChatIdentifier, messageText);
          },
          redactToken: this.botToken,
        });
      }
    });

    // Global Telegram Error Handler
    bot.catch(botError => {
      applicationLogger.error(`Telegram Bot encountered an unhandled error: ${botError.message}`);
      applicationLogger.fileDetail('error', 'Telegram Bot Internal Error', {
        error: botError instanceof Error
          ? { name: botError.name, message: botError.message, stack: botError.stack }
          : String(botError),
      });
    });
  }

  private async rejectOversizedPhoto(
    chatIdentifier: string,
    senderIdentifier: string,
    actualBytes: number | undefined,
    rejectionStage: MediaRejectionStage,
    additionalMetadata?: Record<string, unknown>
  ): Promise<void> {
    await rejectOversizedMedia({
      channel: 'telegram',
      chatIdentifier,
      senderIdentifier,
      maxMediaDownloadBytes: this.maxMediaDownloadBytes,
      actualBytes,
      rejectionStage,
      sendTextMessage: async (targetChatIdentifier, messageText) => {
        await this.sendTextMessage(targetChatIdentifier, messageText);
      },
      additionalMetadata,
    });
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
