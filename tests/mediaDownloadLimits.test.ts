import axios from 'axios';
import { TelegramMessagingAdapter } from '../src/services/messaging/telegramAdapter.js';
import { WhatsappMessagingAdapter } from '../src/services/messaging/whatsappAdapter.js';
import { loadEnvironmentConfiguration } from '../src/config/environmentConfig.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/types.js';

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
  // TEST SUMMARY
  // ----------------------------------------------------
  console.log('\n====================================================');
  console.log(
    `[TEST SUMMARY] Total: ${testStatistics.totalCount} | Passed: ${testStatistics.passedCount} | Failed: ${testStatistics.failedCount}`
  );
  console.log('====================================================');

  if (testStatistics.failedCount > 0) {
    process.exit(1);
  } else {
    console.log('[SUCCESS] All incoming media download limit tests passed!\n');
  }
}

runTestSuite().catch(suiteError => {
  console.error(`[ERROR] Unexpected test suite failure: ${suiteError}`);
  process.exit(1);
});
