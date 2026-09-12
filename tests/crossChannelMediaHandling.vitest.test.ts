import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
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
    it('uses shared policy for internal oversized rejection helper', async () => {
      const sentMessages: string[] = [];
      const dummyToken = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ';
      const dummyUserId = '123456789';

      const adapter = new TelegramMessagingAdapter(
        dummyToken,
        dummyUserId,
        async () => {},
        { maxMediaDownloadBytes: 5 * 1024 * 1024 }
      );

      vi.spyOn(adapter, 'sendTextMessage').mockImplementation(async (_chatId, messageText) => {
        sentMessages.push(messageText);
      });

      // Call private rejectOversizedPhoto helper
      await (adapter as any).rejectOversizedPhoto(
        '123456789',
        '123456789',
        12 * 1024 * 1024,
        'declared_size'
      );

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('Ukuran foto melebihi batas maksimal (5 MB)');
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
        5 * 1024 * 1024, // 5 MB
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
            fileLength: 15 * 1024 * 1024, // 15 MB
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
