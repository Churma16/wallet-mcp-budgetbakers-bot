import {
  parseRelativeTime,
  getLocalTimeParts,
  getPreviousLocalDateString,
  formatLocalToUtcIso,
  formatLocalTimeAnchor,
  PERIOD_REPRESENTATIVE_HOURS,
} from '../src/utils/relativeTimeParser.js';
import {
  buildCompactSystemInstruction,
  buildTextMessagePrompt,
} from '../src/services/ai/aiPromptBuilder.js';
import { validateAndSanitizeFinancialRecords } from '../src/utils/recordValidator.js';
import { WalletAccountItem, WalletCategoryItem } from '../src/types/walletTypes.js';
import { setActiveLanguage } from '../src/i18n/index.js';
import { applicationLogger } from '../src/utils/logger.js';

function assertCondition(condition: boolean, testDescription: string): void {
  if (!condition) {
    applicationLogger.error(`[FAIL] ${testDescription}`);
    throw new Error(`Assertion failed: ${testDescription}`);
  }
  applicationLogger.success(`[PASS] ${testDescription}`);
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

  // tadi malam / tadi malem -> yesterday 20:00 WIB
  const tadiMalam = parseRelativeTime('tadi malam nonton bioskop 60rb', fixedReferenceUtc, defaultTimezone);
  assertCondition(
    tadiMalam?.resolvedUtcIso === '2026-09-10T13:00:00.000Z',
    `tadi malam resolves to yesterday malam 2026-09-10T13:00:00.000Z (got: ${tadiMalam?.resolvedUtcIso})`
  );

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

  console.log('\n======================================================');
  applicationLogger.success('ALL NATURAL LANGUAGE RELATIVE TIME TESTS PASSED!');
  console.log('======================================================\n');
}

runRelativeTimeExpressionsTestSuite().catch((error: unknown) => {
  applicationLogger.error(`Test Suite Failed: ${error}`);
  process.exit(1);
});
