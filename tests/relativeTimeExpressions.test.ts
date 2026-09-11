import assert from 'node:assert';
import {
  parseRelativeTime,
  getLocalTimeParts,
  getPreviousLocalDateString,
  getCurrentLocalDateString,
  formatLocalToUtcIso,
  resolveTargetLocalToUtcIso,
  formatLocalTimeAnchor,
  PERIOD_REPRESENTATIVE_HOURS,
} from '../src/utils/relativeTimeParser.js';
import {
  buildCompactSystemInstruction,
  buildTextMessagePrompt,
} from '../src/services/ai/aiPromptBuilder.js';
import { GeminiAiProvider } from '../src/services/ai/geminiAiProvider.js';
import { validateAndSanitizeFinancialRecords } from '../src/utils/recordValidator.js';
import { WalletAccountItem, WalletCategoryItem } from '../src/types/walletTypes.js';
import {
  loadEnvironmentConfiguration,
  validateApplicationConfiguration,
  ApplicationEnvironmentConfiguration,
} from '../src/config/environmentConfig.js';
import { setActiveLanguage } from '../src/i18n/index.js';
import { applicationLogger } from '../src/utils/logger.js';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import { AccountClarificationHandler } from '../src/handlers/accountClarificationHandler.js';
import { WalletCacheService } from '../src/services/walletCacheService.js';
import { WalletMcpClientService } from '../src/services/walletMcpService.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/types.js';

function assertCondition(condition: boolean, testDescription: string): void {
  try {
    assert.ok(condition, testDescription);
    applicationLogger.success(`[PASS] ${testDescription}`);
  } catch (error) {
    applicationLogger.error(`[FAIL] ${testDescription}`);
    throw error;
  }
}

