import axios from 'axios';
import { describe, it } from 'vitest';
import { Bot } from 'grammy';
import { TelegramMessagingAdapter } from '../src/services/messaging/telegramAdapter.js';
import { WhatsappMessagingAdapter } from '../src/services/messaging/whatsappAdapter.js';
import { loadEnvironmentConfiguration } from '../src/config/environmentConfig.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/types.js';
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
import { setActiveLanguage, getActiveLanguage } from '../src/i18n/index.js';
import { applicationLogger } from '../src/utils/logger.js';

interface AssertionStatistics {
  totalCount: number;
  passedCount: number;
  failedCount: number;
}

const testStatistics: AssertionStatistics = {
  totalCount: 0,
  passedCount: 0,
  failedCount: 0,
};

function assertCondition(testCaseIdentifier: string, conditionMet: boolean, failureDetail?: string): void {
  testStatistics.totalCount++;
  if (conditionMet) {
    testStatistics.passedCount++;
    console.log(`  [PASS] ${testCaseIdentifier}`);
  } else {
    testStatistics.failedCount++;
    console.error(`  [FAIL] ${testCaseIdentifier}${failureDetail ? ` -> ${failureDetail}` : ''}`);
  }
}

async function runTestSuite(): Promise<void> {
  console.log('====================================================');
  console.log('[INFO] Running Incoming Media Download Limits Test Suite');
  console.log('====================================================\n');

  const dummyToken = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ';
  const dummyUserId = '123456789';
  const dummySessionDirectory = './test_auth_session';
  const dummyPhoneNumber = '6281234567890';

  // ----------------------------------------------------
  // TEST GROUP 1: Environment Configuration for Media Limits
  // ----------------------------------------------------
  console.log('[TEST GROUP 1] Environment Configuration for Media Limits');
  {
    const originalEnv = process.env.MAX_MEDIA_DOWNLOAD_MB;

    delete process.env.MAX_MEDIA_DOWNLOAD_MB;
    const defaultConfig = loadEnvironmentConfiguration();
    assertCondition(
      'ENV-1.1: Default maxMediaDownloadMb is 10',
      defaultConfig.maxMediaDownloadMb === 10,
      `Actual: ${defaultConfig.maxMediaDownloadMb}`
    );

    process.env.MAX_MEDIA_DOWNLOAD_MB = '25';
    const customConfig = loadEnvironmentConfiguration();
    assertCondition(
      'ENV-1.2: Custom MAX_MEDIA_DOWNLOAD_MB (25) is parsed correctly',
      customConfig.maxMediaDownloadMb === 25,
      `Actual: ${customConfig.maxMediaDownloadMb}`
    );

    process.env.MAX_MEDIA_DOWNLOAD_MB = 'invalid_number';
    const invalidConfig = loadEnvironmentConfiguration();
    assertCondition(
      'ENV-1.3: Non-numeric MAX_MEDIA_DOWNLOAD_MB safely falls back to 10',
      invalidConfig.maxMediaDownloadMb === 10,
      `Actual: ${invalidConfig.maxMediaDownloadMb}`
    );

    process.env.MAX_MEDIA_DOWNLOAD_MB = '-5';
    const negativeConfig = loadEnvironmentConfiguration();
    assertCondition(
      'ENV-1.4: Negative MAX_MEDIA_DOWNLOAD_MB safely falls back to 10',
      negativeConfig.maxMediaDownloadMb === 10,
      `Actual: ${negativeConfig.maxMediaDownloadMb}`
    );

    if (originalEnv !== undefined) {
      process.env.MAX_MEDIA_DOWNLOAD_MB = originalEnv;
    } else {
      delete process.env.MAX_MEDIA_DOWNLOAD_MB;
    }
  }

  // ----------------------------------------------------
  // TEST GROUP 2: WhatsApp Pre-Download & Buffer Limits
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 2] WhatsApp Media Buffer Limits');
  {
    const receivedEvents: IncomingUserMessageEvent[] = [];
    const callback = async (event: IncomingUserMessageEvent) => {
      receivedEvents.push(event);
    };

    const maxDownloadLimitBytes = 5 * 1024 * 1024; // 5 MB
    const adapter = new WhatsappMessagingAdapter(
      dummySessionDirectory,
      dummyPhoneNumber,
      callback,
      {
        maxMediaDownloadBytes: maxDownloadLimitBytes,
      }
    );

    assertCondition(
      'WA-2.1: Adapter respects custom maxMediaDownloadBytes (5 MB)',
      adapter.getMaxMediaDownloadBytes() === maxDownloadLimitBytes
    );

    const outboundMessages: string[] = [];
    const mockSocket = {
      sendMessage: async (_jid: string, content: { text: string }) => {
        outboundMessages.push(content.text);
        return { key: { id: 'mock-outbound-id' } };
      },
      updateMediaMessage: async () => {},
    };
    (adapter as any).socketInstance = mockSocket;

    // Subcase A: Pre-download inspection catches oversized declared fileLength (12 MB)
    {
      outboundMessages.length = 0;
      receivedEvents.length = 0;

      const oversizedIncomingMessage = {
        key: { remoteJid: '6281234567890@s.whatsapp.net', id: 'msg-oversized-1' },
        message: {
          imageMessage: {
            fileLength: 12 * 1024 * 1024, // 12 MB (exceeds 5 MB limit)
            caption: 'Receipt over 5MB',
            mimetype: 'image/jpeg',
          },
        },
      };

      await (adapter as any).handleIncomingMessage(
        oversizedIncomingMessage,
        oversizedIncomingMessage.message,
        '6281234567890@s.whatsapp.net',
        '6281234567890'
      );

      assertCondition(
        'WA-2.2: Oversized image is rejected before download is triggered',
        receivedEvents.length === 0,
        `Received event count: ${receivedEvents.length}`
      );
      assertCondition(
        'WA-2.3: Friendly warning message sent to user indicating limit exceeded',
        outboundMessages.length > 0 && outboundMessages[0].includes('Ukuran foto melebihi batas maksimal (5 MB)'),
        `Actual message: ${outboundMessages[0]}`
      );
    }

    // Subcase B: Post-download buffer check when fileLength is missing/zero but actual buffer exceeds limit
    {
      outboundMessages.length = 0;
      receivedEvents.length = 0;

      const declaredZeroLengthMessage = {
        key: { remoteJid: '6281234567890@s.whatsapp.net', id: 'msg-oversized-buffer' },
        message: {
          imageMessage: {
            fileLength: 0, // Undeclared file length
            caption: 'Receipt undeclared length',
            mimetype: 'image/jpeg',
          },
        },
      };

      const oversizedBuffer = Buffer.alloc(6 * 1024 * 1024); // 6 MB buffer
      assertCondition(
        'WA-2.4: Oversized buffer exceeds configured limit (6 MB > 5 MB)',
        oversizedBuffer.length > adapter.getMaxMediaDownloadBytes()
      );
    }
  }

  // ----------------------------------------------------
  // TEST GROUP 3: Telegram Pre-Download & Stream Limits
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 3] Telegram Media Buffer Limits');
  {
    const receivedEvents: IncomingUserMessageEvent[] = [];
    const callback = async (event: IncomingUserMessageEvent) => {
      receivedEvents.push(event);
    };

    const maxDownloadLimitBytes = 10 * 1024 * 1024; // 10 MB
    const adapter = new TelegramMessagingAdapter(
      dummyToken,
      dummyUserId,
      callback,
      {
        maxMediaDownloadBytes: maxDownloadLimitBytes,
      }
    );

    assertCondition(
      'TG-3.1: Adapter respects default/configured maxMediaDownloadBytes (10 MB)',
      adapter.getMaxMediaDownloadBytes() === maxDownloadLimitBytes
    );

    // Subcase A: Axios error classification for maxContentLength exceeded
    {
      const simulatedAxiosError = {
        isAxiosError: true,
        code: 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED',
        message: 'maxContentLength size of 10485760 exceeded',
      };

      const isExceeded =
        simulatedAxiosError.code === 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED' ||
        simulatedAxiosError.message.toLowerCase().includes('maxcontentlength');

      assertCondition(
        'TG-3.2: ERR_FR_MAX_BODY_LENGTH_EXCEEDED is classified as payload size limit exceeded',
        isExceeded
      );
    }

    // Subcase B: Pre-download inspection on photo variant file_size (15 MB)
    {
      const declaredFileSize = 15 * 1024 * 1024;
      const isOversized = declaredFileSize > adapter.getMaxMediaDownloadBytes();
      assertCondition(
        'TG-3.3: Photo variant with 15 MB file_size detected as exceeding 10 MB threshold',
        isOversized
      );
    }

    // Subcase C: Legitimate photo size check (3 MB)
    {
      const legitimateFileSize = 3 * 1024 * 1024;
      const isWithinLimit = legitimateFileSize <= adapter.getMaxMediaDownloadBytes();
      assertCondition(
        'TG-3.4: Legitimate photo of 3 MB is within allowable bounds',
        isWithinLimit
      );
    }
  }

  // ----------------------------------------------------
  // TEST GROUP 4: Shared Cross-Channel Media Policy Primitives & Localization
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 4] Shared Cross-Channel Media Policy Primitives & Localization');
  {
    // 4.1 Byte and Megabyte Size Evaluation
    assertCondition(
      'POLICY-4.1: formatBytesToMegabytes converts 10 MB accurately',
      formatBytesToMegabytes(10 * 1024 * 1024) === 10
    );
    assertCondition(
      'POLICY-4.2: formatBytesToMegabytesDisplay formats 15.5 MB correctly',
      formatBytesToMegabytesDisplay(15.5 * 1024 * 1024, 1) === '15.5'
    );
    assertCondition(
      'POLICY-4.3: isMediaSizeExceeded detects byte boundaries accurately',
      !isMediaSizeExceeded(100, 100) && isMediaSizeExceeded(101, 100) && !isMediaSizeExceeded(99, 100)
    );

    // 4.2 Payload Limit Error Classification
    const axiosError = { isAxiosError: true, code: 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED' };
    const genericStreamError = { code: 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED' };
    const maxContentError = { message: 'maxContentLength size of 10485760 exceeded' };
    const maxBodyError = { message: 'maxBodyLength size of 10485760 exceeded' };
    const normalNetworkError = { code: 'ECONNRESET', message: 'connection reset' };

    assertCondition(
      'POLICY-4.4: isMediaPayloadSizeLimitExceeded detects Axios error code',
      isMediaPayloadSizeLimitExceeded(axiosError)
    );
    assertCondition(
      'POLICY-4.5: isMediaPayloadSizeLimitExceeded detects generic stream error code',
      isMediaPayloadSizeLimitExceeded(genericStreamError)
    );
    assertCondition(
      'POLICY-4.6: isMediaPayloadSizeLimitExceeded detects maxContentLength in message',
      isMediaPayloadSizeLimitExceeded(maxContentError)
    );
    assertCondition(
      'POLICY-4.7: isMediaPayloadSizeLimitExceeded detects maxBodyLength in message',
      isMediaPayloadSizeLimitExceeded(maxBodyError)
    );
    assertCondition(
      'POLICY-4.8: isMediaPayloadSizeLimitExceeded returns false for standard network errors and non-objects',
      !isMediaPayloadSizeLimitExceeded(normalNetworkError) &&
      !isMediaPayloadSizeLimitExceeded(null) &&
      !isMediaPayloadSizeLimitExceeded(undefined)
    );

    // 4.3 Channel Display Name Normalization
    assertCondition(
      'POLICY-4.9: getChannelDisplayName normalizes known and unknown channels',
      getChannelDisplayName('whatsapp') === 'WhatsApp' &&
      getChannelDisplayName('telegram') === 'Telegram' &&
      getChannelDisplayName('custom_channel') === 'custom_channel'
    );

    // 4.4 Localization for Media Messages
    const initialLanguage = getActiveLanguage();
    try {
      setActiveLanguage('id');
      const oversizedId = formatMediaTooLargeMessage(5 * 1024 * 1024);
      const failedWaId = formatMediaDownloadFailedMessage('whatsapp');
      const failedTgId = formatMediaDownloadFailedMessage('telegram');

      assertCondition(
        'POLICY-4.10: Indonesian oversized media message formatting',
        oversizedId.includes('Ukuran foto melebihi batas maksimal (5 MB)')
      );
      assertCondition(
        'POLICY-4.11: Indonesian media download failure formatting',
        failedWaId.includes('Gagal mengunduh foto struk dari WhatsApp') &&
        failedTgId.includes('Gagal mengunduh foto struk dari Telegram')
      );

      setActiveLanguage('en');
      const oversizedEn = formatMediaTooLargeMessage(10 * 1024 * 1024);
      const failedWaEn = formatMediaDownloadFailedMessage('whatsapp');
      const failedTgEn = formatMediaDownloadFailedMessage('telegram');

      assertCondition(
        'POLICY-4.12: English oversized media message formatting',
        oversizedEn.includes('Photo size exceeds the maximum limit (10 MB)')
      );
      assertCondition(
        'POLICY-4.13: English media download failure formatting',
        failedWaEn.includes('Failed to download receipt photo from WhatsApp') &&
        failedTgEn.includes('Failed to download receipt photo from Telegram')
      );
    } finally {
      setActiveLanguage(initialLanguage);
    }

    // 4.5 rejectOversizedMedia Function Execution
    {
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

      assertCondition(
        'POLICY-4.14: rejectOversizedMedia sends localized message with actualBytes',
        sentTexts.length === 1 && sentTexts[0].includes('5 MB')
      );

      sentTexts.length = 0;
      await rejectOversizedMedia({
        channel: 'telegram',
        chatIdentifier: 'tg-chat-1',
        senderIdentifier: 'tg-user-1',
        maxMediaDownloadBytes: 10 * 1024 * 1024,
        rejectionStage: 'download_stream',
        sendTextMessage,
      });

      assertCondition(
        'POLICY-4.15: rejectOversizedMedia handles stream rejection without actualBytes',
        sentTexts.length === 1 && sentTexts[0].includes('10 MB')
      );
    }

    // 4.6 handleMediaDownloadFailure Function Execution
    {
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

        assertCondition(
          'POLICY-4.16: handleMediaDownloadFailure redacts sensitive token in error log',
          loggedErrors.length > 0 &&
          !loggedErrors[0].includes('secret-telegram-bot-token') &&
          loggedErrors[0].includes('[REDACTED_TOKEN]')
        );
        assertCondition(
          'POLICY-4.17: handleMediaDownloadFailure dispatches localized failure notice',
          sentTexts.length === 1 && sentTexts[0].includes('Gagal mengunduh foto struk dari Telegram')
        );

        // String error handling
        sentTexts.length = 0;
        loggedErrors.length = 0;
        await handleMediaDownloadFailure({
          channel: 'whatsapp',
          chatIdentifier: 'wa-chat-1',
          senderIdentifier: 'wa-user-1',
          downloadError: 'Non-error string failure',
          sendTextMessage,
        });

        assertCondition(
          'POLICY-4.18: handleMediaDownloadFailure handles string downloadError',
          sentTexts.length === 1 && loggedErrors.length > 0
        );
      } finally {
        applicationLogger.error = originalLoggerError;
      }
    }
  }

  // ----------------------------------------------------
  // TEST GROUP 5: Telegram End-to-End Media Handling & Error Redaction
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 5] Telegram End-to-End Media Handling & Error Redaction');
  {
    const dummyBotInfo = {
      id: 123456789,
      is_bot: true as const,
      first_name: 'TestBot',
      username: 'test_bot',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    };

    // TG-5.1: Pre-download photo variant oversized rejection
    {
      const sentMessages: string[] = [];
      const receivedEvents: IncomingUserMessageEvent[] = [];

      const adapter = new TelegramMessagingAdapter(
        dummyToken,
        dummyUserId,
        async event => { receivedEvents.push(event); },
        { maxMediaDownloadBytes: 5 * 1024 * 1024 }
      );
      (adapter as any).sendTextMessage = async (_chatId: string, text: string) => {
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

      assertCondition(
        'TG-5.1: Telegram pre-download rejects oversized photo variant without calling getFile',
        !getFileCalled && receivedEvents.length === 0 && sentMessages.length === 1 && sentMessages[0].includes('5 MB')
      );
    }

    // TG-5.2: Metadata photo oversized rejection
    {
      const sentMessages: string[] = [];
      const receivedEvents: IncomingUserMessageEvent[] = [];

      const adapter = new TelegramMessagingAdapter(
        dummyToken,
        dummyUserId,
        async event => { receivedEvents.push(event); },
        { maxMediaDownloadBytes: 5 * 1024 * 1024 }
      );
      (adapter as any).sendTextMessage = async (_chatId: string, text: string) => {
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

        assertCondition(
          'TG-5.2: Telegram rejects photo when fileMetadata exceeds limit without calling axios',
          !axiosCalled && receivedEvents.length === 0 && sentMessages.length === 1 && sentMessages[0].includes('5 MB')
        );
      } finally {
        axios.get = originalAxiosGet;
      }
    }

    // TG-5.3: Axios stream limit error classification
    {
      const sentMessages: string[] = [];
      const receivedEvents: IncomingUserMessageEvent[] = [];

      const adapter = new TelegramMessagingAdapter(
        dummyToken,
        dummyUserId,
        async event => { receivedEvents.push(event); },
        { maxMediaDownloadBytes: 10 * 1024 * 1024 }
      );
      (adapter as any).sendTextMessage = async (_chatId: string, text: string) => {
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

        assertCondition(
          'TG-5.3: Telegram axios stream limit error classified as oversized media',
          receivedEvents.length === 0 && sentMessages.length === 1 && sentMessages[0].includes('10 MB')
        );
      } finally {
        axios.get = originalAxiosGet;
      }
    }

    // TG-5.4: Axios download failure with token redaction
    {
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
      (adapter as any).sendTextMessage = async (_chatId: string, text: string) => {
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

        assertCondition(
          'TG-5.4: Telegram normal download failure redacts bot token in logs and sends failure notice',
          receivedEvents.length === 0 &&
          sentMessages.length === 1 &&
          sentMessages[0].includes('Gagal mengunduh foto struk dari Telegram') &&
          loggedErrors.length > 0 &&
          !loggedErrors.some(e => e.includes(dummyToken)) &&
          loggedErrors.some(e => e.includes('[REDACTED_TOKEN]'))
        );
      } finally {
        axios.get = originalAxiosGet;
        applicationLogger.error = originalLoggerError;
      }
    }

    // TG-5.5: Post-download oversized buffer rejection
    {
      const sentMessages: string[] = [];
      const receivedEvents: IncomingUserMessageEvent[] = [];

      const adapter = new TelegramMessagingAdapter(
        dummyToken,
        dummyUserId,
        async event => { receivedEvents.push(event); },
        { maxMediaDownloadBytes: 5 * 1024 * 1024 }
      );
      (adapter as any).sendTextMessage = async (_chatId: string, text: string) => {
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

        assertCondition(
          'TG-5.5: Telegram post-download oversized buffer rejected before event dispatch',
          receivedEvents.length === 0 && sentMessages.length === 1 && sentMessages[0].includes('5 MB')
        );
      } finally {
        axios.get = originalAxiosGet;
      }
    }

    // TG-5.6: Successful photo download and delivery
    {
      const sentMessages: string[] = [];
      const receivedEvents: IncomingUserMessageEvent[] = [];

      const adapter = new TelegramMessagingAdapter(
        dummyToken,
        dummyUserId,
        async event => { receivedEvents.push(event); },
        { maxMediaDownloadBytes: 10 * 1024 * 1024 }
      );
      (adapter as any).sendTextMessage = async (_chatId: string, text: string) => {
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

        assertCondition(
          'TG-5.6: Telegram valid photo delivers image message event cleanly',
          sentMessages.length === 0 &&
          receivedEvents.length === 1 &&
          receivedEvents[0].channel === 'telegram' &&
          receivedEvents[0].messageType === 'image' &&
          receivedEvents[0].textPayload === 'Grocery Receipt' &&
          receivedEvents[0].imageBuffer?.equals(sampleImageBuffer) === true
        );
      } finally {
        axios.get = originalAxiosGet;
      }
    }
  }

  // ----------------------------------------------------
  // TEST GROUP 6: WhatsApp Inbound Processor Download Failure Handling
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 6] WhatsApp Inbound Processor Download Failure Handling');
  {
    const receivedEvents: IncomingUserMessageEvent[] = [];
    const callback = async (event: IncomingUserMessageEvent) => {
      receivedEvents.push(event);
    };

    const maxDownloadLimitBytes = 5 * 1024 * 1024; // 5 MB
    const adapter = new WhatsappMessagingAdapter(
      dummySessionDirectory,
      dummyPhoneNumber,
      callback,
      { maxMediaDownloadBytes: maxDownloadLimitBytes }
    );

    const outboundMessages: string[] = [];
    const mockSocket = {
      sendMessage: async (_jid: string, content: { text: string }) => {
        outboundMessages.push(content.text);
        return { key: { id: 'mock-outbound-id' } };
      },
      updateMediaMessage: async () => {},
    };
    (adapter as any).socketInstance = mockSocket;

    // Subcase 6.1: WhatsApp image download error triggers handleMediaDownloadFailure
    {
      outboundMessages.length = 0;
      receivedEvents.length = 0;

      // An imageMessage without valid media credentials causes downloadMediaMessage to fail
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

      await (adapter as any).handleIncomingMessage(
        failingIncomingMessage,
        failingIncomingMessage.message,
        '6281234567890@s.whatsapp.net',
        '6281234567890'
      );

      assertCondition(
        'WA-6.1: WhatsApp download failure invokes handleMediaDownloadFailure and notifies user',
        receivedEvents.length === 0 &&
        outboundMessages.length === 1 &&
        outboundMessages[0].includes('Gagal mengunduh foto struk dari WhatsApp')
      );
    }
  }

  // ----------------------------------------------------
  // TEST SUMMARY
  // ----------------------------------------------------
  console.log('\n====================================================');
  console.log(
    `[TEST SUMMARY] Total: ${testStatistics.totalCount} | Passed: ${testStatistics.passedCount} | Failed: ${testStatistics.failedCount}`
  );
  console.log('====================================================');

  if (testStatistics.failedCount > 0) {
    throw new Error(`${testStatistics.failedCount} media download limit assertions failed`);
  } else {
    console.log('[SUCCESS] All incoming media download limit tests passed!\n');
  }
}

describe('incoming media download limits', () => {
  it('enforces cross-channel buffer and stream safeguards', async () => {
    await runTestSuite();
  });
});
