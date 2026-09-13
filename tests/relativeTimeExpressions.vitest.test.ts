import assert from 'node:assert';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseRelativeTime,
  getLocalTimeParts,
  getPreviousLocalDateString,
  getNextLocalDateString,
  getCurrentLocalDateString,
  resolveTargetLocalToUtcIso,
  resolveLocalCalendarDayRange,
  resolveLocalCalendarRange,
} from '../src/utils/relativeTimeParser.js';
import {
  buildCompactSystemInstruction,
  buildTextMessagePrompt,
} from '../src/services/ai/aiPromptBuilder.js';
import { GeminiAiProvider } from '../src/services/ai/geminiAiProvider.js';
import { validateAndSanitizeFinancialRecords } from '../src/utils/recordValidator.js';
import { CreateRecordInputPayload, WalletAccountItem, WalletCategoryItem } from '../src/types/walletTypes.js';
import {
  loadEnvironmentConfiguration,
  validateApplicationConfiguration,
  ApplicationEnvironmentConfiguration,
} from '../src/config/environmentConfig.js';
import { setActiveLanguage } from '../src/i18n/index.js';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import { AccountClarificationHandler } from '../src/handlers/accountClarificationHandler.js';
import { WalletCacheService } from '../src/services/walletCacheService.js';
import { WalletMcpClientService } from '../src/services/walletMcpService.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/types.js';

const fixedReferenceUtc = new Date('2026-09-11T07:15:00.000Z');
const defaultTimezone = 'Asia/Jakarta';
const mockAccounts: WalletAccountItem[] = [
  { id: 'acc-cash', name: 'Cash', currency: 'IDR', accountType: 'Cash' },
];
const mockCategories: WalletCategoryItem[] = [
  { id: 'cat-food', name: 'Food' },
];
const originalTimezone = process.env.APP_TIMEZONE;

afterEach(() => {
  setActiveLanguage('id');
  if (originalTimezone === undefined) {
    delete process.env.APP_TIMEZONE;
  } else {
    process.env.APP_TIMEZONE = originalTimezone;
  }
});