async function runRelativeTimeExpressionsTestSuite(): Promise<void> {
  console.log('\n======================================================');
  applicationLogger.info('Starting Natural Language Relative Time Test Suite...');
  console.log('======================================================\n');

  // Fixed reference timestamp: Friday, 2026-09-11 14:15:00 WIB (UTC: 2026-09-11 07:15:00Z)
  const fixedReferenceUtc = new Date('2026-09-11T07:15:00.000Z');
  const defaultTimezone = 'Asia/Jakarta';

  // Test 1: Local Date Extraction and Previous Date Calculation
  applicationLogger.info('TEST 1: Local Date Extraction and Date Boundary Calculations');
  const localParts = getLocalTimeParts(fixedReferenceUtc, defaultTimezone);
  assertCondition(localParts.dateString === '2026-09-11', 'Local dateString resolves to 2026-09-11 in Asia/Jakarta');
  assertCondition(localParts.hour === 14 && localParts.minute === 15, 'Local time resolves to 14:15 in Asia/Jakarta');
  assertCondition(localParts.formattedOffset === '+07:00', 'Local offset is +07:00');

  const previousDate = getPreviousLocalDateString('2026-09-11');
  assertCondition(previousDate === '2026-09-10', 'Previous date of 2026-09-11 is 2026-09-10');

  // Month boundary rollover
  const monthRolloverDate = getPreviousLocalDateString('2026-03-01');
  assertCondition(monthRolloverDate === '2026-02-28', 'Month boundary rollover from 2026-03-01 is 2026-02-28');

  // Year boundary rollover
  const yearRolloverDate = getPreviousLocalDateString('2027-01-01');
  assertCondition(yearRolloverDate === '2026-12-31', 'Year boundary rollover from 2027-01-01 is 2026-12-31');

  // Test 2: Indonesian "tadi" + period expressions (representative times)
  applicationLogger.info('\nTEST 2: Indonesian "tadi" + Period Expressions (Representative Times)');
  // tadi pagi -> today 08:00 WIB -> UTC 01:00
  const tadiPagi = parseRelativeTime('tadi pagi beli bensin 30rb', fixedReferenceUtc, defaultTimezone);
  assertCondition(tadiPagi !== null, 'tadi pagi matches');
  assertCondition(
    tadiPagi?.resolvedUtcIso === '2026-09-11T01:00:00.000Z',
    `tadi pagi resolves to 2026-09-11T01:00:00.000Z (got: ${tadiPagi?.resolvedUtcIso})`
  );
  assertCondition(tadiPagi?.dayReference === 'today', 'tadi pagi references today');
  assertCondition(!tadiPagi?.hasExplicitTime, 'tadi pagi uses inferred representative time');

  // tadi siang -> today 12:30 WIB -> UTC 05:30
  const tadiSiang = parseRelativeTime('tadi siang makan padang 25rb', fixedReferenceUtc, defaultTimezone);
  assertCondition(
    tadiSiang?.resolvedUtcIso === '2026-09-11T05:30:00.000Z',
    `tadi siang resolves to 2026-09-11T05:30:00.000Z (got: ${tadiSiang?.resolvedUtcIso})`
  );

  // tadi sore -> today 16:30 WIB -> UTC 09:30
  const tadiSore = parseRelativeTime('tadi sore ngopi 20rb', fixedReferenceUtc, defaultTimezone);
  assertCondition(
    tadiSore?.resolvedUtcIso === '2026-09-11T09:30:00.000Z',
    `tadi sore resolves to 2026-09-11T09:30:00.000Z (got: ${tadiSore?.resolvedUtcIso})`
  );

  // tadi subuh -> today 05:00 WIB -> UTC 22:00 on previous day (day boundary rollover!)
  const tadiSubuh = parseRelativeTime('tadi subuh isi bensin 50rb', fixedReferenceUtc, defaultTimezone);
  assertCondition(
    tadiSubuh?.resolvedUtcIso === '2026-09-10T22:00:00.000Z',
    `tadi subuh (05:00 WIB) correctly rolls over to UTC previous day: 2026-09-10T22:00:00.000Z (got: ${tadiSubuh?.resolvedUtcIso})`
  );

  // Test 3: Indonesian "kemarin", "semalam", and "tadi malam" expressions
  applicationLogger.info('\nTEST 3: Indonesian "kemarin", "semalam", and "tadi malam" Expressions');
  // semalam -> yesterday 20:00 WIB -> UTC 13:00 on 2026-09-10
  const semalam = parseRelativeTime('semalam makan sate 50rb', fixedReferenceUtc, defaultTimezone);
  assertCondition(
    semalam?.resolvedUtcIso === '2026-09-10T13:00:00.000Z',
    `semalam resolves to yesterday malam 2026-09-10T13:00:00.000Z (got: ${semalam?.resolvedUtcIso})`
  );
  assertCondition(semalam?.dayReference === 'yesterday', 'semalam references yesterday');

  // semalem (colloquial) -> yesterday 20:00 WIB
  const semalemColloquial = parseRelativeTime('semalem jajan boba 25rb', fixedReferenceUtc, defaultTimezone);
  assertCondition(
    semalemColloquial?.resolvedUtcIso === '2026-09-10T13:00:00.000Z',
    `semalem resolves to yesterday malam (got: ${semalemColloquial?.resolvedUtcIso})`
  );

  // tadi malam / tadi malem -> today 20:00 WIB (aligned with Issue #4 tadi + period contract)
  const tadiMalam = parseRelativeTime('tadi malam nonton bioskop 60rb', fixedReferenceUtc, defaultTimezone);
  assertCondition(
    tadiMalam?.resolvedUtcIso === '2026-09-11T13:00:00.000Z',
    `tadi malam resolves to today malam 2026-09-11T13:00:00.000Z (got: ${tadiMalam?.resolvedUtcIso})`
  );
  assertCondition(tadiMalam?.dayReference === 'today', 'tadi malam references today');

  // kemarin malam / kemarin malem -> yesterday 20:00 WIB
  const kemarinMalam = parseRelativeTime('kemarin malem makan sate 50rb pake cash', fixedReferenceUtc, defaultTimezone);
  assertCondition(
    kemarinMalam?.resolvedUtcIso === '2026-09-10T13:00:00.000Z',
    `kemarin malem resolves to 2026-09-10T13:00:00.000Z (got: ${kemarinMalam?.resolvedUtcIso})`
  );

  // kemarin sore -> yesterday 16:30 WIB -> UTC 09:30
  const kemarinSore = parseRelativeTime('kemarin sore beli roti 15rb', fixedReferenceUtc, defaultTimezone);
  assertCondition(
    kemarinSore?.resolvedUtcIso === '2026-09-10T09:30:00.000Z',
    `kemarin sore resolves to 2026-09-10T09:30:00.000Z (got: ${kemarinSore?.resolvedUtcIso})`
  );

  // kemarin siang -> yesterday 12:30 WIB -> UTC 05:30
  const kemarinSiang = parseRelativeTime('kemarin siang makan bakso 20rb', fixedReferenceUtc, defaultTimezone);
  assertCondition(
    kemarinSiang?.resolvedUtcIso === '2026-09-10T05:30:00.000Z',
    `kemarin siang resolves to 2026-09-10T05:30:00.000Z (got: ${kemarinSiang?.resolvedUtcIso})`
  );

  // kemaren pagi (colloquial) -> yesterday 08:00 WIB -> UTC 01:00
  const kemarenPagi = parseRelativeTime('kemaren pagi sarapan bubur 15rb', fixedReferenceUtc, defaultTimezone);
  assertCondition(
    kemarenPagi?.resolvedUtcIso === '2026-09-10T01:00:00.000Z',
    `kemaren pagi resolves to 2026-09-10T01:00:00.000Z (got: ${kemarenPagi?.resolvedUtcIso})`
  );

  // Test 4: Explicit User-Provided Clock Overrides
  applicationLogger.info('\nTEST 4: Explicit Clock Overrides Over Inferred Representative Times');
  // tadi pagi jam 7 -> today 07:00 WIB (overrides pagi default 08:00) -> UTC 00:00
  const tadiPagiJam7 = parseRelativeTime('tadi pagi jam 7 beli bensin 30rb', fixedReferenceUtc, defaultTimezone);
  assertCondition(tadiPagiJam7?.hasExplicitTime === true, 'Explicit time flag is true');
  assertCondition(
    tadiPagiJam7?.resolvedUtcIso === '2026-09-11T00:00:00.000Z',
    `tadi pagi jam 7 overrides default to 2026-09-11T00:00:00.000Z (got: ${tadiPagiJam7?.resolvedUtcIso})`
  );

  // kemarin jam 3 sore -> yesterday 15:00 WIB (overrides sore default 16:30) -> UTC 08:00
  const kemarinJam3Sore = parseRelativeTime('kemarin jam 3 sore ngopi 35rb', fixedReferenceUtc, defaultTimezone);
  assertCondition(
    kemarinJam3Sore?.resolvedUtcIso === '2026-09-10T08:00:00.000Z',
    `kemarin jam 3 sore resolves to 15:00 local / 2026-09-10T08:00:00.000Z (got: ${kemarinJam3Sore?.resolvedUtcIso})`
  );

  // semalam jam 9 -> yesterday 21:00 WIB (overrides malam default 20:00) -> UTC 14:00
  const semalamJam9 = parseRelativeTime('semalam jam 9 martabak 45rb', fixedReferenceUtc, defaultTimezone);
  assertCondition(
    semalamJam9?.resolvedUtcIso === '2026-09-10T14:00:00.000Z',
    `semalam jam 9 resolves to 21:00 local / 2026-09-10T14:00:00.000Z (got: ${semalamJam9?.resolvedUtcIso})`
  );

  // tadi jam 2 siang -> today 14:00 WIB -> UTC 07:00
  const tadiJam2Siang = parseRelativeTime('tadi jam 2 siang makan siang 30rb', fixedReferenceUtc, defaultTimezone);
  assertCondition(
    tadiJam2Siang?.resolvedUtcIso === '2026-09-11T07:00:00.000Z',
    `tadi jam 2 siang resolves to 14:00 local / 2026-09-11T07:00:00.000Z (got: ${tadiJam2Siang?.resolvedUtcIso})`
  );

  // Test 5: English Relative Time Expressions (i18n)
  applicationLogger.info('\nTEST 5: English Relative Time Expressions (i18n)');
  // this morning -> today 08:00
  const thisMorning = parseRelativeTime('this morning bought gas 30k', fixedReferenceUtc, defaultTimezone);
  assertCondition(
    thisMorning?.resolvedUtcIso === '2026-09-11T01:00:00.000Z',
    `this morning resolves to 2026-09-11T01:00:00.000Z (got: ${thisMorning?.resolvedUtcIso})`
  );

  // this afternoon -> today 12:30
  const thisAfternoon = parseRelativeTime('this afternoon lunch 50k', fixedReferenceUtc, defaultTimezone);
  assertCondition(
    thisAfternoon?.resolvedUtcIso === '2026-09-11T05:30:00.000Z',
    `this afternoon resolves to 2026-09-11T05:30:00.000Z (got: ${thisAfternoon?.resolvedUtcIso})`
  );

  // last night -> yesterday 20:00
  const lastNight = parseRelativeTime('last night had dinner 100k', fixedReferenceUtc, defaultTimezone);
  assertCondition(
    lastNight?.resolvedUtcIso === '2026-09-10T13:00:00.000Z',
    `last night resolves to 2026-09-10T13:00:00.000Z (got: ${lastNight?.resolvedUtcIso})`
  );

  // yesterday morning -> yesterday 08:00
  const yesterdayMorning = parseRelativeTime('yesterday morning breakfast 25k', fixedReferenceUtc, defaultTimezone);
  assertCondition(
    yesterdayMorning?.resolvedUtcIso === '2026-09-10T01:00:00.000Z',
    `yesterday morning resolves to 2026-09-10T01:00:00.000Z (got: ${yesterdayMorning?.resolvedUtcIso})`
  );

  // this morning at 7am -> today 07:00
  const thisMorning7am = parseRelativeTime('this morning at 7am bought coffee', fixedReferenceUtc, defaultTimezone);
  assertCondition(
    thisMorning7am?.resolvedUtcIso === '2026-09-11T00:00:00.000Z',
    `this morning at 7am overrides to 2026-09-11T00:00:00.000Z (got: ${thisMorning7am?.resolvedUtcIso})`
  );

  // yesterday at 3pm -> yesterday 15:00
  const yesterday3pm = parseRelativeTime('yesterday at 3pm grocery 120k', fixedReferenceUtc, defaultTimezone);
  assertCondition(
    yesterday3pm?.resolvedUtcIso === '2026-09-10T08:00:00.000Z',
    `yesterday at 3pm resolves to 2026-09-10T08:00:00.000Z (got: ${yesterday3pm?.resolvedUtcIso})`
  );

  // Test 6: Multi-Timezone Conversion Boundaries
  applicationLogger.info('\nTEST 6: Multi-Timezone Conversion Boundaries (WITA & WIT)');
  // In Asia/Makassar (+08:00 / WITA):
  // tadi pagi (08:00 WITA) -> UTC is 08:00 - 8 hours = 00:00 on 2026-09-11
  const makassarTadiPagi = parseRelativeTime('tadi pagi sarapan coto 30rb', fixedReferenceUtc, 'Asia/Makassar');
  assertCondition(
    makassarTadiPagi?.resolvedUtcIso === '2026-09-11T00:00:00.000Z',
    `Asia/Makassar (+08:00) tadi pagi (08:00 local) is UTC 2026-09-11T00:00:00.000Z (got: ${makassarTadiPagi?.resolvedUtcIso})`
  );

  // In Asia/Jayapura (+09:00 / WIT):
  // tadi pagi (08:00 WIT) -> UTC is 08:00 - 9 hours = 23:00 on previous day 2026-09-10!
  const jayapuraTadiPagi = parseRelativeTime('tadi pagi sarapan papeda 25rb', fixedReferenceUtc, 'Asia/Jayapura');
  assertCondition(
    jayapuraTadiPagi?.resolvedUtcIso === '2026-09-10T23:00:00.000Z',
    `Asia/Jayapura (+09:00) tadi pagi (08:00 local) rolls to UTC 2026-09-10T23:00:00.000Z (got: ${jayapuraTadiPagi?.resolvedUtcIso})`
  );

  // Test 7: Integration with validateAndSanitizeFinancialRecords
  applicationLogger.info('\nTEST 7: Record Validator Integration with Relative Time Normalization');
  process.env.APP_TIMEZONE = 'Asia/Jakarta';

  const mockAccounts: WalletAccountItem[] = [
    { id: 'acc-cash', name: 'Cash', currency: 'IDR', accountType: 'Cash' },
  ];
  const mockCategories: WalletCategoryItem[] = [
    { id: 'cat-food', name: 'Food' },
  ];

  // AI extracted transaction where user message had 'kemarin malem makan sate 50rb pake cash'
  const validationResultKemarin = validateAndSanitizeFinancialRecords(
    [
      {
        accountId: 'acc-cash',
        amount: -50000,
        recordDate: '2026-09-11T07:15:00.000Z', // Arrival time returned by AI
        note: 'makan sate',
      },
    ],
    mockAccounts,
    mockCategories,
    'kemarin malem makan sate 50rb pake cash',
    fixedReferenceUtc
  );

  assertCondition(validationResultKemarin.isValid, 'Validation succeeds');
  assertCondition(
    validationResultKemarin.sanitizedRecords[0].recordDate === '2026-09-10T13:00:00.000Z',
    `Record date normalized to yesterday night UTC 2026-09-10T13:00:00.000Z (got: ${validationResultKemarin.sanitizedRecords[0].recordDate})`
  );

  // AI extracted transaction where user message had 'tadi pagi beli bensin 30rb'
  const validationResultTadiPagi = validateAndSanitizeFinancialRecords(
    [
      {
        accountId: 'acc-cash',
        amount: -30000,
        recordDate: '2026-09-11T07:15:00.000Z',
        note: 'beli bensin',
      },
    ],
    mockAccounts,
    mockCategories,
    'tadi pagi beli bensin 30rb',
    fixedReferenceUtc
  );

  assertCondition(
    validationResultTadiPagi.sanitizedRecords[0].recordDate === '2026-09-11T01:00:00.000Z',
    `Record date normalized to today pagi UTC 2026-09-11T01:00:00.000Z (got: ${validationResultTadiPagi.sanitizedRecords[0].recordDate})`
  );

  // AI extracted transaction where user message had NO relative expression: 'beli pulsa 50rb'
  const validationResultStandard = validateAndSanitizeFinancialRecords(
    [
      {
        accountId: 'acc-cash',
        amount: -50000,
        recordDate: '2026-09-11T07:15:00.000Z',
        note: 'beli pulsa',
      },
    ],
    mockAccounts,
    mockCategories,
    'beli pulsa 50rb',
    fixedReferenceUtc
  );

  assertCondition(
    validationResultStandard.sanitizedRecords[0].recordDate === '2026-09-11T07:15:00.000Z',
    'Standard transaction preserves original recordDate when no relative expression present'
  );

  // Test 8: Prompt Builder System Instruction & Time Anchor
  applicationLogger.info('\nTEST 8: System Instruction & Local Time Anchor Generation');
  setActiveLanguage('id');
  const systemInstructionId = buildCompactSystemInstruction(
    mockAccounts,
    mockCategories,
    '2026-09-11',
    'Asia/Jakarta'
  );
  assertCondition(
    systemInstructionId.includes('pagi / morning: 08:00') &&
      systemInstructionId.includes('siang / afternoon: 12:30') &&
      systemInstructionId.includes('sore / evening: 16:30') &&
      systemInstructionId.includes('malam / malem / night: 20:00') &&
      systemInstructionId.includes('subuh / early morning: 05:00'),
    'Indonesian system instruction contains representative times'
  );
  assertCondition(
    systemInstructionId.includes('Offset: UTC+07:00'),
    'Indonesian system instruction contains timezone offset'
  );

  setActiveLanguage('en');
  const systemInstructionEn = buildCompactSystemInstruction(
    mockAccounts,
    mockCategories,
    '2026-09-11',
    'Asia/Jakarta'
  );
  assertCondition(
    systemInstructionEn.includes('morning / pagi: 08:00') &&
      systemInstructionEn.includes('noon / afternoon / siang: 12:30') &&
      systemInstructionEn.includes('evening / sore: 16:30') &&
      systemInstructionEn.includes('night / malam / malem: 20:00'),
    'English system instruction contains representative times'
  );

  const textPrompt = buildTextMessagePrompt(
    'kemarin malem makan sate',
    '2026-09-11T07:15:00.000Z',
    'Asia/Jakarta'
  );
  assertCondition(
    textPrompt.includes('Local Date: 2026-09-11') && textPrompt.includes('Yesterday: 2026-09-10'),
    'Text prompt includes grounded local time anchor and yesterday date'
  );

  setActiveLanguage('id');

  // Test 9: Multi-Record Scoping: Preserve distinct dates across batch inputs (PR Comment 1)
  applicationLogger.info('\nTEST 9: Multi-Record Scoping (Distinct Dates across Batches)');
  const multiRecordBatchCaseA = [
    {
      accountId: 'acc-cash',
      amount: -30000,
      recordDate: '2026-09-11T01:00:00.000Z', // AI extracted tadi pagi
      note: 'beli bensin',
    },
    {
      accountId: 'acc-cash',
      amount: -60000,
      recordDate: '2026-09-10T13:00:00.000Z', // AI extracted kemarin malam
      note: 'nonton bioskop',
    },
  ];

  const validationResultMultiCaseA = validateAndSanitizeFinancialRecords(
    multiRecordBatchCaseA,
    mockAccounts,
    mockCategories,
    'tadi pagi beli bensin 30rb, kemarin malam nonton bioskop 60rb',
    fixedReferenceUtc
  );

  assertCondition(
    validationResultMultiCaseA.sanitizedRecords.length === 2,
    'Both records sanitized successfully'
  );
  assertCondition(
    validationResultMultiCaseA.sanitizedRecords[0].recordDate === '2026-09-11T01:00:00.000Z',
    `Record 1 preserves distinct date: 2026-09-11T01:00:00.000Z (got: ${validationResultMultiCaseA.sanitizedRecords[0].recordDate})`
  );
  assertCondition(
    validationResultMultiCaseA.sanitizedRecords[1].recordDate === '2026-09-10T13:00:00.000Z',
    `Record 2 preserves distinct date: 2026-09-10T13:00:00.000Z (got: ${validationResultMultiCaseA.sanitizedRecords[1].recordDate})`
  );
  assertCondition(
    validationResultMultiCaseA.sanitizedRecords[0].recordDate !== validationResultMultiCaseA.sanitizedRecords[1].recordDate,
    'Multi-record batch does not clobber record 2 with record 1 relative time expression'
  );

  // Case B: Relative expression present in record note
  const multiRecordBatchCaseB = [
    {
      accountId: 'acc-cash',
      amount: -15000,
      recordDate: '2026-09-11T07:15:00.000Z',
      note: 'beli bensin tadi pagi',
    },
    {
      accountId: 'acc-cash',
      amount: -25000,
      recordDate: '2026-09-11T07:15:00.000Z',
      note: 'makan bakso kemarin siang',
    },
  ];

  const validationResultMultiCaseB = validateAndSanitizeFinancialRecords(
    multiRecordBatchCaseB,
    mockAccounts,
    mockCategories,
    'beli bensin 15rb dan makan bakso 25rb',
    fixedReferenceUtc
  );

  assertCondition(
    validationResultMultiCaseB.sanitizedRecords[0].recordDate === '2026-09-11T01:00:00.000Z',
    'Record 1 resolved from note to today pagi (2026-09-11T01:00:00.000Z)'
  );
  assertCondition(
    validationResultMultiCaseB.sanitizedRecords[1].recordDate === '2026-09-10T05:30:00.000Z',
    'Record 2 resolved from note to yesterday siang (2026-09-10T05:30:00.000Z)'
  );

  // Test 10: Account Clarification across Midnight Boundary with sourceUserText & Hashes (PR Comment 6)
  applicationLogger.info('\nTEST 10: Account Clarification Across Midnight Boundary');
  const ambiguousAccounts: WalletAccountItem[] = [
    { id: 'acc-bca-1', name: 'BCA Personal', currency: 'IDR', accountType: 'General' },
    { id: 'acc-bca-2', name: 'BCA Business', currency: 'IDR', accountType: 'General' },
  ];

  // Request arrives before midnight: 2026-09-11 23:59:55 WIB (UTC: 2026-09-11 16:59:55Z)
  const requestStartReferenceUtc = new Date('2026-09-11T16:59:55.000Z');
  const ambiguousInputRecords: CreateRecordInputPayload[] = [
    {
      accountId: 'bca', // Ambiguous between BCA Personal and BCA Business
      amount: -50000,
      recordDate: '2026-09-11T16:59:55.000Z',
      note: 'makan sate #dinner',
    },
  ];

  // 1. Initial validation with contextual sourceUserText containing relative time and hashtag
  const day1ValidationResult = validateAndSanitizeFinancialRecords(
    ambiguousInputRecords,
    ambiguousAccounts,
    mockCategories,
    'kemarin malem makan sate 50rb #dinner bca',
    requestStartReferenceUtc
  );

  assertCondition(
    day1ValidationResult.isValid === false,
    'Day 1 validation fails due to ambiguous account'
  );
  assertCondition(
    day1ValidationResult.accountResolutionIssues.length === 1 &&
      day1ValidationResult.accountResolutionIssues[0].reason === 'AMBIGUOUS',
    'Day 1 returns ambiguous account resolution issue'
  );
  assertCondition(
    ambiguousInputRecords[0].recordDate === '2026-09-10T13:00:00.000Z',
    `Day 1 recordDate pre-normalized upfront into immutable UTC ISO string: 2026-09-10T13:00:00.000Z (got: ${ambiguousInputRecords[0].recordDate})`
  );

  // 2. Production path through AccountClarificationHandler and PendingTransactionService:
  // - Request arrived before midnight (requestStartReferenceUtc = 23:59:55 WIB)
  // - Clarification draft created with requestStartReferenceUtc
  // - Draft creation crosses midnight to 2026-09-12 00:00:05 WIB (UTC: 2026-09-11 17:00:05Z)
  // - User replies much later (e.g. Day 2 afternoon: 2026-09-12 14:00:00 WIB)
  const dispatchedMcpRecords: CreateRecordInputPayload[][] = [];
  const testSentMessages: string[] = [];

  const testPendingService = new PendingTransactionService();
  const testMcpClient = {
    fetchAccounts: async () => ambiguousAccounts,
    fetchCategories: async () => mockCategories,
    fetchLabels: async () => [{ id: 'lbl-dinner', name: 'dinner' }],
    createLabel: async (name: string) => ({ id: `lbl-${name}`, name }),
    createRecords: async (records: CreateRecordInputPayload[]) => {
      dispatchedMcpRecords.push(records.map(r => ({ ...r })));
      return { summary: { total: records.length, succeeded: records.length, failed: 0 } };
    },
    fetchBudgets: async () => [],
  } as unknown as WalletMcpClientService;

  const testCache = new WalletCacheService(testMcpClient);
  await testCache.initialize();

  const testMessagingGateway = {
    sendChatAction: async () => {},
    clearTypingPresence: async () => {},
    sendMessage: async (_channel: string, _chatId: string, content: string) => {
      testSentMessages.push(content);
    },
  };

  const testClarificationHandler = new AccountClarificationHandler(
    testPendingService,
    testMcpClient,
    testCache,
    testMessagingGateway as any
  );

  const initialIncomingEvent: IncomingUserMessageEvent = {
    channel: 'whatsapp',
    senderIdentifier: '+628123456789',
    chatIdentifier: '+628123456789',
    messageType: 'text',
    textPayload: 'kemarin malem makan sate 50rb #dinner bca',
  };

  // Draft created with original requestReferenceInstant (23:59:55 WIB)
  await testClarificationHandler.createPendingAccountSelectionDraft(
    initialIncomingEvent,
    ambiguousInputRecords,
    day1ValidationResult.accountResolutionIssues,
    ambiguousAccounts,
    mockCategories,
    requestStartReferenceUtc
  );

  const createdDraft = testPendingService.getPendingAccountSelectionDraft(1);
  assertCondition(createdDraft !== undefined, 'Account clarification draft #1 created successfully');
  assertCondition(
    createdDraft?.sourceReferenceInstant?.toISOString() === requestStartReferenceUtc.toISOString(),
    `Draft preserves exact sourceReferenceInstant: ${requestStartReferenceUtc.toISOString()}`
  );

  // Simulate draft creation crossing midnight: createdAt is 2026-09-12 00:00:05 WIB (UTC 17:00:05Z)
  if (createdDraft) {
    createdDraft.createdAt = new Date('2026-09-11T17:00:05.000Z');
  }

  // Day 2 Afternoon: User replies to select option '1' (BCA Personal)
  // Reply arrives at 2026-09-12 14:00:00 WIB (UTC: 2026-09-12 07:00:00Z)
  const day2ReplyInstant = new Date('2026-09-12T07:00:00.000Z');
  const clarificationReplyHandled = await testClarificationHandler.handlePendingAccountSelectionReply(
    initialIncomingEvent,
    '1',
    day2ReplyInstant.getTime()
  );

  assertCondition(clarificationReplyHandled === true, 'Clarification reply handled successfully');
  assertCondition(dispatchedMcpRecords.length === 1, 'Finalized records dispatched to Wallet MCP');
  assertCondition(
    dispatchedMcpRecords[0][0].recordDate === '2026-09-10T13:00:00.000Z',
    `Finalized Wallet payload preserves exact normalized UTC timestamp: 2026-09-10T13:00:00.000Z (got: ${dispatchedMcpRecords[0][0].recordDate})`
  );
  assertCondition(
    dispatchedMcpRecords[0][0].accountId === 'acc-bca-1',
    `Finalized Wallet payload has resolved accountId acc-bca-1 (got: ${dispatchedMcpRecords[0][0].accountId})`
  );
  assertCondition(
    dispatchedMcpRecords[0][0].labels?.includes('dinner') === true,
    `Finalized Wallet payload retains hashtag label from sourceUserText: dinner (got: ${JSON.stringify(dispatchedMcpRecords[0][0].labels)})`
  );

  // Test 11: Daylight Saving Time (DST) Fall-Back and Spring-Forward Safety (PR Comment 3)
  applicationLogger.info('\nTEST 11: Daylight Saving Time (DST) Boundary Safety');
  const nyTimezone = 'America/New_York';

  // Fall-back: Clocks fall back on Sunday, Nov 1, 2026 from EDT (UTC-4) to EST (UTC-5).
  // Reference date: Nov 1, 2026 12:00:00 EST (UTC: 2026-11-01T17:00:00.000Z).
  // "yesterday at 8pm" targets Oct 31, 2026 20:00 EDT (UTC-4) -> UTC is 2026-11-01T00:00:00.000Z.
  const dstFallBackRefDate = new Date('2026-11-01T17:00:00.000Z');
  const fallBackResult = parseRelativeTime(
    'yesterday at 8pm groceries $50',
    dstFallBackRefDate,
    nyTimezone
  );
  assertCondition(
    fallBackResult?.resolvedUtcIso === '2026-11-01T00:00:00.000Z',
    `DST fall-back evaluates target Oct 31 EDT offset (-04:00) to 2026-11-01T00:00:00.000Z (got: ${fallBackResult?.resolvedUtcIso})`
  );

  const directFallBackUtc = resolveTargetLocalToUtcIso('2026-10-31', 20, 0, nyTimezone);
  assertCondition(
    directFallBackUtc === '2026-11-01T00:00:00.000Z',
    `resolveTargetLocalToUtcIso for Oct 31 20:00 in NY is 2026-11-01T00:00:00.000Z (got: ${directFallBackUtc})`
  );

  // Spring-forward: Clocks spring forward on Sunday, March 8, 2026 from EST (UTC-5) to EDT (UTC-4).
  // Reference date: March 8, 2026 12:00:00 EDT (UTC: 2026-03-08T16:00:00.000Z).
  // "yesterday at 8pm" targets March 7, 2026 20:00 EST (UTC-5) -> UTC is 2026-03-08T01:00:00.000Z.
  const dstSpringForwardRefDate = new Date('2026-03-08T16:00:00.000Z');
  const springForwardResult = parseRelativeTime(
    'yesterday at 8pm dinner $40',
    dstSpringForwardRefDate,
    nyTimezone
  );
  assertCondition(
    springForwardResult?.resolvedUtcIso === '2026-03-08T01:00:00.000Z',
    `DST spring-forward evaluates target March 7 EST offset (-05:00) to 2026-03-08T01:00:00.000Z (got: ${springForwardResult?.resolvedUtcIso})`
  );

  const directSpringForwardUtc = resolveTargetLocalToUtcIso('2026-03-07', 20, 0, nyTimezone);
  assertCondition(
    directSpringForwardUtc === '2026-03-08T01:00:00.000Z',
    `resolveTargetLocalToUtcIso for March 7 20:00 in NY is 2026-03-08T01:00:00.000Z (got: ${directSpringForwardUtc})`
  );

  // Test 12: Bare 24-Hour Clocks and Monetary Number Exclusion (PR Comment 4)
  applicationLogger.info('\nTEST 12: Bare 24-Hour Clocks and Monetary Number Exclusion');
  // Positive test 1: "kemarin 15.30 beli makan" (yesterday 15:30 WIB -> UTC 08:30)
  const bareClockIndonesianDot = parseRelativeTime(
    'kemarin 15.30 beli makan',
    fixedReferenceUtc,
    defaultTimezone
  );
  assertCondition(
    bareClockIndonesianDot?.hasExplicitTime === true &&
      bareClockIndonesianDot.targetHour === 15 &&
      bareClockIndonesianDot.targetMinute === 30,
    'kemarin 15.30 matches bare 24-hour clock with dot notation'
  );
  assertCondition(
    bareClockIndonesianDot?.resolvedUtcIso === '2026-09-10T08:30:00.000Z',
    `kemarin 15.30 resolves to 2026-09-10T08:30:00.000Z (got: ${bareClockIndonesianDot?.resolvedUtcIso})`
  );

  // Positive test 2: "yesterday 15:30 groceries" (yesterday 15:30 WIB -> UTC 08:30)
  const bareClockEnglishColon = parseRelativeTime(
    'yesterday 15:30 groceries',
    fixedReferenceUtc,
    defaultTimezone
  );
  assertCondition(
    bareClockEnglishColon?.hasExplicitTime === true &&
      bareClockEnglishColon.targetHour === 15 &&
      bareClockEnglishColon.targetMinute === 30,
    'yesterday 15:30 matches bare 24-hour clock with colon notation'
  );
  assertCondition(
    bareClockEnglishColon?.resolvedUtcIso === '2026-09-10T08:30:00.000Z',
    `yesterday 15:30 resolves to 2026-09-10T08:30:00.000Z (got: ${bareClockEnglishColon?.resolvedUtcIso})`
  );

  // Positive test 3: "tadi pagi 07:30 beli bensin" (today 07:30 WIB -> UTC 00:30)
  const bareClockTadiPagi = parseRelativeTime(
    'tadi pagi 07:30 beli bensin',
    fixedReferenceUtc,
    defaultTimezone
  );
  assertCondition(
    bareClockTadiPagi?.hasExplicitTime === true &&
      bareClockTadiPagi.targetHour === 7 &&
      bareClockTadiPagi.targetMinute === 30,
    'tadi pagi 07:30 matches bare 24-hour clock'
  );
  assertCondition(
    bareClockTadiPagi?.resolvedUtcIso === '2026-09-11T00:30:00.000Z',
    `tadi pagi 07:30 resolves to 2026-09-11T00:30:00.000Z (got: ${bareClockTadiPagi?.resolvedUtcIso})`
  );

  // Negative test 1: Monetary values like 50.000 or 20.000 must NOT match as times
  const monetaryInput50k = parseRelativeTime(
    'kemarin beli baju 50.000',
    fixedReferenceUtc,
    defaultTimezone
  );
  assertCondition(
    monetaryInput50k !== null && monetaryInput50k.hasExplicitTime === false,
    '50.000 is not falsely captured as clock time'
  );

  const monetaryInput20k = parseRelativeTime(
    'kemarin isi pulsa 20.000',
    fixedReferenceUtc,
    defaultTimezone
  );
  assertCondition(
    monetaryInput20k !== null && monetaryInput20k.hasExplicitTime === false,
    '20.000 is not falsely captured as clock time'
  );

  // Negative test 2: Monetary input with both clock time and currency
  const mixedTimeAndAmount = parseRelativeTime(
    'kemarin 15.30 makan sate 50.000',
    fixedReferenceUtc,
    defaultTimezone
  );
  assertCondition(
    mixedTimeAndAmount?.hasExplicitTime === true &&
      mixedTimeAndAmount.targetHour === 15 &&
      mixedTimeAndAmount.targetMinute === 30,
    'Correctly extracts 15.30 while ignoring 50.000'
  );

  // Test 13: Decimal Currency Exclusion Around Bare Clocks (PR Review Comment A)
  applicationLogger.info('\nTEST 13: Decimal Currency Exclusion Around Bare Clocks');
  // Currency code prefix with whitespace: "USD 15.30"
  const usdPrefixInput = parseRelativeTime(
    'yesterday spent USD 15.30 on lunch',
    fixedReferenceUtc,
    defaultTimezone
  );
  assertCondition(
    usdPrefixInput !== null && usdPrefixInput.hasExplicitTime === false,
    'USD 15.30 is not parsed as explicit clock time'
  );
  assertCondition(
    usdPrefixInput?.targetHour !== 15,
    'USD 15.30 does not override target hour to 15'
  );

  // Currency symbol prefix with whitespace: "$ 15.30"
  const dollarPrefixInput = parseRelativeTime(
    'kemarin bayar $ 15.30',
    fixedReferenceUtc,
    defaultTimezone
  );
  assertCondition(
    dollarPrefixInput !== null && dollarPrefixInput.hasExplicitTime === false,
    '$ 15.30 is not parsed as explicit clock time'
  );
  assertCondition(
    dollarPrefixInput?.targetHour !== 15,
    '$ 15.30 does not override target hour to 15'
  );

  // Currency code suffix: "15.30 EUR"
  const eurSuffixInput = parseRelativeTime(
    'yesterday spent 15.30 EUR',
    fixedReferenceUtc,
    defaultTimezone
  );
  assertCondition(
    eurSuffixInput !== null && eurSuffixInput.hasExplicitTime === false,
    '15.30 EUR is not parsed as explicit clock time'
  );
  assertCondition(
    eurSuffixInput?.targetHour !== 15,
    '15.30 EUR does not override target hour to 15'
  );

  // Currency word suffix: "15.30 dollars"
  const dollarsSuffixInput = parseRelativeTime(
    'yesterday spent 15.30 dollars on lunch',
    fixedReferenceUtc,
    defaultTimezone
  );
  assertCondition(
    dollarsSuffixInput !== null && dollarsSuffixInput.hasExplicitTime === false,
    '15.30 dollars is not parsed as explicit clock time'
  );
  assertCondition(
    dollarsSuffixInput?.targetHour !== 15,
    '15.30 dollars does not override target hour to 15'
  );

  // Common transaction verbs without positive temporal context: "yesterday paid 15.30 for lunch"
  const paidInput = parseRelativeTime(
    'yesterday paid 15.30 for lunch',
    fixedReferenceUtc,
    defaultTimezone
  );
  assertCondition(
    paidInput !== null && paidInput.hasExplicitTime === false,
    'yesterday paid 15.30 for lunch is not parsed as explicit clock time'
  );
  assertCondition(
    paidInput?.targetHour !== 15,
    'paid 15.30 does not override target hour to 15'
  );

  // Transaction verb "pay": "yesterday pay 15.30"
  const payInput = parseRelativeTime(
    'yesterday pay 15.30',
    fixedReferenceUtc,
    defaultTimezone
  );
  assertCondition(
    payInput !== null && payInput.hasExplicitTime === false,
    'yesterday pay 15.30 is not parsed as explicit clock time'
  );
  assertCondition(
    payInput?.targetHour !== 15,
    'pay 15.30 does not override target hour to 15'
  );

  // Indonesian transaction verb "beli": "kemarin beli 15.30 roti"
  const beliInput = parseRelativeTime(
    'kemarin beli 15.30 roti',
    fixedReferenceUtc,
    defaultTimezone
  );
  assertCondition(
    beliInput !== null && beliInput.hasExplicitTime === false,
    'kemarin beli 15.30 roti is not parsed as explicit clock time'
  );
  assertCondition(
    beliInput?.targetHour !== 15,
    'beli 15.30 does not override target hour to 15'
  );

  // Bare clock without currency: "yesterday 15.30 bought lunch"
  const bareClockLunch = parseRelativeTime(
    'yesterday 15.30 bought lunch',
    fixedReferenceUtc,
    defaultTimezone
  );
  assertCondition(
    bareClockLunch?.hasExplicitTime === true &&
      bareClockLunch.targetHour === 15 &&
      bareClockLunch.targetMinute === 30,
    'yesterday 15.30 bought lunch is preserved as explicit clock 15:30'
  );
  assertCondition(
    bareClockLunch?.resolvedUtcIso === '2026-09-10T08:30:00.000Z',
    `yesterday 15.30 bought lunch resolves to 2026-09-10T08:30:00.000Z (got: ${bareClockLunch?.resolvedUtcIso})`
  );

  // Explicit colon clock with "at": "yesterday at 15:30 groceries"
  const atColonClock = parseRelativeTime(
    'yesterday at 15:30 groceries',
    fixedReferenceUtc,
    defaultTimezone
  );
  assertCondition(
    atColonClock?.hasExplicitTime === true &&
      atColonClock.targetHour === 15 &&
      atColonClock.targetMinute === 30,
    'yesterday at 15:30 groceries is preserved as explicit clock 15:30'
  );
  assertCondition(
    atColonClock?.resolvedUtcIso === '2026-09-10T08:30:00.000Z',
    `yesterday at 15:30 groceries resolves to 2026-09-10T08:30:00.000Z (got: ${atColonClock?.resolvedUtcIso})`
  );

  // Indonesian bare clock: "kemarin 15.30 beli makan"
  const indonesianBareClock = parseRelativeTime(
    'kemarin 15.30 beli makan',
    fixedReferenceUtc,
    defaultTimezone
  );
  assertCondition(
    indonesianBareClock?.hasExplicitTime === true &&
      indonesianBareClock.targetHour === 15 &&
      indonesianBareClock.targetMinute === 30,
    'kemarin 15.30 beli makan is preserved as explicit clock 15:30'
  );
  assertCondition(
    indonesianBareClock?.resolvedUtcIso === '2026-09-10T08:30:00.000Z',
    `kemarin 15.30 beli makan resolves to 2026-09-10T08:30:00.000Z (got: ${indonesianBareClock?.resolvedUtcIso})`
  );

  // Positive context test 1: "tonight 20.30 dinner" (tonight 20:30 WIB -> UTC 13:30)
  const tonightDotClock = parseRelativeTime(
    'tonight 20.30 dinner',
    fixedReferenceUtc,
    defaultTimezone
  );
  assertCondition(
    tonightDotClock?.hasExplicitTime === true &&
      tonightDotClock.targetHour === 20 &&
      tonightDotClock.targetMinute === 30,
    'tonight 20.30 dinner is preserved as explicit clock 20:30'
  );
  assertCondition(
    tonightDotClock?.resolvedUtcIso === '2026-09-11T13:30:00.000Z',
    `tonight 20.30 dinner resolves to 2026-09-11T13:30:00.000Z (got: ${tonightDotClock?.resolvedUtcIso})`
  );

  // Positive context test 2: "this dawn 05.30" (today 05:30 WIB -> UTC 2026-09-10 22:30:00Z)
  const thisDawnDotClock = parseRelativeTime(
    'this dawn 05.30',
    fixedReferenceUtc,
    defaultTimezone
  );
  assertCondition(
    thisDawnDotClock?.hasExplicitTime === true &&
      thisDawnDotClock.targetHour === 5 &&
      thisDawnDotClock.targetMinute === 30,
    'this dawn 05.30 is preserved as explicit clock 05:30'
  );
  assertCondition(
    thisDawnDotClock?.resolvedUtcIso === '2026-09-10T22:30:00.000Z',
    `this dawn 05.30 resolves to 2026-09-10T22:30:00.000Z (got: ${thisDawnDotClock?.resolvedUtcIso})`
  );

  // Positive context test 3: "yesterday dawn 05.30" (yesterday 05:30 WIB -> UTC 2026-09-09 22:30:00Z)
  const yesterdayDawnDotClock = parseRelativeTime(
    'yesterday dawn 05.30',
    fixedReferenceUtc,
    defaultTimezone
  );
  assertCondition(
    yesterdayDawnDotClock?.hasExplicitTime === true &&
      yesterdayDawnDotClock.targetHour === 5 &&
      yesterdayDawnDotClock.targetMinute === 30,
    'yesterday dawn 05.30 is preserved as explicit clock 05:30'
  );
  assertCondition(
    yesterdayDawnDotClock?.resolvedUtcIso === '2026-09-09T22:30:00.000Z',
    `yesterday dawn 05.30 resolves to 2026-09-09T22:30:00.000Z (got: ${yesterdayDawnDotClock?.resolvedUtcIso})`
  );

  // Test 14: Derive Current Date from Local Timezone & Midnight Cache Rollover (PR Review Comment B)
  applicationLogger.info('\nTEST 14: Local Timezone Date Derivation and Midnight Cache Rollover');

  // Positive offset timezone: Asia/Jakarta (UTC+7)
  // At UTC 2026-09-11 18:00:00Z, local time in Jakarta is 2026-09-12 01:00:00 WIB
  const positiveOffsetInstant = new Date('2026-09-11T18:00:00.000Z');
  const jakartaLocalDate = getCurrentLocalDateString(positiveOffsetInstant, 'Asia/Jakarta');
  assertCondition(
    jakartaLocalDate === '2026-09-12',
    `Positive offset (Asia/Jakarta): local date resolves to 2026-09-12 while UTC date is 2026-09-11 (got: ${jakartaLocalDate})`
  );
  const jakartaInstruction = buildCompactSystemInstruction(
    mockAccounts,
    mockCategories,
    jakartaLocalDate,
    'Asia/Jakarta'
  );
  assertCondition(
    jakartaInstruction.includes('Current Date: 2026-09-12'),
    'System instruction uses local calendar date 2026-09-12 for Asia/Jakarta'
  );

  // Negative offset timezone: America/New_York (EDT, UTC-4)
  // At UTC 2026-09-12 02:00:00Z, local time in New York is 2026-09-11 22:00:00 EDT
  const negativeOffsetInstant = new Date('2026-09-12T02:00:00.000Z');
  const newYorkLocalDate = getCurrentLocalDateString(negativeOffsetInstant, 'America/New_York');
  assertCondition(
    newYorkLocalDate === '2026-09-11',
    `Negative offset (America/New_York): local date resolves to 2026-09-11 while UTC date is 2026-09-12 (got: ${newYorkLocalDate})`
  );
  const newYorkInstruction = buildCompactSystemInstruction(
    mockAccounts,
    mockCategories,
    newYorkLocalDate,
    'America/New_York'
  );
  assertCondition(
    newYorkInstruction.includes('Current Date: 2026-09-11'),
    'System instruction uses local calendar date 2026-09-11 for America/New_York'
  );

  // Cache rollover across local midnight in GeminiAiProvider
  const originalAppTimezone = process.env.APP_TIMEZONE;
  process.env.APP_TIMEZONE = 'Asia/Jakarta';
  try {
    const testGeminiProvider = new GeminiAiProvider('mock-gemini-key');

    // 1. Before local midnight: 2026-09-11 23:59:00 WIB (UTC: 2026-09-11 16:59:00Z)
    const instantBeforeMidnight = new Date('2026-09-11T16:59:00.000Z');
    const instructionBeforeMidnight = testGeminiProvider.getSystemInstruction(
      mockAccounts,
      mockCategories,
      instantBeforeMidnight
    );
    const keyBeforeMidnight = testGeminiProvider.getSystemInstructionCacheKey();
    assertCondition(
      keyBeforeMidnight.includes('2026-09-11'),
      `Cache key before midnight contains local date 2026-09-11 (got: ${keyBeforeMidnight})`
    );
    assertCondition(
      instructionBeforeMidnight.includes('Current Date: 2026-09-11'),
      'Instruction before midnight contains Current Date: 2026-09-11'
    );

    // 2. Cache hit within the same local date: 2026-09-11 23:59:30 WIB
    const instantSameDay = new Date('2026-09-11T16:59:30.000Z');
    const instructionSameDay = testGeminiProvider.getSystemInstruction(
      mockAccounts,
      mockCategories,
      instantSameDay
    );
    assertCondition(
      instructionSameDay === instructionBeforeMidnight,
      'Same local date returns cached system instruction instance'
    );

    // 3. After local midnight: 2026-09-12 00:01:00 WIB (UTC: 2026-09-11 17:01:00Z)
    const instantAfterMidnight = new Date('2026-09-11T17:01:00.000Z');
    const instructionAfterMidnight = testGeminiProvider.getSystemInstruction(
      mockAccounts,
      mockCategories,
      instantAfterMidnight
    );
    const keyAfterMidnight = testGeminiProvider.getSystemInstructionCacheKey();
    assertCondition(
      keyAfterMidnight.includes('2026-09-12'),
      `Cache key rolls over at local midnight to 2026-09-12 (got: ${keyAfterMidnight})`
    );
    assertCondition(
      instructionAfterMidnight.includes('Current Date: 2026-09-12'),
      'Instruction after midnight contains Current Date: 2026-09-12'
    );
    assertCondition(
      instructionAfterMidnight !== instructionBeforeMidnight,
      'Instruction recompiled across local midnight boundary'
    );
  } finally {
    process.env.APP_TIMEZONE = originalAppTimezone;
  }

  // Test 15: Tadi Malam Alignment with Issue #4 Contract (PR Review Comment 1)
  applicationLogger.info('\nTEST 15: Tadi Malam Alignment with Issue #4 Contract (Current Local Date)');
  // Reference at 22:30 WIB (UTC: 2026-09-11 15:30:00Z)
  const eveningReferenceUtc = new Date('2026-09-11T15:30:00.000Z');
  const eveningTadiMalam = parseRelativeTime(
    'tadi malam makan 50rb',
    eveningReferenceUtc,
    defaultTimezone
  );
  assertCondition(
    eveningTadiMalam !== null,
    'tadi malam at 22:30 WIB matches relative time parser'
  );
  assertCondition(
    eveningTadiMalam?.dayReference === 'today',
    `tadi malam references today (got: ${eveningTadiMalam?.dayReference})`
  );
  assertCondition(
    eveningTadiMalam?.targetDateString === '2026-09-11',
    `tadi malam at 22:30 WIB resolves to current local date 2026-09-11 (got: ${eveningTadiMalam?.targetDateString})`
  );
  assertCondition(
    eveningTadiMalam?.targetHour === 20 && eveningTadiMalam?.targetMinute === 0,
    'tadi malam resolves to representative night hour 20:00'
  );
  assertCondition(
    eveningTadiMalam?.resolvedUtcIso === '2026-09-11T13:00:00.000Z',
    `tadi malam at 22:30 WIB converts to UTC 2026-09-11T13:00:00.000Z (got: ${eveningTadiMalam?.resolvedUtcIso})`
  );

  // Contrast with "semalam makan sate 50rb" at the same 22:30 reference
  const eveningSemalam = parseRelativeTime(
    'semalam makan sate 50rb',
    eveningReferenceUtc,
    defaultTimezone
  );
  assertCondition(
    eveningSemalam?.dayReference === 'yesterday',
    'semalam references yesterday'
  );
  assertCondition(
    eveningSemalam?.targetDateString === '2026-09-10',
    `semalam resolves to previous local date 2026-09-10 (got: ${eveningSemalam?.targetDateString})`
  );
  assertCondition(
    eveningSemalam?.resolvedUtcIso === '2026-09-10T13:00:00.000Z',
    `semalam converts to UTC 2026-09-10T13:00:00.000Z (got: ${eveningSemalam?.resolvedUtcIso})`
  );

  // Test 16: Request-Scoped Reference Instant Propagation Across AI and Validation (PR Review Comment 2)
  applicationLogger.info('\nTEST 16: Request-Scoped Reference Instant Propagation Across AI and Validation');
  // Scenario: Request starts 5 seconds before local midnight (23:59:55 WIB on Sept 11, UTC: 2026-09-11 16:59:55Z)
  const requestStartInstant = new Date('2026-09-11T16:59:55.000Z');
  // Simulated AI response returns after crossing midnight (00:00:05 WIB on Sept 12, UTC: 2026-09-11 17:00:05Z)
  const validationCompletedInstant = new Date('2026-09-11T17:00:05.000Z');

  const incomingNightRecords = [
    {
      accountId: 'acc-cash',
      amount: -50000,
      recordDate: requestStartInstant.toISOString(),
      note: 'makan sate',
    },
  ];

  // When requestStartInstant is properly passed as referenceDate:
  const anchoredValidationResult = validateAndSanitizeFinancialRecords(
    incomingNightRecords,
    mockAccounts,
    mockCategories,
    'kemarin malam makan sate 50rb',
    requestStartInstant
  );

  // When request completed instantaneously before midnight:
  const fastValidationResult = validateAndSanitizeFinancialRecords(
    incomingNightRecords,
    mockAccounts,
    mockCategories,
    'kemarin malam makan sate 50rb',
    new Date('2026-09-11T16:59:58.000Z')
  );

  assertCondition(
    anchoredValidationResult.sanitizedRecords[0].recordDate === '2026-09-10T13:00:00.000Z',
    `Anchored request resolves 'kemarin malam' to 2026-09-10T13:00:00.000Z even when AI finishes after midnight (got: ${anchoredValidationResult.sanitizedRecords[0].recordDate})`
  );
  assertCondition(
    anchoredValidationResult.sanitizedRecords[0].recordDate === fastValidationResult.sanitizedRecords[0].recordDate,
    'Anchored request produces identical timestamp to fast request completing before midnight'
  );

  // Negative demonstration: if unanchored validation ran after midnight with fresh new Date()
  const unanchoredDriftedResult = validateAndSanitizeFinancialRecords(
    incomingNightRecords,
    mockAccounts,
    mockCategories,
    'kemarin malam makan sate 50rb',
    validationCompletedInstant
  );
  assertCondition(
    unanchoredDriftedResult.sanitizedRecords[0].recordDate === '2026-09-11T13:00:00.000Z',
    'Unanchored validation after midnight would erroneously drift to 2026-09-11'
  );
  assertCondition(
    anchoredValidationResult.sanitizedRecords[0].recordDate !== unanchoredDriftedResult.sanitizedRecords[0].recordDate,
    'Request-scoped reference instant successfully eliminates 1-day drift across midnight'
  );

  // Test 17: Gemini System Instruction DST Offset Invalidation (PR Review Item 1)
  applicationLogger.info('\nTEST 17: Gemini System Instruction DST Offset Invalidation Across Fallback');
  const originalAppTimezoneForDstTest = process.env.APP_TIMEZONE;
  try {
    process.env.APP_TIMEZONE = 'America/New_York';
    const dstTestGeminiProvider = new GeminiAiProvider('test-api-key', 'gemini-3.6-flash', []);

    // 1. Before DST fallback on 2026-11-01 at 01:30 EDT (UTC: 2026-11-01 05:30:00Z)
    // Offset in America/New_York is UTC-04:00
    const instantBeforeDstFallback = new Date('2026-11-01T05:30:00.000Z');
    const localDateBeforeDst = getCurrentLocalDateString(instantBeforeDstFallback, 'America/New_York');
    assertCondition(
      localDateBeforeDst === '2026-11-01',
      `Before fallback local date in America/New_York is 2026-11-01 (got: ${localDateBeforeDst})`
    );

    const instructionBeforeDstFallback = dstTestGeminiProvider.getSystemInstruction(
      mockAccounts,
      mockCategories,
      instantBeforeDstFallback
    );
    const keyBeforeDstFallback = dstTestGeminiProvider.getSystemInstructionCacheKey();
    assertCondition(
      keyBeforeDstFallback.includes('-04:00'),
      `Cache key before DST fallback contains offset -04:00 (got: ${keyBeforeDstFallback})`
    );
    assertCondition(
      instructionBeforeDstFallback.includes('Offset: UTC-04:00'),
      'Instruction before DST fallback contains Offset: UTC-04:00'
    );

    // 2. After DST fallback on 2026-11-01 at 02:30 EST (UTC: 2026-11-01 07:30:00Z)
    // Same local calendar date: 2026-11-01, but offset has changed to UTC-05:00
    const instantAfterDstFallback = new Date('2026-11-01T07:30:00.000Z');
    const localDateAfterDst = getCurrentLocalDateString(instantAfterDstFallback, 'America/New_York');
    assertCondition(
      localDateAfterDst === '2026-11-01',
      `After fallback local date is still 2026-11-01 (got: ${localDateAfterDst})`
    );

    const instructionAfterDstFallback = dstTestGeminiProvider.getSystemInstruction(
      mockAccounts,
      mockCategories,
      instantAfterDstFallback
    );
    const keyAfterDstFallback = dstTestGeminiProvider.getSystemInstructionCacheKey();
    assertCondition(
      keyAfterDstFallback.includes('-05:00'),
      `Cache key after DST fallback contains updated offset -05:00 (got: ${keyAfterDstFallback})`
    );
    assertCondition(
      instructionAfterDstFallback.includes('Offset: UTC-05:00'),
      'Instruction after DST fallback contains Offset: UTC-05:00'
    );
    assertCondition(
      instructionAfterDstFallback !== instructionBeforeDstFallback,
      'System instruction invalidated and recompiled when timezone offset changes on the same date'
    );
  } finally {
    process.env.APP_TIMEZONE = originalAppTimezoneForDstTest;
  }

  // Test 18: APP_TIMEZONE Fail-Closed Configuration Validation (PR Review Item 3)
  applicationLogger.info('\nTEST 18: Fail Closed on Invalid APP_TIMEZONE Configuration');
  const baseTestConfiguration: ApplicationEnvironmentConfiguration = {
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

  // 1. Valid IANA timezone passes validation
  const validTimezoneConfig: ApplicationEnvironmentConfiguration = {
    ...baseTestConfiguration,
    appTimezone: 'America/New_York',
  };
  const validTimezoneValidationResult = validateApplicationConfiguration(validTimezoneConfig);
  assertCondition(
    validTimezoneValidationResult.isValid === true,
    'Valid IANA timezone America/New_York passes configuration validation'
  );
  assertCondition(
    validTimezoneValidationResult.errors.filter(issue => issue.variableName === 'APP_TIMEZONE').length === 0,
    'Valid IANA timezone produces zero APP_TIMEZONE validation errors'
  );

  // 2. Unset APP_TIMEZONE defaults to Asia/Jakarta
  const originalEnvTimezoneForConfigTest = process.env.APP_TIMEZONE;
  delete process.env.APP_TIMEZONE;
  try {
    const loadedConfigWithDefaultTimezone = loadEnvironmentConfiguration();
    assertCondition(
      loadedConfigWithDefaultTimezone.appTimezone === 'Asia/Jakarta',
      `Unset APP_TIMEZONE defaults to Asia/Jakarta (got: ${loadedConfigWithDefaultTimezone.appTimezone})`
    );
  } finally {
    if (originalEnvTimezoneForConfigTest !== undefined) {
      process.env.APP_TIMEZONE = originalEnvTimezoneForConfigTest;
    }
  }

  // 3. Typo / invalid timezone fails configuration validation (fail-closed)
  const typoTimezoneConfig: ApplicationEnvironmentConfiguration = {
    ...baseTestConfiguration,
    appTimezone: 'America/New_Yrok',
  };
  const typoTimezoneValidationResult = validateApplicationConfiguration(typoTimezoneConfig);
  assertCondition(
    typoTimezoneValidationResult.isValid === false,
    'Typo timezone America/New_Yrok fails configuration validation'
  );
  assertCondition(
    typoTimezoneValidationResult.errors.some(issue => issue.variableName === 'APP_TIMEZONE'),
    'Typo timezone produces an explicit APP_TIMEZONE validation error'
  );

  // Test 19: Cross-DST Request Instant Invariance and Target-Date-Specific Offset Resolution (PR Comment 5, Item 1)
  applicationLogger.info('\nTEST 19: Cross-DST Request Instant Invariance & Target-Date-Specific Offset');
  const originalEnvTimezoneForTest19 = process.env.APP_TIMEZONE;
  process.env.APP_TIMEZONE = 'America/New_York';
  try {
    // Reference instants:
    // Request instant in November (EST, UTC-05:00): 2026-11-15T15:00:00.000Z (10:00 EST)
    const requestInstantInEst = new Date('2026-11-15T15:00:00.000Z');
    // Request instant in July (EDT, UTC-04:00): 2026-07-15T15:00:00.000Z (11:00 EDT)
    const requestInstantInEdt = new Date('2026-07-15T15:00:00.000Z');

    // 1. July transaction (EDT, UTC-04:00): local 11:54 -> UTC 15:54:00.000Z
    // When request occurs in November (EST), July local receipt date must resolve to EDT (-04:00), NOT EST (-05:00)
    const julyReceiptValidationFromEstRequest = validateAndSanitizeFinancialRecords(
      [{ accountId: 'acc-cash', amount: -25, recordDate: '2026-07-15T11:54:00' }],
      mockAccounts,
      mockCategories,
      'Lunch receipt',
      requestInstantInEst
    );
    assertCondition(
      julyReceiptValidationFromEstRequest.isValid === true,
      'July receipt processed during November EST request validates successfully'
    );
    assertCondition(
      julyReceiptValidationFromEstRequest.sanitizedRecords[0].recordDate === '2026-07-15T15:54:00.000Z',
      `July receipt processed during November EST request resolves to EDT UTC 15:54:00.000Z (got: ${julyReceiptValidationFromEstRequest.sanitizedRecords[0].recordDate})`
    );

    // When request occurs in July (EDT), same July transaction must resolve to the identical UTC instant
    const julyReceiptValidationFromEdtRequest = validateAndSanitizeFinancialRecords(
      [{ accountId: 'acc-cash', amount: -25, recordDate: '2026-07-15T11:54:00' }],
      mockAccounts,
      mockCategories,
      'Lunch receipt',
      requestInstantInEdt
    );
    assertCondition(
      julyReceiptValidationFromEdtRequest.sanitizedRecords[0].recordDate === '2026-07-15T15:54:00.000Z',
      `July receipt processed during July EDT request resolves to identical EDT UTC 15:54:00.000Z (got: ${julyReceiptValidationFromEdtRequest.sanitizedRecords[0].recordDate})`
    );
    assertCondition(
      julyReceiptValidationFromEstRequest.sanitizedRecords[0].recordDate ===
        julyReceiptValidationFromEdtRequest.sanitizedRecords[0].recordDate,
      'Changing request date between EST and EDT does not alter July transaction UTC timestamp'
    );

    // 2. November transaction (EST, UTC-05:00): local 11:54 -> UTC 16:54:00.000Z
    // When request occurs in July (EDT), November local transaction date must resolve to EST (-05:00), NOT EDT (-04:00)
    const novemberReceiptValidationFromEdtRequest = validateAndSanitizeFinancialRecords(
      [{ accountId: 'acc-cash', amount: -30, recordDate: '2026-11-15T11:54:00' }],
      mockAccounts,
      mockCategories,
      'Dinner receipt',
      requestInstantInEdt
    );
    assertCondition(
      novemberReceiptValidationFromEdtRequest.isValid === true,
      'November receipt processed during July EDT request validates successfully'
    );
    assertCondition(
      novemberReceiptValidationFromEdtRequest.sanitizedRecords[0].recordDate === '2026-11-15T16:54:00.000Z',
      `November receipt processed during July EDT request resolves to EST UTC 16:54:00.000Z (got: ${novemberReceiptValidationFromEdtRequest.sanitizedRecords[0].recordDate})`
    );

    // When request occurs in November (EST), same November transaction must resolve to identical UTC instant
    const novemberReceiptValidationFromEstRequest = validateAndSanitizeFinancialRecords(
      [{ accountId: 'acc-cash', amount: -30, recordDate: '2026-11-15T11:54:00' }],
      mockAccounts,
      mockCategories,
      'Dinner receipt',
      requestInstantInEst
    );
    assertCondition(
      novemberReceiptValidationFromEstRequest.sanitizedRecords[0].recordDate === '2026-11-15T16:54:00.000Z',
      `November receipt processed during November EST request resolves to identical EST UTC 16:54:00.000Z (got: ${novemberReceiptValidationFromEstRequest.sanitizedRecords[0].recordDate})`
    );
    assertCondition(
      novemberReceiptValidationFromEdtRequest.sanitizedRecords[0].recordDate ===
        novemberReceiptValidationFromEstRequest.sanitizedRecords[0].recordDate,
      'Changing request date between EDT and EST does not alter November transaction UTC timestamp'
    );

    // 3. Authoritative Explicit Offset Preservation:
    // When a record has an explicit offset (e.g. 2026-07-15T11:54:00-05:00 from a receipt in Bogotá / UTC-05:00),
    // the validator must preserve the explicit offset (-05:00 -> 16:54:00.000Z), even when APP_TIMEZONE
    // is America/New_York where the July offset is -04:00 (which would otherwise resolve to 15:54:00.000Z).
    const explicitOffsetRecordValidation = validateAndSanitizeFinancialRecords(
      [{ accountId: 'acc-cash', amount: -15, recordDate: '2026-07-15T11:54:00-05:00' }],
      mockAccounts,
      mockCategories,
      'Coffee in Bogotá',
      requestInstantInEst
    );
    assertCondition(
      explicitOffsetRecordValidation.isValid === true,
      'Record with authoritative explicit offset validates successfully'
    );
    assertCondition(
      explicitOffsetRecordValidation.sanitizedRecords[0].recordDate === '2026-07-15T16:54:00.000Z',
      `Authoritative explicit offset -05:00 is preserved as UTC 16:54:00.000Z (got: ${explicitOffsetRecordValidation.sanitizedRecords[0].recordDate})`
    );

    // Conversely, local timestamp without offset (2026-07-15T11:54:00) resolves through APP_TIMEZONE (EDT -04:00 -> 15:54:00.000Z)
    const localTimestampValidation = validateAndSanitizeFinancialRecords(
      [{ accountId: 'acc-cash', amount: -15, recordDate: '2026-07-15T11:54:00' }],
      mockAccounts,
      mockCategories,
      'Coffee in New York',
      requestInstantInEst
    );
    assertCondition(
      localTimestampValidation.sanitizedRecords[0].recordDate === '2026-07-15T15:54:00.000Z',
      `Local timestamp without offset resolves through application IANA timezone as EDT UTC 15:54:00.000Z (got: ${localTimestampValidation.sanitizedRecords[0].recordDate})`
    );

    // 4. Direct resolveTargetLocalToUtcIso verification
    const directJulyUtc = resolveTargetLocalToUtcIso('2026-07-15', 11, 54, 'America/New_York');
    assertCondition(
      directJulyUtc === '2026-07-15T15:54:00.000Z',
      `Direct resolveTargetLocalToUtcIso for July 15 11:54 America/New_York produces 2026-07-15T15:54:00.000Z (got: ${directJulyUtc})`
    );

    const directNovemberUtc = resolveTargetLocalToUtcIso('2026-11-15', 11, 54, 'America/New_York');
    assertCondition(
      directNovemberUtc === '2026-11-15T16:54:00.000Z',
      `Direct resolveTargetLocalToUtcIso for November 15 11:54 America/New_York produces 2026-11-15T16:54:00.000Z (got: ${directNovemberUtc})`
    );
  } finally {
    process.env.APP_TIMEZONE = originalEnvTimezoneForTest19;
  }

  // Test 20: Nonexistent Local Clock Times Across DST Spring-Forward Gaps Fail Closed (PR Comment 5, Item 2)
  applicationLogger.info('\nTEST 20: Nonexistent Local Clock Times Across DST Spring-Forward Gaps');
  const originalEnvTimezoneForTest20 = process.env.APP_TIMEZONE;
  process.env.APP_TIMEZONE = 'America/New_York';
  try {
    // On Sunday, March 8, 2026 in America/New_York:
    // Clocks spring forward from 02:00:00 EST to 03:00:00 EDT.
    // Therefore, wall-clock times between 02:00:00 and 02:59:59 DO NOT EXIST.

    // 1. Nonexistent wall-clock time 02:30 throws RangeError in resolveTargetLocalToUtcIso
    let nonexistentClockErrorEncountered: Error | null = null;
    try {
      resolveTargetLocalToUtcIso('2026-03-08', 2, 30, 'America/New_York');
    } catch (error) {
      nonexistentClockErrorEncountered = error as Error;
    }
    assertCondition(
      nonexistentClockErrorEncountered instanceof RangeError,
      `Nonexistent wall-clock time 2026-03-08 02:30 America/New_York throws RangeError (got: ${nonexistentClockErrorEncountered})`
    );
    assertCondition(
      nonexistentClockErrorEncountered?.message.includes('Nonexistent local wall-clock time') === true,
      'RangeError message explicitly identifies nonexistent wall-clock time in DST gap'
    );

    // 2. parseRelativeTime propagates RangeError for nonexistent wall-clock time
    assert.throws(
      () =>
        parseRelativeTime(
          'this morning at 2:30am',
          new Date('2026-03-08T12:00:00.000Z'),
          'America/New_York'
        ),
      (error: unknown) => error instanceof RangeError,
      'parseRelativeTime propagates RangeError for nonexistent wall-clock time 02:30 during DST spring-forward'
    );

    // 3. validateAndSanitizeFinancialRecords with contextual text 'this morning at 2:30am coffee'
    // rejects record even when AI supplies a valid-looking UTC timestamp (fails closed, cannot be bypassed)
    const nonexistentContextualValidationResult = validateAndSanitizeFinancialRecords(
      [
        {
          accountId: 'acc-cash',
          amount: -10,
          recordDate: '2026-03-08T07:30:00.000Z', // AI supplied 07:30Z (which corresponds to 03:30 local)
        },
      ],
      mockAccounts,
      mockCategories,
      'this morning at 2:30am coffee',
      new Date('2026-03-08T12:00:00.000Z')
    );
    assertCondition(
      nonexistentContextualValidationResult.isValid === false,
      'validateAndSanitizeFinancialRecords fails for contextual text with nonexistent local wall-clock time despite valid-looking AI timestamp'
    );
    assertCondition(
      nonexistentContextualValidationResult.validationErrors.some(error =>
        error.includes('Waktu transaksi tidak valid pada timezone America/New_York')
      ),
      'Validation errors contain explicit invalid transaction time error for nonexistent contextual clock'
    );
    assertCondition(
      nonexistentContextualValidationResult.sanitizedRecords.length === 0,
      'Zero sanitized records produced for nonexistent contextual wall-clock time'
    );

    // 4. validateAndSanitizeFinancialRecords also rejects direct recordDate with nonexistent local clock time
    const nonexistentDirectValidationResult = validateAndSanitizeFinancialRecords(
      [{ accountId: 'acc-cash', amount: -10, recordDate: '2026-03-08T02:30:00' }],
      mockAccounts,
      mockCategories,
      'Coffee during DST gap',
      new Date('2026-03-08T12:00:00.000Z')
    );
    assertCondition(
      nonexistentDirectValidationResult.isValid === false,
      'validateAndSanitizeFinancialRecords fails for direct recordDate with nonexistent local wall-clock time'
    );
    assertCondition(
      nonexistentDirectValidationResult.sanitizedRecords.length === 0,
      'No sanitized records produced for nonexistent direct wall-clock time'
    );

    // 5. Valid neighboring times (01:30 and 03:30) pass cleanly:
    // Contextual relative expressions:
    const validPreTransitionContextual = validateAndSanitizeFinancialRecords(
      [{ accountId: 'acc-cash', amount: -10 }],
      mockAccounts,
      mockCategories,
      'this morning at 1:30am coffee',
      new Date('2026-03-08T12:00:00.000Z')
    );
    assertCondition(
      validPreTransitionContextual.isValid === true &&
        validPreTransitionContextual.sanitizedRecords[0].recordDate === '2026-03-08T06:30:00.000Z',
      'Valid pre-transition contextual 1:30am resolves to EST UTC 06:30:00.000Z'
    );

    const validPostTransitionContextual = validateAndSanitizeFinancialRecords(
      [{ accountId: 'acc-cash', amount: -10 }],
      mockAccounts,
      mockCategories,
      'this morning at 3:30am coffee',
      new Date('2026-03-08T12:00:00.000Z')
    );
    assertCondition(
      validPostTransitionContextual.isValid === true &&
        validPostTransitionContextual.sanitizedRecords[0].recordDate === '2026-03-08T07:30:00.000Z',
      'Valid post-transition contextual 3:30am resolves to EDT UTC 07:30:00.000Z'
    );

    // Direct resolveTargetLocalToUtcIso:
    // 01:30 EST (pre-transition, UTC-05:00) -> UTC 06:30:00.000Z
    const validPreTransitionUtc = resolveTargetLocalToUtcIso('2026-03-08', 1, 30, 'America/New_York');
    assertCondition(
      validPreTransitionUtc === '2026-03-08T06:30:00.000Z',
      `Valid pre-transition 2026-03-08 01:30 in NY resolves to 2026-03-08T06:30:00.000Z (got: ${validPreTransitionUtc})`
    );

    // 03:30 EDT (post-transition, UTC-04:00) -> UTC 07:30:00.000Z
    const validPostTransitionUtc = resolveTargetLocalToUtcIso('2026-03-08', 3, 30, 'America/New_York');
    assertCondition(
      validPostTransitionUtc === '2026-03-08T07:30:00.000Z',
      `Valid post-transition 2026-03-08 03:30 in NY resolves to 2026-03-08T07:30:00.000Z (got: ${validPostTransitionUtc})`
    );

    // 6. Ambiguous fall-back overlap:
    // On Sunday, Nov 1, 2026 in America/New_York, clocks rewind 02:00:00 -> 01:00:00.
    // 01:30 occurs twice. Policy deterministically resolves to post-transition standard time (EST, UTC-05:00).
    const ambiguousFallBackUtc = resolveTargetLocalToUtcIso('2026-11-01', 1, 30, 'America/New_York');
    assertCondition(
      ambiguousFallBackUtc === '2026-11-01T06:30:00.000Z',
      `Ambiguous fall-back 2026-11-01 01:30 in NY deterministically resolves to EST UTC 06:30:00.000Z (got: ${ambiguousFallBackUtc})`
    );
  } finally {
    process.env.APP_TIMEZONE = originalEnvTimezoneForTest20;
  }

  console.log('\n======================================================');
  applicationLogger.success('ALL NATURAL LANGUAGE RELATIVE TIME TESTS PASSED!');
  console.log('======================================================\n');
}

runRelativeTimeExpressionsTestSuite().catch((error: unknown) => {
  applicationLogger.error(`Test Suite Failed: ${error}`);
  process.exit(1);
});
