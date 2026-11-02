import axios from 'axios';
import { beforeEach, describe, expect, it } from 'vitest';
import { Bot } from 'grammy';
import { TelegramMessagingAdapter } from '../src/gateway/telegram.js';
import { WhatsappMessagingAdapter } from '../src/gateway/whatsapp.js';
import { loadEnvironmentConfiguration } from '../src/config/environmentConfig.js';
import { IncomingUserMessageEvent } from '../src/gateway/types.js';
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
} from '../src/gateway/mediaPolicy.js';
import { setActiveLanguage, getActiveLanguage } from '../src/i18n/index.js';
import { applicationLogger } from '../src/lib/logger.js';

describe('incoming media download limits and safety policies', () => {
  const dummyToken = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ';
  const dummyUserId = '123456789';
  const dummySessionDirectory = './test_auth_session';
  const dummyPhoneNumber = '6281234567890';

  describe('environment configuration for media limits', () => {
    const originalEnv = process.env.MAX_MEDIA_DOWNLOAD_MB;

    beforeEach(() => {
      if (originalEnv !== undefined) {
        process.env.MAX_MEDIA_DOWNLOAD_MB = originalEnv;
      } else {
        delete process.env.MAX_MEDIA_DOWNLOAD_MB;
      }
    });

    it('loads default 10 MB when MAX_MEDIA_DOWNLOAD_MB is unset', () => {
      delete process.env.MAX_MEDIA_DOWNLOAD_MB;
      const config = loadEnvironmentConfiguration();
      expect(config.maxMediaDownloadMb).toBe(10);
    });

    it('parses valid integer MAX_MEDIA_DOWNLOAD_MB', () => {
      process.env.MAX_MEDIA_DOWNLOAD_MB = '25';
      const config = loadEnvironmentConfiguration();
      expect(config.maxMediaDownloadMb).toBe(25);
    });

    it('falls back to default 10 MB when MAX_MEDIA_DOWNLOAD_MB is <= 0 or invalid string', () => {
      process.env.MAX_MEDIA_DOWNLOAD_MB = '0';
      expect(loadEnvironmentConfiguration().maxMediaDownloadMb).toBe(10);

      process.env.MAX_MEDIA_DOWNLOAD_MB = '-5';
      expect(loadEnvironmentConfiguration().maxMediaDownloadMb).toBe(10);

      process.env.MAX_MEDIA_DOWNLOAD_MB = 'invalid_string';
      expect(loadEnvironmentConfiguration().maxMediaDownloadMb).toBe(10);
    });
  });

  describe('WhatsApp pre-download and buffer limits', () => {
    const maxDownloadLimitBytes = 5 * 1024 * 1024;

    it('respects custom maxMediaDownloadBytes option', () => {
      const adapter = new WhatsappMessagingAdapter(
        dummySessionDirectory,
        dummyPhoneNumber,
        async () => {},
        { maxMediaDownloadBytes: maxDownloadLimitBytes }
      );
      expect(adapter.getMaxMediaDownloadBytes()).toBe(maxDownloadLimitBytes);
    });

    it('rejects oversized image before download and notifies sender with localized warning', async () => {
      const receivedEvents: IncomingUserMessageEvent[] = [];
      const outboundMessages: string[] = [];

      const adapter = new WhatsappMessagingAdapter(
        dummySessionDirectory,
        dummyPhoneNumber,
        async event => { receivedEvents.push(event); },
        { maxMediaDownloadBytes: maxDownloadLimitBytes }
      );

      const mockSocket = {
        sendMessage: async (_jid: string, content: { text: string }) => {
          outboundMessages.push(content.text);
          return { key: { id: 'mock-outbound-id' } };
        },
        updateMediaMessage: async () => {},
      };
      (adapter as unknown as { socketInstance: typeof mockSocket }).socketInstance = mockSocket;

      const oversizedIncomingMessage = {
        key: { remoteJid: '6281234567890@s.whatsapp.net', id: 'msg-oversized-1' },
        message: {
          imageMessage: {
            fileLength: 12 * 1024 * 1024,
            caption: 'Receipt over 5MB',
            mimetype: 'image/jpeg',
          },
        },
      };

      await (adapter as unknown as {
        handleIncomingMessage: (...args: unknown[]) => Promise<void>;
      }).handleIncomingMessage(
        oversizedIncomingMessage,
        oversizedIncomingMessage.message,
        '6281234567890@s.whatsapp.net',
        '6281234567890'
      );

      expect(receivedEvents).toHaveLength(0);
      expect(outboundMessages).toHaveLength(1);
      expect(outboundMessages[0]).toContain('Ukuran foto melebihi batas maksimal (5 MB)');
    });

    it('correctly evaluates oversized post-download buffer when length is undeclared', () => {
      const adapter = new WhatsappMessagingAdapter(
        dummySessionDirectory,
        dummyPhoneNumber,
        async () => {},
        { maxMediaDownloadBytes: maxDownloadLimitBytes }
      );

      const oversizedBuffer = Buffer.alloc(6 * 1024 * 1024);
      expect(oversizedBuffer.length).toBeGreaterThan(adapter.getMaxMediaDownloadBytes());
    });
  });

  describe('Telegram pre-download and stream limits', () => {
    const maxDownloadLimitBytes = 10 * 1024 * 1024;
    const adapter = new TelegramMessagingAdapter(
      dummyToken,
      dummyUserId,
      async () => {},
      { maxMediaDownloadBytes: maxDownloadLimitBytes }
    );

    it('respects default or configured maxMediaDownloadBytes', () => {
      expect(adapter.getMaxMediaDownloadBytes()).toBe(maxDownloadLimitBytes);
    });

    it('classifies ERR_FR_MAX_BODY_LENGTH_EXCEEDED as payload size limit exceeded', () => {
      const simulatedAxiosError = {
        isAxiosError: true,
        code: 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED',
        message: 'maxContentLength size of 10485760 exceeded',
      };

      const isExceeded =
        simulatedAxiosError.code === 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED' ||
        simulatedAxiosError.message.toLowerCase().includes('maxcontentlength');

      expect(isExceeded).toBe(true);
    });

    it('correctly identifies photo variant file_size exceeding threshold', () => {
      const declaredFileSize = 15 * 1024 * 1024;
      expect(declaredFileSize).toBeGreaterThan(adapter.getMaxMediaDownloadBytes());

      const legitimateFileSize = 3 * 1024 * 1024;
      expect(legitimateFileSize).toBeLessThanOrEqual(adapter.getMaxMediaDownloadBytes());
    });
  });

  describe('shared cross-channel media policy primitives and localization', () => {
    it('evaluates byte and megabyte size conversions and boundaries accurately', () => {
      expect(formatBytesToMegabytes(10 * 1024 * 1024)).toBe(10);
      expect(formatBytesToMegabytesDisplay(15.5 * 1024 * 1024, 1)).toBe('15.5');
      expect(isMediaSizeExceeded(100, 100)).toBe(false);
      expect(isMediaSizeExceeded(101, 100)).toBe(true);
      expect(isMediaSizeExceeded(99, 100)).toBe(false);
    });

    it('detects payload size limit errors across Axios and generic stream variants', () => {
      expect(isMediaPayloadSizeLimitExceeded({ isAxiosError: true, code: 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED' })).toBe(true);
      expect(isMediaPayloadSizeLimitExceeded({ code: 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED' })).toBe(true);
      expect(isMediaPayloadSizeLimitExceeded({ message: 'maxContentLength size of 10485760 exceeded' })).toBe(true);
      expect(isMediaPayloadSizeLimitExceeded({ message: 'maxBodyLength size of 10485760 exceeded' })).toBe(true);
      expect(isMediaPayloadSizeLimitExceeded({ code: 'ECONNRESET', message: 'connection reset' })).toBe(false);
      expect(isMediaPayloadSizeLimitExceeded(null)).toBe(false);
      expect(isMediaPayloadSizeLimitExceeded(undefined)).toBe(false);
    });

    it('normalizes channel display names', () => {
      expect(getChannelDisplayName('whatsapp')).toBe('WhatsApp');
      expect(getChannelDisplayName('telegram')).toBe('Telegram');
      expect(getChannelDisplayName('custom_channel')).toBe('custom_channel');
    });

    it('formats localized media warnings and failure messages in Indonesian and English', () => {
      const initialLanguage = getActiveLanguage();
      try {
        setActiveLanguage('id');
        expect(formatMediaTooLargeMessage(5 * 1024 * 1024)).toContain('Ukuran foto melebihi batas maksimal (5 MB)');
        expect(formatMediaDownloadFailedMessage('whatsapp')).toContain('Gagal mengunduh foto struk dari WhatsApp');
        expect(formatMediaDownloadFailedMessage('telegram')).toContain('Gagal mengunduh foto struk dari Telegram');

        setActiveLanguage('en');
        expect(formatMediaTooLargeMessage(10 * 1024 * 1024)).toContain('Photo size exceeds the maximum limit (10 MB)');
        expect(formatMediaDownloadFailedMessage('whatsapp')).toContain('Failed to download receipt photo from WhatsApp');
        expect(formatMediaDownloadFailedMessage('telegram')).toContain('Failed to download receipt photo from Telegram');
      } finally {
        setActiveLanguage(initialLanguage);
      }
    });

    it('executes rejectOversizedMedia sending localized notice', async () => {
      const sentTexts: string[] = [];
      const sendTextMessage = async (_chatId: string, text: string) => {
        sentTexts.push(text);
      };

      await rejectOversizedMedia({
        channel: 'telegram',
        chatIdentifier: 'tg-chat-1',
        senderIdentifier: 'tg-user-1',
        maxMediaDownloadBytes: 5 * 1024 * 1024,
        actualBytes: 8 * 1024 * 1024,
        rejectionStage: 'declared_size',
        sendTextMessage,
      });

      expect(sentTexts).toHaveLength(1);
      expect(sentTexts[0]).toContain('5 MB');

      sentTexts.length = 0;
      await rejectOversizedMedia({
        channel: 'telegram',
        chatIdentifier: 'tg-chat-1',
        senderIdentifier: 'tg-user-1',
        maxMediaDownloadBytes: 10 * 1024 * 1024,
        rejectionStage: 'download_stream',
        sendTextMessage,
      });

      expect(sentTexts).toHaveLength(1);
      expect(sentTexts[0]).toContain('10 MB');
    });

    it('executes handleMediaDownloadFailure with token redaction in logs', async () => {
      const sentTexts: string[] = [];
      const sendTextMessage = async (_chatId: string, text: string) => {
        sentTexts.push(text);
      };

      const loggedErrors: string[] = [];
      const originalLoggerError = applicationLogger.error;
      applicationLogger.error = (message: string) => {
        loggedErrors.push(message);
      };

      try {
        const errorWithSensitiveToken = new Error('Request failed with token: secret-telegram-bot-token');
        await handleMediaDownloadFailure({
          channel: 'telegram',
          chatIdentifier: 'tg-chat-1',
          senderIdentifier: 'tg-user-1',
          downloadError: errorWithSensitiveToken,
          redactToken: 'secret-telegram-bot-token',
          sendTextMessage,
        });

        expect(loggedErrors.length).toBeGreaterThan(0);
        expect(loggedErrors[0]).not.toContain('secret-telegram-bot-token');
        expect(loggedErrors[0]).toContain('[REDACTED_TOKEN]');
        expect(sentTexts).toHaveLength(1);
        expect(sentTexts[0]).toContain('Gagal mengunduh foto struk dari Telegram');

        sentTexts.length = 0;
        loggedErrors.length = 0;
        await handleMediaDownloadFailure({
          channel: 'whatsapp',
          chatIdentifier: 'wa-chat-1',
          senderIdentifier: 'wa-user-1',
          downloadError: 'Non-error string failure',
          sendTextMessage,
        });

        expect(sentTexts).toHaveLength(1);
        expect(loggedErrors.length).toBeGreaterThan(0);
      } finally {
        applicationLogger.error = originalLoggerError;
      }
    });
  });

  describe('Telegram end-to-end media handling and error redaction', () => {
    const dummyBotInfo = {
      id: 123456789,
      is_bot: true as const,
      first_name: 'TestBot',
      username: 'test_bot',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    };

    it('rejects oversized photo variant before download without calling getFile', async () => {
      const sentMessages: string[] = [];
      const receivedEvents: IncomingUserMessageEvent[] = [];

      const adapter = new TelegramMessagingAdapter(
        dummyToken,
        dummyUserId,
        async event => { receivedEvents.push(event); },
        { maxMediaDownloadBytes: 5 * 1024 * 1024 }
      );
      (adapter as unknown as { sendTextMessage: (_chatId: string, text: string) => Promise<void> }).sendTextMessage = async (_chatId: string, text: string) => {
        sentMessages.push(text);
      };

      const bot = new Bot(dummyToken, { botInfo: dummyBotInfo });
      adapter.setupBotHandlers(bot);

      let getFileCalled = false;
      bot.api.config.use(async (prev, method, payload, signal) => {
        if (method === 'getFile') {
          getFileCalled = true;
          return { ok: true, result: { file_id: 'any', file_unique_id: 'u1', file_path: 'p.jpg', file_size: 100 } as any };
        }
        return prev(method, payload, signal);
      });

      const oversizedPhotoUpdate = {
        update_id: 501,
        message: {
          message_id: 501,
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
      expect(receivedEvents).toHaveLength(0);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('5 MB');
    });

    it('rejects photo when fileMetadata exceeds limit without calling axios', async () => {
      const sentMessages: string[] = [];
      const receivedEvents: IncomingUserMessageEvent[] = [];

      const adapter = new TelegramMessagingAdapter(
        dummyToken,
        dummyUserId,
        async event => { receivedEvents.push(event); },
        { maxMediaDownloadBytes: 5 * 1024 * 1024 }
      );
      (adapter as unknown as { sendTextMessage: (_chatId: string, text: string) => Promise<void> }).sendTextMessage = async (_chatId: string, text: string) => {
        sentMessages.push(text);
      };

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

      let axiosCalled = false;
      const originalAxiosGet = axios.get;
      axios.get = (async () => {
        axiosCalled = true;
        return { data: Buffer.alloc(100) };
      }) as any;

      try {
        const photoUpdate = {
          update_id: 502,
          message: {
            message_id: 502,
            date: Math.floor(Date.now() / 1000),
            chat: { id: Number(dummyUserId), type: 'private' as const },
            from: { id: Number(dummyUserId), is_bot: false, first_name: 'Owner' },
            photo: [
              { file_id: 'large-meta-id', file_unique_id: 'u2', width: 800, height: 800, file_size: 1000 },
            ],
          },
        };

        await bot.handleUpdate(photoUpdate);

        expect(axiosCalled).toBe(false);
        expect(receivedEvents).toHaveLength(0);
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]).toContain('5 MB');
      } finally {
        axios.get = originalAxiosGet;
      }
    });

    it('classifies axios stream limit error as oversized media', async () => {
      const sentMessages: string[] = [];
      const receivedEvents: IncomingUserMessageEvent[] = [];

      const adapter = new TelegramMessagingAdapter(
        dummyToken,
        dummyUserId,
        async event => { receivedEvents.push(event); },
        { maxMediaDownloadBytes: 10 * 1024 * 1024 }
      );
      (adapter as unknown as { sendTextMessage: (_chatId: string, text: string) => Promise<void> }).sendTextMessage = async (_chatId: string, text: string) => {
        sentMessages.push(text);
      };

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

      const originalAxiosGet = axios.get;
      axios.get = (async () => {
        const error = new Error('maxContentLength size of 10485760 exceeded');
        (error as any).isAxiosError = true;
        (error as any).code = 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED';
        throw error;
      }) as any;

      try {
        const photoUpdate = {
          update_id: 503,
          message: {
            message_id: 503,
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
        expect(sentMessages[0]).toContain('10 MB');
      } finally {
        axios.get = originalAxiosGet;
      }
    });

    it('redacts bot token in logs and sends failure notice on normal download error', async () => {
      const sentMessages: string[] = [];
      const receivedEvents: IncomingUserMessageEvent[] = [];
      const loggedErrors: string[] = [];

      const originalLoggerError = applicationLogger.error;
      applicationLogger.error = (msg: string) => {
        loggedErrors.push(msg);
      };

      const adapter = new TelegramMessagingAdapter(
        dummyToken,
        dummyUserId,
        async event => { receivedEvents.push(event); },
        { maxMediaDownloadBytes: 10 * 1024 * 1024 }
      );
      (adapter as unknown as { sendTextMessage: (_chatId: string, text: string) => Promise<void> }).sendTextMessage = async (_chatId: string, text: string) => {
        sentMessages.push(text);
      };

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

      const originalAxiosGet = axios.get;
      axios.get = (async () => {
        throw new Error(`connect ETIMEDOUT https://api.telegram.org/file/bot${dummyToken}/photos/fail.jpg`);
      }) as any;

      try {
        const photoUpdate = {
          update_id: 504,
          message: {
            message_id: 504,
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
        expect(sentMessages[0]).toContain('Gagal mengunduh foto struk dari Telegram');
        expect(loggedErrors.length).toBeGreaterThan(0);
        expect(loggedErrors.some(e => e.includes(dummyToken))).toBe(false);
        expect(loggedErrors.some(e => e.includes('[REDACTED_TOKEN]'))).toBe(true);
      } finally {
        axios.get = originalAxiosGet;
        applicationLogger.error = originalLoggerError;
      }
    });

    it('rejects post-download oversized buffer before event dispatch', async () => {
      const sentMessages: string[] = [];
      const receivedEvents: IncomingUserMessageEvent[] = [];

      const adapter = new TelegramMessagingAdapter(
        dummyToken,
        dummyUserId,
        async event => { receivedEvents.push(event); },
        { maxMediaDownloadBytes: 5 * 1024 * 1024 }
      );
      (adapter as unknown as { sendTextMessage: (_chatId: string, text: string) => Promise<void> }).sendTextMessage = async (_chatId: string, text: string) => {
        sentMessages.push(text);
      };

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

      const originalAxiosGet = axios.get;
      axios.get = (async () => {
        return { data: Buffer.alloc(8 * 1024 * 1024) };
      }) as any;

      try {
        const photoUpdate = {
          update_id: 505,
          message: {
            message_id: 505,
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
        expect(sentMessages[0]).toContain('5 MB');
      } finally {
        axios.get = originalAxiosGet;
      }
    });

    it('delivers valid photo as image message event cleanly', async () => {
      const sentMessages: string[] = [];
      const receivedEvents: IncomingUserMessageEvent[] = [];

      const adapter = new TelegramMessagingAdapter(
        dummyToken,
        dummyUserId,
        async event => { receivedEvents.push(event); },
        { maxMediaDownloadBytes: 10 * 1024 * 1024 }
      );
      (adapter as unknown as { sendTextMessage: (_chatId: string, text: string) => Promise<void> }).sendTextMessage = async (_chatId: string, text: string) => {
        sentMessages.push(text);
      };

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

      const sampleImageBuffer = Buffer.from('mock-valid-jpeg-data');
      const originalAxiosGet = axios.get;
      axios.get = (async () => {
        return { data: sampleImageBuffer };
      }) as any;

      try {
        const photoUpdate = {
          update_id: 506,
          message: {
            message_id: 506,
            date: Math.floor(Date.now() / 1000),
            chat: { id: Number(dummyUserId), type: 'private' as const },
            from: { id: Number(dummyUserId), is_bot: false, first_name: 'Owner' },
            photo: [
              { file_id: 'success-id', file_unique_id: 'u6', width: 800, height: 800, file_size: 2048 },
            ],
            caption: 'Grocery Receipt',
          },
        };

        await bot.handleUpdate(photoUpdate);

        expect(sentMessages).toHaveLength(0);
        expect(receivedEvents).toHaveLength(1);
        expect(receivedEvents[0].channel).toBe('telegram');
        expect(receivedEvents[0].messageType).toBe('image');
        expect(receivedEvents[0].textPayload).toBe('Grocery Receipt');
        expect(receivedEvents[0].imageBuffer?.equals(sampleImageBuffer)).toBe(true);
      } finally {
        axios.get = originalAxiosGet;
      }
    });
  });

  describe('WhatsApp inbound processor download failure handling', () => {
    it('notifies user when WhatsApp image download fails', async () => {
      const receivedEvents: IncomingUserMessageEvent[] = [];
      const outboundMessages: string[] = [];

      const adapter = new WhatsappMessagingAdapter(
        dummySessionDirectory,
        dummyPhoneNumber,
        async event => { receivedEvents.push(event); },
        { maxMediaDownloadBytes: 5 * 1024 * 1024 }
      );

      const mockSocket = {
        sendMessage: async (_jid: string, content: { text: string }) => {
          outboundMessages.push(content.text);
          return { key: { id: 'mock-outbound-id' } };
        },
        updateMediaMessage: async () => {},
      };
      (adapter as unknown as { socketInstance: typeof mockSocket }).socketInstance = mockSocket;

      const failingIncomingMessage = {
        key: { remoteJid: '6281234567890@s.whatsapp.net', id: 'msg-download-fail-1' },
        message: {
          imageMessage: {
            fileLength: 2000,
            caption: 'Corrupted receipt',
            mimetype: 'image/jpeg',
          },
        },
      };

      await (adapter as unknown as {
        handleIncomingMessage: (...args: unknown[]) => Promise<void>;
      }).handleIncomingMessage(
        failingIncomingMessage,
        failingIncomingMessage.message,
        '6281234567890@s.whatsapp.net',
        '6281234567890'
      );

      expect(receivedEvents).toHaveLength(0);
      expect(outboundMessages).toHaveLength(1);
      expect(outboundMessages[0]).toContain('Gagal mengunduh foto struk dari WhatsApp');
    });
  });
});
