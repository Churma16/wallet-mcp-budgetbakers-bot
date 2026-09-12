import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { Bot } from 'grammy';
import {
  formatBytesToMegabytes,
  formatBytesToMegabytesDisplay,
  isMediaSizeExceeded,
  isMediaPayloadSizeLimitExceeded,
  getChannelDisplayName,
  formatMediaTooLargeMessage,
  formatMediaDownloadFailedMessage,
  rejectOversizedMedia,
  handleMediaDownloadFailure,
} from '../src/services/messaging/mediaPolicy.js';
import { TelegramMessagingAdapter } from '../src/services/messaging/telegramAdapter.js';
import { WhatsappInboundMessageProcessor } from '../src/services/messaging/whatsapp/inboundMessageProcessor.js';
import { MessageIdTracker } from '../src/services/messaging/whatsapp/messageIdTracker.js';
import { setActiveLanguage, getActiveLanguage, SupportedLanguage } from '../src/i18n/index.js';
import { applicationLogger } from '../src/utils/logger.js';

describe('Cross-Channel Media Handling (Issue #109)', () => {
  let originalLanguage: SupportedLanguage;

  beforeEach(() => {
    originalLanguage = getActiveLanguage();
    setActiveLanguage('id');
  });

  afterEach(() => {
    setActiveLanguage(originalLanguage);
    vi.restoreAllMocks();
  });

  describe('Byte & Megabyte Size Evaluation Primitives', () => {
    it('accurately rounds bytes to megabytes with formatBytesToMegabytes', () => {
      expect(formatBytesToMegabytes(10 * 1024 * 1024)).toBe(10);
      expect(formatBytesToMegabytes(5 * 1024 * 1024)).toBe(5);
      expect(formatBytesToMegabytes(15.4 * 1024 * 1024)).toBe(15);
      expect(formatBytesToMegabytes(15.8 * 1024 * 1024)).toBe(16);
      expect(formatBytesToMegabytes(0)).toBe(0);
      expect(formatBytesToMegabytes(-1024)).toBe(0);
    });

    it('formats decimal megabytes display accurately with formatBytesToMegabytesDisplay', () => {
      expect(formatBytesToMegabytesDisplay(12 * 1024 * 1024, 1)).toBe('12.0');
      expect(formatBytesToMegabytesDisplay(1536 * 1024, 1)).toBe('1.5');
      expect(formatBytesToMegabytesDisplay(0, 1)).toBe('0.0');
      expect(formatBytesToMegabytesDisplay(-500, 2)).toBe('0.00');
    });

    it('evaluates size limit violations with isMediaSizeExceeded', () => {
      const maxLimitBytes = 10 * 1024 * 1024; // 10 MB
      expect(isMediaSizeExceeded(11 * 1024 * 1024, maxLimitBytes)).toBe(true);
      expect(isMediaSizeExceeded(10 * 1024 * 1024, maxLimitBytes)).toBe(false);
      expect(isMediaSizeExceeded(9 * 1024 * 1024, maxLimitBytes)).toBe(false);
      expect(isMediaSizeExceeded(0, maxLimitBytes)).toBe(false);
      expect(isMediaSizeExceeded(-100, maxLimitBytes)).toBe(false);
    });
  });

  describe('Payload Limit Error Classification (isMediaPayloadSizeLimitExceeded)', () => {
    it('detects Axios ERR_FR_MAX_BODY_LENGTH_EXCEEDED error codes', () => {
      const simulatedAxiosError = {
        isAxiosError: true,
        code: 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED',
        message: 'maxContentLength size of 10485760 exceeded',
      };
      expect(isMediaPayloadSizeLimitExceeded(simulatedAxiosError)).toBe(true);
    });

    it('detects generic stream errors carrying ERR_FR_MAX_BODY_LENGTH_EXCEEDED code', () => {
      const genericStreamError = {
        code: 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED',
        message: 'Stream size threshold passed',
      };
      expect(isMediaPayloadSizeLimitExceeded(genericStreamError)).toBe(true);
    });

    it('detects error message substrings referencing maxcontentlength or maxbodylength', () => {
      const lengthException = new Error('Client error: maxContentLength exceeded limit of 10MB');
      const bodyException = new Error('HTTP response maxBodyLength limit reached');
      expect(isMediaPayloadSizeLimitExceeded(lengthException)).toBe(true);
      expect(isMediaPayloadSizeLimitExceeded(bodyException)).toBe(true);
    });

    it('returns false for transient network errors and normal operational errors', () => {
      expect(isMediaPayloadSizeLimitExceeded(new Error('ECONNRESET: connection reset by peer'))).toBe(false);
      expect(isMediaPayloadSizeLimitExceeded(new Error('ETIMEDOUT: connection timed out'))).toBe(false);
      expect(isMediaPayloadSizeLimitExceeded(new Error('404 Not Found'))).toBe(false);
      expect(isMediaPayloadSizeLimitExceeded(null)).toBe(false);
      expect(isMediaPayloadSizeLimitExceeded(undefined)).toBe(false);
    });
  });

  describe('Channel Display Name Normalization', () => {
    it('normalizes recognized channel names into standard human display titles', () => {
      expect(getChannelDisplayName('whatsapp')).toBe('WhatsApp');
      expect(getChannelDisplayName('telegram')).toBe('Telegram');
      expect(getChannelDisplayName('console')).toBe('Console');
      expect(getChannelDisplayName('custom_channel')).toBe('custom_channel');
    });
  });

  describe('i18n Localization for Media Messages', () => {
    it('formats localized oversized media warning in Indonesian', () => {
      setActiveLanguage('id');
      const formattedIndonesianMessage = formatMediaTooLargeMessage(10 * 1024 * 1024);
      expect(formattedIndonesianMessage).toContain('Ukuran foto melebihi batas maksimal (10 MB)');
      expect(formattedIndonesianMessage).toContain('Silakan kirim foto dengan ukuran lebih kecil ya!');
    });

    it('formats localized oversized media warning in English', () => {
      setActiveLanguage('en');
      const formattedEnglishMessage = formatMediaTooLargeMessage(10 * 1024 * 1024);
      expect(formattedEnglishMessage).toContain('Photo size exceeds the maximum limit (10 MB)');
      expect(formattedEnglishMessage).toContain('Please send a smaller photo!');
    });

    it('formats localized media download failure in Indonesian for both channels', () => {
      setActiveLanguage('id');
      const telegramNotice = formatMediaDownloadFailedMessage('telegram');
      const whatsappNotice = formatMediaDownloadFailedMessage('whatsapp');

      expect(telegramNotice).toBe('⚠️ Gagal mengunduh foto struk dari Telegram. Silakan coba kirim ulang ya!');
      expect(whatsappNotice).toBe('⚠️ Gagal mengunduh foto struk dari WhatsApp. Silakan coba kirim ulang ya!');
    });

    it('formats localized media download failure in English for both channels', () => {
      setActiveLanguage('en');
      const telegramNotice = formatMediaDownloadFailedMessage('telegram');
      const whatsappNotice = formatMediaDownloadFailedMessage('whatsapp');

      expect(telegramNotice).toBe('⚠️ Failed to download receipt photo from Telegram. Please try sending it again!');
      expect(whatsappNotice).toBe('⚠️ Failed to download receipt photo from WhatsApp. Please try sending it again!');
    });
  });

  describe('Shared rejectOversizedMedia Policy Execution', () => {
    it('dispatches warning logs and sends localized message to the user', async () => {
      const warnSpy = vi.spyOn(applicationLogger, 'warn').mockImplementation(() => {});
      const fileDetailSpy = vi.spyOn(applicationLogger, 'fileDetail').mockImplementation(() => {});
      const sentMessages: string[] = [];

      await rejectOversizedMedia({
        channel: 'whatsapp',
        chatIdentifier: '6281234567890@s.whatsapp.net',
        senderIdentifier: '6281234567890',
        maxMediaDownloadBytes: 5 * 1024 * 1024,
        actualBytes: 8 * 1024 * 1024,
        rejectionStage: 'declared_size',
        sendTextMessage: async (_chatIdentifier, messageText) => {
          sentMessages.push(messageText);
        },
      });

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('Ukuran foto melebihi batas maksimal (5 MB)');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[WARN] WhatsApp image media from 6281234567890 exceeds size limit (8.0 MB > 5 MB)')
      );
      expect(fileDetailSpy).toHaveBeenCalledWith(
        'warn',
        'WhatsApp Oversized Media Rejected',
        expect.objectContaining({
          channel: 'whatsapp',
          rejectionStage: 'declared_size',
          actualBytes: 8 * 1024 * 1024,
          maxMediaDownloadBytes: 5 * 1024 * 1024,
        })
      );
    });

    it('handles stream size rejection without actualBytes gracefully', async () => {
      const warnSpy = vi.spyOn(applicationLogger, 'warn').mockImplementation(() => {});
      const sentMessages: string[] = [];

      await rejectOversizedMedia({
        channel: 'telegram',
        chatIdentifier: '123456789',
        senderIdentifier: '123456789',
        maxMediaDownloadBytes: 10 * 1024 * 1024,
        rejectionStage: 'download_stream',
        sendTextMessage: async (_chatIdentifier, messageText) => {
          sentMessages.push(messageText);
        },
      });

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('Ukuran foto melebihi batas maksimal (10 MB)');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[WARN] Telegram image media from 123456789 rejected due to payload size limit exceeding 10 MB')
      );
    });
  });

  describe('Shared handleMediaDownloadFailure Policy Execution', () => {
    it('redacts sensitive tokens from error logging and sends localized notice', async () => {
      const errorSpy = vi.spyOn(applicationLogger, 'error').mockImplementation(() => {});
      const fileDetailSpy = vi.spyOn(applicationLogger, 'fileDetail').mockImplementation(() => {});
      const sentMessages: string[] = [];
      const sensitiveToken = 'SECRET_TELEGRAM_BOT_TOKEN_123';

      const downloadError = new Error(`Request failed: https://api.telegram.org/file/bot${sensitiveToken}/photos/pic.jpg timed out`);

      await handleMediaDownloadFailure({
        channel: 'telegram',
        chatIdentifier: '987654321',
        senderIdentifier: '987654321',
        downloadError,
        sendTextMessage: async (_chatIdentifier, messageText) => {
          sentMessages.push(messageText);
        },
        redactToken: sensitiveToken,
      });

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toBe('⚠️ Gagal mengunduh foto struk dari Telegram. Silakan coba kirim ulang ya!');

      expect(errorSpy).toHaveBeenCalledWith(
        expect.not.stringContaining(sensitiveToken)
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[REDACTED_TOKEN]')
      );
      expect(fileDetailSpy).toHaveBeenCalledWith(
        'error',
        'Telegram Media Download Failure',
        expect.objectContaining({
          channel: 'telegram',
          error: expect.objectContaining({
            message: expect.stringContaining('[REDACTED_TOKEN]'),
          }),
        })
      );
    });
  });

  describe('Telegram Adapter Integration', () => {
    const dummyToken = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ';
    const dummyUserId = '123456789';
    const dummyBotInfo = {
      id: 123456789,
      is_bot: true as const,
      first_name: 'TestBot',
      username: 'test_bot',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    };

    it('rejects oversized photo variants pre-download without triggering getFile or axios', async () => {
      const sentMessages: string[] = [];
      const receivedEvents: any[] = [];

      const adapter = new TelegramMessagingAdapter(
        dummyToken,
        dummyUserId,
        async event => { receivedEvents.push(event); },
        { maxMediaDownloadBytes: 5 * 1024 * 1024 }
      );
      vi.spyOn(adapter, 'sendTextMessage').mockImplementation(async (_chatId, text) => {
        sentMessages.push(text);
      });

      const bot = new Bot(dummyToken, { botInfo: dummyBotInfo });
      adapter.setupBotHandlers(bot);
      let getFileCalled = false;
      bot.api.config.use(async (prev, method, payload, signal) => {
        if (method === 'getFile') {
          getFileCalled = true;
          return {
            ok: true,
            result: { file_id: 'any', file_unique_id: 'u1', file_path: 'p.jpg', file_size: 100 } as any,
          };
        }
        return prev(method, payload, signal);
      });
      const axiosGetSpy = vi.spyOn(axios, 'get');

      const oversizedPhotoUpdate = {
        update_id: 1,
        message: {
          message_id: 101,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(dummyUserId), type: 'private' as const },
          from: { id: Number(dummyUserId), is_bot: false, first_name: 'Owner' },
          photo: [
            { file_id: 'small-id', file_unique_id: 'u1', width: 100, height: 100, file_size: 500 },
            { file_id: 'oversized-id', file_unique_id: 'u2', width: 1200, height: 1200, file_size: 6 * 1024 * 1024 },
          ],
        },
      };

      await bot.handleUpdate(oversizedPhotoUpdate);

      expect(getFileCalled).toBe(false);
      expect(axiosGetSpy).not.toHaveBeenCalled();
      expect(receivedEvents).toHaveLength(0);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('Ukuran foto melebihi batas maksimal (5 MB)');
    });

    it('rejects oversized photo when fileMetadata exceeds limit', async () => {
      const sentMessages: string[] = [];
      const receivedEvents: any[] = [];

      const adapter = new TelegramMessagingAdapter(
        dummyToken,
        dummyUserId,
        async event => { receivedEvents.push(event); },
        { maxMediaDownloadBytes: 5 * 1024 * 1024 }
      );
      vi.spyOn(adapter, 'sendTextMessage').mockImplementation(async (_chatId, text) => {
        sentMessages.push(text);
      });

      const bot = new Bot(dummyToken, { botInfo: dummyBotInfo });
      adapter.setupBotHandlers(bot);
      bot.api.config.use(async (prev, method, payload, signal) => {
        if (method === 'getFile') {
          return {
            ok: true,
            result: {
              file_id: 'large-meta-id',
              file_unique_id: 'u2',
              file_path: 'photos/large.jpg',
              file_size: 10 * 1024 * 1024,
            } as any,
          };
        }
        return prev(method, payload, signal);
      });
      const axiosGetSpy = vi.spyOn(axios, 'get');

      const photoUpdate = {
        update_id: 2,
        message: {
          message_id: 102,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(dummyUserId), type: 'private' as const },
          from: { id: Number(dummyUserId), is_bot: false, first_name: 'Owner' },
          photo: [
            { file_id: 'large-meta-id', file_unique_id: 'u2', width: 800, height: 800, file_size: 1000 },
          ],
        },
      };

      await bot.handleUpdate(photoUpdate);

      expect(axiosGetSpy).not.toHaveBeenCalled();
      expect(receivedEvents).toHaveLength(0);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('Ukuran foto melebihi batas maksimal (5 MB)');
    });

    it('handles stream limit payload error in axios download as oversized media', async () => {
      const sentMessages: string[] = [];
      const receivedEvents: any[] = [];

      const adapter = new TelegramMessagingAdapter(
        dummyToken,
        dummyUserId,
        async event => { receivedEvents.push(event); },
        { maxMediaDownloadBytes: 10 * 1024 * 1024 }
      );
      vi.spyOn(adapter, 'sendTextMessage').mockImplementation(async (_chatId, text) => {
        sentMessages.push(text);
      });

      const bot = new Bot(dummyToken, { botInfo: dummyBotInfo });
      adapter.setupBotHandlers(bot);
      bot.api.config.use(async (prev, method, payload, signal) => {
        if (method === 'getFile') {
          return {
            ok: true,
            result: {
              file_id: 'stream-id',
              file_unique_id: 'u3',
              file_path: 'photos/stream.jpg',
              file_size: 2000,
            } as any,
          };
        }
        return prev(method, payload, signal);
      });
      vi.spyOn(axios, 'get').mockRejectedValue({
        isAxiosError: true,
        code: 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED',
        message: 'maxContentLength size of 10485760 exceeded',
      });

      const photoUpdate = {
        update_id: 3,
        message: {
          message_id: 103,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(dummyUserId), type: 'private' as const },
          from: { id: Number(dummyUserId), is_bot: false, first_name: 'Owner' },
          photo: [
            { file_id: 'stream-id', file_unique_id: 'u3', width: 800, height: 800, file_size: 2000 },
          ],
        },
      };

      await bot.handleUpdate(photoUpdate);

      expect(receivedEvents).toHaveLength(0);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('Ukuran foto melebihi batas maksimal (10 MB)');
    });

    it('handles normal photo download failure with bot token redaction and failure notice', async () => {
      const sentMessages: string[] = [];
      const receivedEvents: any[] = [];
      const errorLoggerSpy = vi.spyOn(applicationLogger, 'error').mockImplementation(() => {});

      const adapter = new TelegramMessagingAdapter(
        dummyToken,
        dummyUserId,
        async event => { receivedEvents.push(event); },
        { maxMediaDownloadBytes: 10 * 1024 * 1024 }
      );
      vi.spyOn(adapter, 'sendTextMessage').mockImplementation(async (_chatId, text) => {
        sentMessages.push(text);
      });

      const bot = new Bot(dummyToken, { botInfo: dummyBotInfo });
      adapter.setupBotHandlers(bot);
      bot.api.config.use(async (prev, method, payload, signal) => {
        if (method === 'getFile') {
          return {
            ok: true,
            result: {
              file_id: 'fail-id',
              file_unique_id: 'u4',
              file_path: 'photos/fail.jpg',
              file_size: 2000,
            } as any,
          };
        }
        return prev(method, payload, signal);
      });
      vi.spyOn(axios, 'get').mockRejectedValue(
        new Error(`connect ETIMEDOUT https://api.telegram.org/file/bot${dummyToken}/photos/fail.jpg`)
      );

      const photoUpdate = {
        update_id: 4,
        message: {
          message_id: 104,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(dummyUserId), type: 'private' as const },
          from: { id: Number(dummyUserId), is_bot: false, first_name: 'Owner' },
          photo: [
            { file_id: 'fail-id', file_unique_id: 'u4', width: 800, height: 800, file_size: 2000 },
          ],
        },
      };

      await bot.handleUpdate(photoUpdate);

      expect(receivedEvents).toHaveLength(0);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toBe('⚠️ Gagal mengunduh foto struk dari Telegram. Silakan coba kirim ulang ya!');

      expect(errorLoggerSpy).toHaveBeenCalledWith(expect.not.stringContaining(dummyToken));
      expect(errorLoggerSpy).toHaveBeenCalledWith(expect.stringContaining('[REDACTED_TOKEN]'));
    });

    it('rejects oversized downloaded buffer in Telegram adapter', async () => {
      const sentMessages: string[] = [];
      const receivedEvents: any[] = [];

      const adapter = new TelegramMessagingAdapter(
        dummyToken,
        dummyUserId,
        async event => { receivedEvents.push(event); },
        { maxMediaDownloadBytes: 5 * 1024 * 1024 }
      );
      vi.spyOn(adapter, 'sendTextMessage').mockImplementation(async (_chatId, text) => {
        sentMessages.push(text);
      });

      const bot = new Bot(dummyToken, { botInfo: dummyBotInfo });
      adapter.setupBotHandlers(bot);
      bot.api.config.use(async (prev, method, payload, signal) => {
        if (method === 'getFile') {
          return {
            ok: true,
            result: {
              file_id: 'buffer-id',
              file_unique_id: 'u5',
              file_path: 'photos/buffer.jpg',
              file_size: 1000,
            } as any,
          };
        }
        return prev(method, payload, signal);
      });
      vi.spyOn(axios, 'get').mockResolvedValue({
        data: Buffer.alloc(8 * 1024 * 1024),
      });

      const photoUpdate = {
        update_id: 5,
        message: {
          message_id: 105,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(dummyUserId), type: 'private' as const },
          from: { id: Number(dummyUserId), is_bot: false, first_name: 'Owner' },
          photo: [
            { file_id: 'buffer-id', file_unique_id: 'u5', width: 800, height: 800, file_size: 1000 },
          ],
        },
      };

      await bot.handleUpdate(photoUpdate);

      expect(receivedEvents).toHaveLength(0);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('Ukuran foto melebihi batas maksimal (5 MB)');
    });

    it('successfully downloads and delivers photo within size limits', async () => {
      const sentMessages: string[] = [];
      const receivedEvents: any[] = [];

      const adapter = new TelegramMessagingAdapter(
        dummyToken,
        dummyUserId,
        async event => { receivedEvents.push(event); },
        { maxMediaDownloadBytes: 10 * 1024 * 1024 }
      );
      vi.spyOn(adapter, 'sendTextMessage').mockImplementation(async (_chatId, text) => {
        sentMessages.push(text);
      });

      const bot = new Bot(dummyToken, { botInfo: dummyBotInfo });
      adapter.setupBotHandlers(bot);
      bot.api.config.use(async (prev, method, payload, signal) => {
        if (method === 'getFile') {
          return {
            ok: true,
            result: {
              file_id: 'success-id',
              file_unique_id: 'u6',
              file_path: 'photos/success.jpg',
              file_size: 2048,
            } as any,
          };
        }
        return prev(method, payload, signal);
      });
      const sampleImageData = Buffer.from('mock-jpeg-binary-data');
      vi.spyOn(axios, 'get').mockResolvedValue({
        data: sampleImageData,
      });

      const photoUpdate = {
        update_id: 6,
        message: {
          message_id: 106,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(dummyUserId), type: 'private' as const },
          from: { id: Number(dummyUserId), is_bot: false, first_name: 'Owner' },
          photo: [
            { file_id: 'success-id', file_unique_id: 'u6', width: 800, height: 800, file_size: 2048 },
          ],
          caption: 'Lunch Receipt',
        },
      };

      await bot.handleUpdate(photoUpdate);

      expect(sentMessages).toHaveLength(0);
      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0]).toMatchObject({
        channel: 'telegram',
        messageType: 'image',
        textPayload: 'Lunch Receipt',
        imageBuffer: sampleImageData,
        imageMimeType: 'image/jpeg',
      });
    });
  });

  describe('WhatsApp Inbound Message Processor Integration', () => {
    it('rejects oversized declared media pre-download using localized message', async () => {
      const sentMessages: string[] = [];
      const receivedEvents: unknown[] = [];
      const outgoingTracker = new MessageIdTracker();

      const processor = new WhatsappInboundMessageProcessor(
        '6281234567890',
        async event => {
          receivedEvents.push(event);
        },
        () => ({
          user: { id: '6281234567890:1@s.whatsapp.net' },
          updateMediaMessage: async () => {},
        } as any),
        outgoingTracker,
        5 * 1024 * 1024,
        async (_chatId, text) => {
          sentMessages.push(text);
        }
      );

      const oversizedDeclaredMessage = {
        key: {
          remoteJid: '6281234567890@s.whatsapp.net',
          id: 'oversized-msg-001',
          fromMe: false,
        },
        message: {
          imageMessage: {
            fileLength: 15 * 1024 * 1024,
            mimetype: 'image/jpeg',
            caption: 'Oversized Receipt',
          },
        },
      };

      await processor.process([oversizedDeclaredMessage]);

      expect(receivedEvents).toHaveLength(0);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('Ukuran foto melebihi batas maksimal (5 MB)');
    });

    it('handles download failure during WhatsApp image download and dispatches localized notice', async () => {
      const sentMessages: string[] = [];
      const receivedEvents: unknown[] = [];
      const outgoingTracker = new MessageIdTracker();

      const processor = new WhatsappInboundMessageProcessor(
        '6281234567890',
        async event => {
          receivedEvents.push(event);
        },
        () => ({
          user: { id: '6281234567890:1@s.whatsapp.net' },
          updateMediaMessage: async () => {},
        } as any),
        outgoingTracker,
        10 * 1024 * 1024,
        async (_chatId, text) => {
          sentMessages.push(text);
        }
      );

      const failingImageMessage = {
        key: {
          remoteJid: '6281234567890@s.whatsapp.net',
          id: 'failing-image-msg-001',
          fromMe: false,
        },
        message: {
          imageMessage: {
            fileLength: 5000,
            mimetype: 'image/jpeg',
            caption: 'Receipt that will fail download',
          },
        },
      };

      await processor.process([failingImageMessage]);

      expect(receivedEvents).toHaveLength(0);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toBe('⚠️ Gagal mengunduh foto struk dari WhatsApp. Silakan coba kirim ulang ya!');
    });

    it('respects English language setting during WhatsApp oversized media rejection', async () => {
      setActiveLanguage('en');
      const sentMessages: string[] = [];
      const outgoingTracker = new MessageIdTracker();

      const processor = new WhatsappInboundMessageProcessor(
        '6281234567890',
        async () => {},
        () => ({
          user: { id: '6281234567890:1@s.whatsapp.net' },
          updateMediaMessage: async () => {},
        } as any),
        outgoingTracker,
        10 * 1024 * 1024,
        async (_chatId, text) => {
          sentMessages.push(text);
        }
      );

      const oversizedMessage = {
        key: {
          remoteJid: '6281234567890@s.whatsapp.net',
          id: 'oversized-en-msg',
          fromMe: false,
        },
        message: {
          imageMessage: {
            fileLength: 20 * 1024 * 1024,
            mimetype: 'image/jpeg',
          },
        },
      };

      await processor.process([oversizedMessage]);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('Photo size exceeds the maximum limit (10 MB)');
      expect(sentMessages[0]).toContain('Please send a smaller photo!');
    });
  });
});