describe('natural-language relative time parsing', () => {
  it('1. extracts local date/time and previous-date boundaries', () => {
    const localParts = getLocalTimeParts(fixedReferenceUtc, defaultTimezone);
    expect(localParts.dateString).toBe('2026-09-11');
    expect(localParts.hour).toBe(14);
    expect(localParts.minute).toBe(15);
    expect(localParts.formattedOffset).toBe('+07:00');
    expect(getPreviousLocalDateString('2026-09-11')).toBe('2026-09-10');
    expect(getPreviousLocalDateString('2026-03-01')).toBe('2026-02-28');
    expect(getPreviousLocalDateString('2027-01-01')).toBe('2026-12-31');
  });

  it('2. parses Indonesian tadi + period expressions using representative times', () => {
    const tadiPagi = parseRelativeTime('tadi pagi beli bensin 30rb', fixedReferenceUtc, defaultTimezone);
    expect(tadiPagi).not.toBeNull();
    expect(tadiPagi?.resolvedUtcIso).toBe('2026-09-11T01:00:00.000Z');
    expect(tadiPagi?.dayReference).toBe('today');
    expect(tadiPagi?.hasExplicitTime).toBe(false);

    expect(parseRelativeTime('tadi siang makan padang 25rb', fixedReferenceUtc, defaultTimezone)?.resolvedUtcIso)
      .toBe('2026-09-11T05:30:00.000Z');
    expect(parseRelativeTime('tadi sore ngopi 20rb', fixedReferenceUtc, defaultTimezone)?.resolvedUtcIso)
      .toBe('2026-09-11T09:30:00.000Z');
    expect(parseRelativeTime('tadi subuh isi bensin 50rb', fixedReferenceUtc, defaultTimezone)?.resolvedUtcIso)
      .toBe('2026-09-10T22:00:00.000Z');
  });

  it('3. parses kemarin, semalam, colloquial variants, and tadi malam correctly', () => {
    const semalam = parseRelativeTime('semalam makan sate 50rb', fixedReferenceUtc, defaultTimezone);
    expect(semalam?.resolvedUtcIso).toBe('2026-09-10T13:00:00.000Z');
    expect(semalam?.dayReference).toBe('yesterday');
    expect(parseRelativeTime('semalem jajan boba 25rb', fixedReferenceUtc, defaultTimezone)?.resolvedUtcIso)
      .toBe('2026-09-10T13:00:00.000Z');

    const tadiMalam = parseRelativeTime('tadi malam nonton bioskop 60rb', fixedReferenceUtc, defaultTimezone);
    expect(tadiMalam?.resolvedUtcIso).toBe('2026-09-11T13:00:00.000Z');
    expect(tadiMalam?.dayReference).toBe('today');
    expect(parseRelativeTime('kemarin malem makan sate 50rb pake cash', fixedReferenceUtc, defaultTimezone)?.resolvedUtcIso)
      .toBe('2026-09-10T13:00:00.000Z');
    expect(parseRelativeTime('kemarin sore beli roti 15rb', fixedReferenceUtc, defaultTimezone)?.resolvedUtcIso)
      .toBe('2026-09-10T09:30:00.000Z');
    expect(parseRelativeTime('kemarin siang makan bakso 20rb', fixedReferenceUtc, defaultTimezone)?.resolvedUtcIso)
      .toBe('2026-09-10T05:30:00.000Z');
    expect(parseRelativeTime('kemaren pagi sarapan bubur 15rb', fixedReferenceUtc, defaultTimezone)?.resolvedUtcIso)
      .toBe('2026-09-10T01:00:00.000Z');
  });

  it('4. lets explicit user clocks override representative period times', () => {
    const tadiPagiJam7 = parseRelativeTime('tadi pagi jam 7 beli bensin 30rb', fixedReferenceUtc, defaultTimezone);
    expect(tadiPagiJam7?.hasExplicitTime).toBe(true);
    expect(tadiPagiJam7?.resolvedUtcIso).toBe('2026-09-11T00:00:00.000Z');
    expect(parseRelativeTime('kemarin jam 3 sore ngopi 35rb', fixedReferenceUtc, defaultTimezone)?.resolvedUtcIso)
      .toBe('2026-09-10T08:00:00.000Z');
    expect(parseRelativeTime('semalam jam 9 martabak 45rb', fixedReferenceUtc, defaultTimezone)?.resolvedUtcIso)
      .toBe('2026-09-10T14:00:00.000Z');
    expect(parseRelativeTime('tadi jam 2 siang makan siang 30rb', fixedReferenceUtc, defaultTimezone)?.resolvedUtcIso)
      .toBe('2026-09-11T07:00:00.000Z');
  });

  it('5. parses equivalent English relative-time expressions', () => {
    expect(parseRelativeTime('this morning bought gas 30k', fixedReferenceUtc, defaultTimezone)?.resolvedUtcIso)
      .toBe('2026-09-11T01:00:00.000Z');
    expect(parseRelativeTime('this afternoon lunch 50k', fixedReferenceUtc, defaultTimezone)?.resolvedUtcIso)
      .toBe('2026-09-11T05:30:00.000Z');
    expect(parseRelativeTime('last night had dinner 100k', fixedReferenceUtc, defaultTimezone)?.resolvedUtcIso)
      .toBe('2026-09-10T13:00:00.000Z');
    expect(parseRelativeTime('yesterday morning breakfast 25k', fixedReferenceUtc, defaultTimezone)?.resolvedUtcIso)
      .toBe('2026-09-10T01:00:00.000Z');
    expect(parseRelativeTime('this morning at 7am bought coffee', fixedReferenceUtc, defaultTimezone)?.resolvedUtcIso)
      .toBe('2026-09-11T00:00:00.000Z');
    expect(parseRelativeTime('yesterday at 3pm grocery 120k', fixedReferenceUtc, defaultTimezone)?.resolvedUtcIso)
      .toBe('2026-09-10T08:00:00.000Z');
  });

  it('6. converts representative times correctly in WITA and WIT', () => {
    expect(parseRelativeTime('tadi pagi sarapan coto 30rb', fixedReferenceUtc, 'Asia/Makassar')?.resolvedUtcIso)
      .toBe('2026-09-11T00:00:00.000Z');
    expect(parseRelativeTime('tadi pagi sarapan papeda 25rb', fixedReferenceUtc, 'Asia/Jayapura')?.resolvedUtcIso)
      .toBe('2026-09-10T23:00:00.000Z');
  });

  it('7. normalizes record dates from relative source text without changing ordinary transactions', () => {
    process.env.APP_TIMEZONE = 'Asia/Jakarta';

    const kemarin = validateAndSanitizeFinancialRecords(
      [{ accountId: 'acc-cash', amount: -50000, recordDate: '2026-09-11T07:15:00.000Z', note: 'makan sate' }],
      mockAccounts,
      mockCategories,
      'kemarin malem makan sate 50rb pake cash',
      fixedReferenceUtc
    );
    expect(kemarin.isValid).toBe(true);
    expect(kemarin.sanitizedRecords[0].recordDate).toBe('2026-09-10T13:00:00.000Z');

    const tadiPagi = validateAndSanitizeFinancialRecords(
      [{ accountId: 'acc-cash', amount: -30000, recordDate: '2026-09-11T07:15:00.000Z', note: 'beli bensin' }],
      mockAccounts,
      mockCategories,
      'tadi pagi beli bensin 30rb',
      fixedReferenceUtc
    );
    expect(tadiPagi.sanitizedRecords[0].recordDate).toBe('2026-09-11T01:00:00.000Z');

    const standard = validateAndSanitizeFinancialRecords(
      [{ accountId: 'acc-cash', amount: -50000, recordDate: '2026-09-11T07:15:00.000Z', note: 'beli pulsa' }],
      mockAccounts,
      mockCategories,
      'beli pulsa 50rb',
      fixedReferenceUtc
    );
    expect(standard.sanitizedRecords[0].recordDate).toBe('2026-09-11T07:15:00.000Z');
  });

  it('8. grounds system instructions and text prompts with representative times and local-date anchors', () => {
    setActiveLanguage('id');
    const idInstruction = buildCompactSystemInstruction(mockAccounts, mockCategories, '2026-09-11', 'Asia/Jakarta');
    expect(idInstruction).toContain('pagi / morning: 08:00');
    expect(idInstruction).toContain('siang / afternoon: 12:30');
    expect(idInstruction).toContain('sore / evening: 16:30');
    expect(idInstruction).toContain('malam / malem / night: 20:00');
    expect(idInstruction).toContain('subuh / early morning: 05:00');
    expect(idInstruction).toContain('Offset: UTC+07:00');

    setActiveLanguage('en');
    const enInstruction = buildCompactSystemInstruction(mockAccounts, mockCategories, '2026-09-11', 'Asia/Jakarta');
    expect(enInstruction).toContain('morning / pagi: 08:00');
    expect(enInstruction).toContain('noon / afternoon / siang: 12:30');
    expect(enInstruction).toContain('evening / sore: 16:30');
    expect(enInstruction).toContain('night / malam / malem: 20:00');

    const prompt = buildTextMessagePrompt('kemarin malem makan sate', '2026-09-11T07:15:00.000Z', 'Asia/Jakarta');
    expect(prompt).toContain('Local Date: 2026-09-11');
    expect(prompt).toContain('Yesterday: 2026-09-10');
  });

  it('9. preserves distinct dates in multi-record batches and uses record-local relative expressions', () => {
    const caseA = validateAndSanitizeFinancialRecords(
      [
        { accountId: 'acc-cash', amount: -30000, recordDate: '2026-09-11T01:00:00.000Z', note: 'beli bensin' },
        { accountId: 'acc-cash', amount: -60000, recordDate: '2026-09-10T13:00:00.000Z', note: 'nonton bioskop' },
      ],
      mockAccounts,
      mockCategories,
      'tadi pagi beli bensin 30rb, kemarin malam nonton bioskop 60rb',
      fixedReferenceUtc
    );
    expect(caseA.sanitizedRecords).toHaveLength(2);
    expect(caseA.sanitizedRecords[0].recordDate).toBe('2026-09-11T01:00:00.000Z');
    expect(caseA.sanitizedRecords[1].recordDate).toBe('2026-09-10T13:00:00.000Z');
    expect(caseA.sanitizedRecords[0].recordDate).not.toBe(caseA.sanitizedRecords[1].recordDate);

    const caseB = validateAndSanitizeFinancialRecords(
      [
        { accountId: 'acc-cash', amount: -15000, recordDate: '2026-09-11T07:15:00.000Z', note: 'beli bensin tadi pagi' },
        { accountId: 'acc-cash', amount: -25000, recordDate: '2026-09-11T07:15:00.000Z', note: 'makan bakso kemarin siang' },
      ],
      mockAccounts,
      mockCategories,
      'beli bensin 15rb dan makan bakso 25rb',
      fixedReferenceUtc
    );
    expect(caseB.sanitizedRecords[0].recordDate).toBe('2026-09-11T01:00:00.000Z');
    expect(caseB.sanitizedRecords[1].recordDate).toBe('2026-09-10T05:30:00.000Z');
  });

  it('10. preserves request-scoped date and hashtags through account clarification across midnight', async () => {
    const ambiguousAccounts: WalletAccountItem[] = [
      { id: 'acc-bca-1', name: 'BCA Personal', currency: 'IDR', accountType: 'General' },
      { id: 'acc-bca-2', name: 'BCA Business', currency: 'IDR', accountType: 'General' },
    ];
    const requestStartReferenceUtc = new Date('2026-09-11T16:59:55.000Z');
    const ambiguousInputRecords: CreateRecordInputPayload[] = [{
      accountId: 'bca',
      amount: -50000,
      recordDate: '2026-09-11T16:59:55.000Z',
      note: 'makan sate #dinner',
    }];
    const validation = validateAndSanitizeFinancialRecords(
      ambiguousInputRecords,
      ambiguousAccounts,
      mockCategories,
      'kemarin malem makan sate 50rb #dinner bca',
      requestStartReferenceUtc
    );
    expect(validation.isValid).toBe(false);
    expect(validation.accountResolutionIssues).toHaveLength(1);
    expect(validation.accountResolutionIssues[0].reason).toBe('AMBIGUOUS');
    expect(ambiguousInputRecords[0].recordDate).toBe('2026-09-10T13:00:00.000Z');

    const dispatchedMcpRecords: CreateRecordInputPayload[][] = [];
    const pendingService = new PendingTransactionService();
    const mcpClient = {
      fetchAccounts: async () => ambiguousAccounts,
      fetchCategories: async () => mockCategories,
      fetchLabels: async () => [{ id: 'lbl-dinner', name: 'dinner' }],
      createLabel: async (name: string) => ({ id: `lbl-${name}`, name }),
      createRecords: async (records: CreateRecordInputPayload[]) => {
        dispatchedMcpRecords.push(records.map(record => ({ ...record })));
        return { summary: { total: records.length, succeeded: records.length, failed: 0 } };
      },
      fetchBudgets: async () => [],
    } as unknown as WalletMcpClientService;
    const cache = new WalletCacheService(mcpClient);
    await cache.initialize();
    const messagingGateway = {
      sendChatAction: async () => {},
      clearTypingPresence: async () => {},
      sendMessage: async () => {},
    };
    const handler = new AccountClarificationHandler(pendingService, mcpClient, cache, messagingGateway as any);
    const event: IncomingUserMessageEvent = {
      channel: 'whatsapp',
      senderIdentifier: '+628123456789',
      chatIdentifier: '+628123456789',
      messageType: 'text',
      textPayload: 'kemarin malem makan sate 50rb #dinner bca',
    };
    await handler.createPendingAccountSelectionDraft(
      event,
      ambiguousInputRecords,
      validation.accountResolutionIssues,
      ambiguousAccounts,
      mockCategories,
      requestStartReferenceUtc
    );
    const draft = pendingService.getPendingAccountSelectionDraft(1);
    expect(draft).toBeDefined();
    expect(draft?.sourceReferenceInstant?.toISOString()).toBe(requestStartReferenceUtc.toISOString());
    if (draft) draft.createdAt = new Date('2026-09-11T17:00:05.000Z');

    const handled = await handler.handlePendingAccountSelectionReply(
      event,
      '1',
      new Date('2026-09-12T07:00:00.000Z').getTime()
    );
    expect(handled).toBe(true);
    expect(dispatchedMcpRecords).toHaveLength(1);
    expect(dispatchedMcpRecords[0][0].recordDate).toBe('2026-09-10T13:00:00.000Z');
    expect(dispatchedMcpRecords[0][0].accountId).toBe('acc-bca-1');
    expect(dispatchedMcpRecords[0][0].labels).toContain('dinner');
  });

  it('11. resolves DST fall-back and spring-forward target dates using the target-date offset', () => {
    const timezone = 'America/New_York';
    expect(parseRelativeTime('yesterday at 8pm groceries $50', new Date('2026-11-01T17:00:00.000Z'), timezone)?.resolvedUtcIso)
      .toBe('2026-11-01T00:00:00.000Z');
    expect(resolveTargetLocalToUtcIso('2026-10-31', 20, 0, timezone)).toBe('2026-11-01T00:00:00.000Z');
    expect(parseRelativeTime('yesterday at 8pm dinner $40', new Date('2026-03-08T16:00:00.000Z'), timezone)?.resolvedUtcIso)
      .toBe('2026-03-08T01:00:00.000Z');
    expect(resolveTargetLocalToUtcIso('2026-03-07', 20, 0, timezone)).toBe('2026-03-08T01:00:00.000Z');
  });

  it('12. parses bare 24-hour clocks while excluding monetary numbers', () => {
    const dot = parseRelativeTime('kemarin 15.30 beli makan', fixedReferenceUtc, defaultTimezone);
    expect(dot?.hasExplicitTime).toBe(true);
    expect(dot?.targetHour).toBe(15);
    expect(dot?.targetMinute).toBe(30);
    expect(dot?.resolvedUtcIso).toBe('2026-09-10T08:30:00.000Z');

    const colon = parseRelativeTime('yesterday 15:30 groceries', fixedReferenceUtc, defaultTimezone);
    expect(colon?.hasExplicitTime).toBe(true);
    expect(colon?.targetHour).toBe(15);
    expect(colon?.targetMinute).toBe(30);
    expect(colon?.resolvedUtcIso).toBe('2026-09-10T08:30:00.000Z');

    const morning = parseRelativeTime('tadi pagi 07:30 beli bensin', fixedReferenceUtc, defaultTimezone);
    expect(morning?.hasExplicitTime).toBe(true);
    expect(morning?.targetHour).toBe(7);
    expect(morning?.targetMinute).toBe(30);
    expect(morning?.resolvedUtcIso).toBe('2026-09-11T00:30:00.000Z');

    expect(parseRelativeTime('kemarin beli baju 50.000', fixedReferenceUtc, defaultTimezone)?.hasExplicitTime).toBe(false);
    expect(parseRelativeTime('kemarin isi pulsa 20.000', fixedReferenceUtc, defaultTimezone)?.hasExplicitTime).toBe(false);
    const mixed = parseRelativeTime('kemarin 15.30 makan sate 50.000', fixedReferenceUtc, defaultTimezone);
    expect(mixed?.hasExplicitTime).toBe(true);
    expect(mixed?.targetHour).toBe(15);
    expect(mixed?.targetMinute).toBe(30);
  });

  it('13. excludes decimal currency values while preserving positive bare-clock contexts', () => {
    const currencyLikeInputs = [
      ['yesterday spent USD 15.30 on lunch', 'USD 15.30'],
      ['kemarin bayar $ 15.30', '$ 15.30'],
      ['yesterday spent 15.30 EUR', '15.30 EUR'],
      ['yesterday spent 15.30 dollars on lunch', '15.30 dollars'],
      ['yesterday paid 15.30 for lunch', 'paid 15.30'],
      ['yesterday pay 15.30', 'pay 15.30'],
      ['kemarin beli 15.30 roti', 'beli 15.30'],
    ] as const;
    for (const [text] of currencyLikeInputs) {
      const result = parseRelativeTime(text, fixedReferenceUtc, defaultTimezone);
      expect(result).not.toBeNull();
      expect(result?.hasExplicitTime).toBe(false);
      expect(result?.targetHour).not.toBe(15);
    }

    const bareLunch = parseRelativeTime('yesterday 15.30 bought lunch', fixedReferenceUtc, defaultTimezone);
    expect(bareLunch?.hasExplicitTime).toBe(true);
    expect(bareLunch?.targetHour).toBe(15);
    expect(bareLunch?.targetMinute).toBe(30);
    expect(bareLunch?.resolvedUtcIso).toBe('2026-09-10T08:30:00.000Z');

    const atColon = parseRelativeTime('yesterday at 15:30 groceries', fixedReferenceUtc, defaultTimezone);
    expect(atColon?.hasExplicitTime).toBe(true);
    expect(atColon?.targetHour).toBe(15);
    expect(atColon?.targetMinute).toBe(30);
    expect(atColon?.resolvedUtcIso).toBe('2026-09-10T08:30:00.000Z');

    const indonesianBare = parseRelativeTime('kemarin 15.30 beli makan', fixedReferenceUtc, defaultTimezone);
    expect(indonesianBare?.hasExplicitTime).toBe(true);
    expect(indonesianBare?.targetHour).toBe(15);
    expect(indonesianBare?.targetMinute).toBe(30);
    expect(indonesianBare?.resolvedUtcIso).toBe('2026-09-10T08:30:00.000Z');

    const tonight = parseRelativeTime('tonight 20.30 dinner', fixedReferenceUtc, defaultTimezone);
    expect(tonight?.hasExplicitTime).toBe(true);
    expect(tonight?.targetHour).toBe(20);
    expect(tonight?.targetMinute).toBe(30);
    expect(tonight?.resolvedUtcIso).toBe('2026-09-11T13:30:00.000Z');

    const dawn = parseRelativeTime('this dawn 05.30', fixedReferenceUtc, defaultTimezone);
    expect(dawn?.hasExplicitTime).toBe(true);
    expect(dawn?.targetHour).toBe(5);
    expect(dawn?.targetMinute).toBe(30);
    expect(dawn?.resolvedUtcIso).toBe('2026-09-10T22:30:00.000Z');

    const yesterdayDawn = parseRelativeTime('yesterday dawn 05.30', fixedReferenceUtc, defaultTimezone);
    expect(yesterdayDawn?.hasExplicitTime).toBe(true);
    expect(yesterdayDawn?.targetHour).toBe(5);
    expect(yesterdayDawn?.targetMinute).toBe(30);
    expect(yesterdayDawn?.resolvedUtcIso).toBe('2026-09-09T22:30:00.000Z');
  });

  it('14. derives current date from local timezone and invalidates Gemini cache across local midnight', () => {
    const positiveInstant = new Date('2026-09-11T18:00:00.000Z');
    const jakartaDate = getCurrentLocalDateString(positiveInstant, 'Asia/Jakarta');
    expect(jakartaDate).toBe('2026-09-12');
    expect(buildCompactSystemInstruction(mockAccounts, mockCategories, jakartaDate, 'Asia/Jakarta'))
      .toContain('Current Date: 2026-09-12');

    const negativeInstant = new Date('2026-09-12T02:00:00.000Z');
    const nyDate = getCurrentLocalDateString(negativeInstant, 'America/New_York');
    expect(nyDate).toBe('2026-09-11');
    expect(buildCompactSystemInstruction(mockAccounts, mockCategories, nyDate, 'America/New_York'))
      .toContain('Current Date: 2026-09-11');

    process.env.APP_TIMEZONE = 'Asia/Jakarta';
    const provider = new GeminiAiProvider('mock-gemini-key');
    const before = provider.getSystemInstruction(mockAccounts, mockCategories, new Date('2026-09-11T16:59:00.000Z'));
    const beforeKey = provider.getSystemInstructionCacheKey();
    expect(beforeKey).toContain('2026-09-11');
    expect(before).toContain('Current Date: 2026-09-11');

    const sameDay = provider.getSystemInstruction(mockAccounts, mockCategories, new Date('2026-09-11T16:59:30.000Z'));
    expect(sameDay).toBe(before);

    const after = provider.getSystemInstruction(mockAccounts, mockCategories, new Date('2026-09-11T17:01:00.000Z'));
    const afterKey = provider.getSystemInstructionCacheKey();
    expect(afterKey).toContain('2026-09-12');
    expect(after).toContain('Current Date: 2026-09-12');
    expect(after).not.toBe(before);
  });

  it('15. keeps tadi malam on the current local date while semalam targets yesterday', () => {
    const eveningReference = new Date('2026-09-11T15:30:00.000Z');
    const tadiMalam = parseRelativeTime('tadi malam makan 50rb', eveningReference, defaultTimezone);
    expect(tadiMalam).not.toBeNull();
    expect(tadiMalam?.dayReference).toBe('today');
    expect(tadiMalam?.targetDateString).toBe('2026-09-11');
    expect(tadiMalam?.targetHour).toBe(20);
    expect(tadiMalam?.targetMinute).toBe(0);
    expect(tadiMalam?.resolvedUtcIso).toBe('2026-09-11T13:00:00.000Z');

    const semalam = parseRelativeTime('semalam makan sate 50rb', eveningReference, defaultTimezone);
    expect(semalam?.dayReference).toBe('yesterday');
    expect(semalam?.targetDateString).toBe('2026-09-10');
    expect(semalam?.resolvedUtcIso).toBe('2026-09-10T13:00:00.000Z');
  });

  it('16. anchors relative time to the request instant across a local-midnight boundary', () => {
    const requestStart = new Date('2026-09-11T16:59:55.000Z');
    const validationCompleted = new Date('2026-09-11T17:00:05.000Z');
    const records = [{
      accountId: 'acc-cash', amount: -50000, recordDate: requestStart.toISOString(), note: 'makan sate',
    }];

    const anchored = validateAndSanitizeFinancialRecords(
      records, mockAccounts, mockCategories, 'kemarin malam makan sate 50rb', requestStart
    );
    const fast = validateAndSanitizeFinancialRecords(
      records, mockAccounts, mockCategories, 'kemarin malam makan sate 50rb', new Date('2026-09-11T16:59:58.000Z')
    );
    expect(anchored.sanitizedRecords[0].recordDate).toBe('2026-09-10T13:00:00.000Z');
    expect(anchored.sanitizedRecords[0].recordDate).toBe(fast.sanitizedRecords[0].recordDate);

    const drifted = validateAndSanitizeFinancialRecords(
      records, mockAccounts, mockCategories, 'kemarin malam makan sate 50rb', validationCompleted
    );
    expect(drifted.sanitizedRecords[0].recordDate).toBe('2026-09-11T13:00:00.000Z');
    expect(anchored.sanitizedRecords[0].recordDate).not.toBe(drifted.sanitizedRecords[0].recordDate);
  });

  it('17. invalidates Gemini system-instruction cache when DST offset changes on the same local date', () => {
    process.env.APP_TIMEZONE = 'America/New_York';
    const provider = new GeminiAiProvider('test-api-key', 'gemini-3.6-flash', []);
    const beforeInstant = new Date('2026-11-01T05:30:00.000Z');
    expect(getCurrentLocalDateString(beforeInstant, 'America/New_York')).toBe('2026-11-01');
    const before = provider.getSystemInstruction(mockAccounts, mockCategories, beforeInstant);
    const beforeKey = provider.getSystemInstructionCacheKey();
    expect(beforeKey).toContain('-04:00');
    expect(before).toContain('Offset: UTC-04:00');

    const afterInstant = new Date('2026-11-01T07:30:00.000Z');
    expect(getCurrentLocalDateString(afterInstant, 'America/New_York')).toBe('2026-11-01');
    const after = provider.getSystemInstruction(mockAccounts, mockCategories, afterInstant);
    const afterKey = provider.getSystemInstructionCacheKey();
    expect(afterKey).toContain('-05:00');
    expect(after).toContain('Offset: UTC-05:00');
    expect(after).not.toBe(before);
  });

  it('18. validates APP_TIMEZONE fail-closed while keeping the unset default', () => {
    const baseConfig: ApplicationEnvironmentConfiguration = {
      aiProvider: 'gemini',
      aiProviders: ['gemini'],
      aiApiKey: '',
      aiBaseUrl: '',
      aiModel: 'gemini-3.6-flash',
      aiFallbackModels: [],
      aiRequestTimeoutMilliseconds: 20000,
      geminiApiKey: 'test-gemini-key',
      geminiModel: 'gemini-3.6-flash',
      geminiFallbackModels: [],
      geminiRequestTimeoutMilliseconds: 20000,
      walletMcpBaseUrl: 'https://mcp.wallet.budgetbakers.com',
      walletMcpAccessToken: 'test-wallet-token',
      allowedPhoneNumber: '6281234567890',
      whatsappSessionPath: './test_session',
      telegramBotToken: '',
      telegramAllowedUserId: '',
      enabledMessengerChannels: ['whatsapp'],
      logRetentionDays: 7,
      emailSyncEnabled: false,
      emailImapHost: 'imap.gmail.com',
      emailImapPort: 993,
      emailImapUser: '',
      emailImapPassword: '',
      emailLookbackMinutes: 10,
      appLanguage: 'id',
      defaultCurrency: 'IDR',
      appTimezone: 'Asia/Jakarta',
      whatsappMaxReconnectAttempts: 6,
      whatsappReconnectMaxBackoffSeconds: 300,
      whatsappMessageQueueIntervalMs: 1000,
      whatsappTypingPresenceCooldownMs: 15000,
      telegramMaxStartupAttempts: 5,
      telegramStartupRetryDelayMs: 3000,
      maxMediaDownloadMb: 15,
    };

    const valid = validateApplicationConfiguration({ ...baseConfig, appTimezone: 'America/New_York' });
    expect(valid.isValid).toBe(true);
    expect(valid.errors.filter(issue => issue.variableName === 'APP_TIMEZONE')).toHaveLength(0);

    delete process.env.APP_TIMEZONE;
    expect(loadEnvironmentConfiguration().appTimezone).toBe('Asia/Jakarta');

    const typo = validateApplicationConfiguration({ ...baseConfig, appTimezone: 'America/New_Yrok' });
    expect(typo.isValid).toBe(false);
    expect(typo.errors.some(issue => issue.variableName === 'APP_TIMEZONE')).toBe(true);
  });

  it('19. resolves local timestamps with target-date DST offsets independently of request date and preserves explicit offsets', () => {
    process.env.APP_TIMEZONE = 'America/New_York';
    const estRequest = new Date('2026-11-15T15:00:00.000Z');
    const edtRequest = new Date('2026-07-15T15:00:00.000Z');

    const julyFromEst = validateAndSanitizeFinancialRecords(
      [{ accountId: 'acc-cash', amount: -25, recordDate: '2026-07-15T11:54:00' }],
      mockAccounts, mockCategories, 'Lunch receipt', estRequest
    );
    expect(julyFromEst.isValid).toBe(true);
    expect(julyFromEst.sanitizedRecords[0].recordDate).toBe('2026-07-15T15:54:00.000Z');
    const julyFromEdt = validateAndSanitizeFinancialRecords(
      [{ accountId: 'acc-cash', amount: -25, recordDate: '2026-07-15T11:54:00' }],
      mockAccounts, mockCategories, 'Lunch receipt', edtRequest
    );
    expect(julyFromEdt.sanitizedRecords[0].recordDate).toBe('2026-07-15T15:54:00.000Z');
    expect(julyFromEst.sanitizedRecords[0].recordDate).toBe(julyFromEdt.sanitizedRecords[0].recordDate);

    const novemberFromEdt = validateAndSanitizeFinancialRecords(
      [{ accountId: 'acc-cash', amount: -30, recordDate: '2026-11-15T11:54:00' }],
      mockAccounts, mockCategories, 'Dinner receipt', edtRequest
    );
    expect(novemberFromEdt.isValid).toBe(true);
    expect(novemberFromEdt.sanitizedRecords[0].recordDate).toBe('2026-11-15T16:54:00.000Z');
    const novemberFromEst = validateAndSanitizeFinancialRecords(
      [{ accountId: 'acc-cash', amount: -30, recordDate: '2026-11-15T11:54:00' }],
      mockAccounts, mockCategories, 'Dinner receipt', estRequest
    );
    expect(novemberFromEst.sanitizedRecords[0].recordDate).toBe('2026-11-15T16:54:00.000Z');
    expect(novemberFromEdt.sanitizedRecords[0].recordDate).toBe(novemberFromEst.sanitizedRecords[0].recordDate);

    const explicitOffset = validateAndSanitizeFinancialRecords(
      [{ accountId: 'acc-cash', amount: -15, recordDate: '2026-07-15T11:54:00-05:00' }],
      mockAccounts, mockCategories, 'Coffee in Bogotá', estRequest
    );
    expect(explicitOffset.isValid).toBe(true);
    expect(explicitOffset.sanitizedRecords[0].recordDate).toBe('2026-07-15T16:54:00.000Z');

    const localTimestamp = validateAndSanitizeFinancialRecords(
      [{ accountId: 'acc-cash', amount: -15, recordDate: '2026-07-15T11:54:00' }],
      mockAccounts, mockCategories, 'Coffee in New York', estRequest
    );
    expect(localTimestamp.sanitizedRecords[0].recordDate).toBe('2026-07-15T15:54:00.000Z');
    expect(resolveTargetLocalToUtcIso('2026-07-15', 11, 54, 'America/New_York')).toBe('2026-07-15T15:54:00.000Z');
    expect(resolveTargetLocalToUtcIso('2026-11-15', 11, 54, 'America/New_York')).toBe('2026-11-15T16:54:00.000Z');
  });

  it('20. fails closed for nonexistent DST-gap wall clocks while accepting neighboring and deterministic overlap times', () => {
    process.env.APP_TIMEZONE = 'America/New_York';
    let error: Error | null = null;
    try {
      resolveTargetLocalToUtcIso('2026-03-08', 2, 30, 'America/New_York');
    } catch (caught) {
      error = caught as Error;
    }
    expect(error).toBeInstanceOf(RangeError);
    expect(error?.message).toContain('Nonexistent local wall-clock time');

    assert.throws(
      () => parseRelativeTime('this morning at 2:30am', new Date('2026-03-08T12:00:00.000Z'), 'America/New_York'),
      (caught: unknown) => caught instanceof RangeError
    );

    const contextual = validateAndSanitizeFinancialRecords(
      [{ accountId: 'acc-cash', amount: -10, recordDate: '2026-03-08T07:30:00.000Z' }],
      mockAccounts, mockCategories, 'this morning at 2:30am coffee', new Date('2026-03-08T12:00:00.000Z')
    );
    expect(contextual.isValid).toBe(false);
    expect(contextual.validationErrors.some(validationError =>
      validationError.includes('Waktu transaksi tidak valid pada timezone America/New_York')
    )).toBe(true);
    expect(contextual.sanitizedRecords).toHaveLength(0);

    const direct = validateAndSanitizeFinancialRecords(
      [{ accountId: 'acc-cash', amount: -10, recordDate: '2026-03-08T02:30:00' }],
      mockAccounts, mockCategories, 'Coffee during DST gap', new Date('2026-03-08T12:00:00.000Z')
    );
    expect(direct.isValid).toBe(false);
    expect(direct.sanitizedRecords).toHaveLength(0);

    const pre = validateAndSanitizeFinancialRecords(
      [{ accountId: 'acc-cash', amount: -10 }],
      mockAccounts, mockCategories, 'this morning at 1:30am coffee', new Date('2026-03-08T12:00:00.000Z')
    );
    expect(pre.isValid).toBe(true);
    expect(pre.sanitizedRecords[0].recordDate).toBe('2026-03-08T06:30:00.000Z');

    const post = validateAndSanitizeFinancialRecords(
      [{ accountId: 'acc-cash', amount: -10 }],
      mockAccounts, mockCategories, 'this morning at 3:30am coffee', new Date('2026-03-08T12:00:00.000Z')
    );
    expect(post.isValid).toBe(true);
    expect(post.sanitizedRecords[0].recordDate).toBe('2026-03-08T07:30:00.000Z');
    expect(resolveTargetLocalToUtcIso('2026-03-08', 1, 30, 'America/New_York')).toBe('2026-03-08T06:30:00.000Z');
    expect(resolveTargetLocalToUtcIso('2026-03-08', 3, 30, 'America/New_York')).toBe('2026-03-08T07:30:00.000Z');
    expect(resolveTargetLocalToUtcIso('2026-11-01', 1, 30, 'America/New_York')).toBe('2026-11-01T06:30:00.000Z');
  });

  it('21. provides shared calendar-day/range helpers with half-open UTC interval invariants', () => {
    expect(getNextLocalDateString('2026-09-11')).toBe('2026-09-12');
    expect(getNextLocalDateString('2026-09-30')).toBe('2026-10-01');
    expect(getNextLocalDateString('2024-02-28')).toBe('2024-02-29');
    expect(getNextLocalDateString('2024-02-29')).toBe('2024-03-01');
    expect(getNextLocalDateString('2026-12-31')).toBe('2027-01-01');

    const explicit = resolveLocalCalendarDayRange('2026-09-11', 'Asia/Jakarta');
    expect(explicit).toEqual(['gte.2026-09-10T17:00:00.000Z', 'lt.2026-09-11T17:00:00.000Z']);
    const fromInstant = resolveLocalCalendarDayRange(new Date('2026-09-11T05:30:00.000Z'), 'Asia/Jakarta');
    expect(fromInstant).toEqual(explicit);

    const lower = explicit[0].replace('gte.', '');
    const upper = explicit[1].replace('lt.', '');
    expect('2026-09-10T17:30:00.000Z' >= lower && '2026-09-10T17:30:00.000Z' < upper).toBe(true);
    expect('2026-09-11T16:30:00.000Z' >= lower && '2026-09-11T16:30:00.000Z' < upper).toBe(true);
    expect('2026-09-11T17:05:00.000Z' >= upper).toBe(true);

    const multiDay = resolveLocalCalendarRange('2026-09-01', '2026-09-30', 'Asia/Jakarta');
    expect(multiDay).toEqual(['gte.2026-08-31T17:00:00.000Z', 'lt.2026-09-30T17:00:00.000Z']);
    expect(resolveLocalCalendarRange('2026-09-11', '2026-09-11', 'Asia/Jakarta')).toEqual(explicit);
  });
});
