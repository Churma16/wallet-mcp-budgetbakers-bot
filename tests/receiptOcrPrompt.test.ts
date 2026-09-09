import {
  getTimezoneOffsetDetails,
  buildReceiptSystemInstruction,
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

async function runReceiptOcrPromptTestSuite(): Promise<void> {
  console.log('\n======================================================');
  applicationLogger.info('Starting Receipt OCR & Timezone Unit Test Suite...');
  console.log('======================================================\n');

  // Test 1: Dynamic Timezone Offset Calculations
  applicationLogger.info('TEST 1: Dynamic Timezone Offset Calculations');
  const jakartaOffset = getTimezoneOffsetDetails('Asia/Jakarta');
  assertCondition(jakartaOffset.formattedOffset === '+07:00', 'Asia/Jakarta resolves to +07:00 offset');
  assertCondition(jakartaOffset.offsetHours === 7, 'Asia/Jakarta offsetHours is 7');

  const makassarOffset = getTimezoneOffsetDetails('Asia/Makassar');
  assertCondition(makassarOffset.formattedOffset === '+08:00', 'Asia/Makassar resolves to +08:00 offset');
  assertCondition(makassarOffset.offsetHours === 8, 'Asia/Makassar offsetHours is 8');

  const utcOffset = getTimezoneOffsetDetails('UTC');
  assertCondition(utcOffset.formattedOffset === '+00:00', 'UTC resolves to +00:00 offset');
  assertCondition(utcOffset.offsetHours === 0, 'UTC offsetHours is 0');

  const fallbackOffset = getTimezoneOffsetDetails('Invalid/Timezone_Name');
  assertCondition(fallbackOffset.timeZone === 'Asia/Jakarta', 'Invalid timezone falls back to Asia/Jakarta');
  assertCondition(fallbackOffset.formattedOffset === '+07:00', 'Fallback offset is +07:00');

  // Test 2: Receipt System Instruction Generation
  applicationLogger.info('\nTEST 2: Receipt System Instruction Generation & QRIS Rules');
  const mockAccounts: WalletAccountItem[] = [
    {
      id: 'acc-jago-expense',
      name: 'Jago Expense',
      currency: 'IDR',
      accountType: 'CurrentAccount',
      bankAccountNumber: '507431877335',
    },
    {
      id: 'acc-mandiri-debit',
      name: 'Mandiri Debit Card',
      currency: 'IDR',
      accountType: 'CurrentAccount',
      bankAccountNumber: '1200012497769',
    },
    {
      id: 'acc-cash',
      name: 'Cash',
      currency: 'IDR',
      accountType: 'Cash',
    },
  ];

  const mockCategories: WalletCategoryItem[] = [
    { id: 'cat-food', name: 'Food & Drinks' },
    { id: 'cat-groceries', name: 'Groceries' },
  ];

  setActiveLanguage('id');
  const receiptInstructionId = buildReceiptSystemInstruction(
    mockAccounts,
    mockCategories,
    '2026-09-08',
    'Asia/Jakarta'
  );

  assertCondition(
    receiptInstructionId.includes('507431877335'),
    'Receipt instruction includes Jago bankAccountNumber (507431877335)'
  );
  assertCondition(
    receiptInstructionId.includes('1200012497769'),
    'Receipt instruction includes Mandiri bankAccountNumber (1200012497769)'
  );
  assertCondition(
    receiptInstructionId.includes('Acquirer Name') && receiptInstructionId.includes('NEVER match the user\'s account to the Acquirer Name'),
    'Receipt instruction contains explicit QRIS Acquirer Name disambiguation rule'
  );
  assertCondition(
    receiptInstructionId.includes('Main Pocket') && receiptInstructionId.includes('Bank Jago'),
    'Receipt instruction maps Main Pocket / Kantong Utama to Bank Jago'
  );
  assertCondition(
    receiptInstructionId.includes('Offset: UTC+07:00'),
    'Receipt instruction injects dynamic UTC+07:00 offset for Asia/Jakarta'
  );
  assertCondition(
    receiptInstructionId.includes('human friendly summary in Indonesian'),
    'Receipt instruction aligns explanation language with active language (id -> Indonesian)'
  );

  // Test 3: Language Adaptiveness (en)
  applicationLogger.info('\nTEST 3: Language Adaptiveness with English & Makassar Timezone');
  setActiveLanguage('en');
  const receiptInstructionEn = buildReceiptSystemInstruction(
    mockAccounts,
    mockCategories,
    '2026-09-08',
    'Asia/Makassar'
  );

  assertCondition(
    receiptInstructionEn.includes('Offset: UTC+08:00'),
    'Receipt instruction injects dynamic UTC+08:00 offset for Asia/Makassar'
  );
  assertCondition(
    receiptInstructionEn.includes('human friendly summary in English'),
    'Receipt instruction aligns explanation language with active language (en -> English)'
  );

  // Reset to default language
  setActiveLanguage('id');

  // Test 4: Record Validator Account Resolution by Account Number (Strategy E)
  applicationLogger.info('\nTEST 4: Record Validator Resolution by Bank Account Number');
  const validationWithAccountNum = validateAndSanitizeFinancialRecords(
    [
      {
        accountId: '507431877335',
        amount: -10000,
        recordDate: '2026-09-08T04:54:00.000Z',
        note: 'Beli lauk kangkung dan telur',
        counterParty: 'Kantin Euis',
      },
    ],
    mockAccounts,
    mockCategories
  );

  assertCondition(validationWithAccountNum.isValid, 'Validation succeeds for account number matching');
  assertCondition(
    validationWithAccountNum.sanitizedRecords[0].accountId === 'acc-jago-expense',
    'Account ID 507431877335 correctly resolved to acc-jago-expense'
  );

  // Test 5: Date Sanitization for missing timezone offset
  applicationLogger.info('\nTEST 5: Date Normalization for Missing Timezone Offset');
  process.env.APP_TIMEZONE = 'Asia/Jakarta';
  const validationWithRawLocalDate = validateAndSanitizeFinancialRecords(
    [
      {
        accountId: 'acc-jago-expense',
        amount: -10000,
        recordDate: '2026-09-08T11:54:00', // Missing Z or timezone offset
        note: 'Beli lauk',
      },
    ],
    mockAccounts,
    mockCategories
  );

  assertCondition(validationWithRawLocalDate.isValid, 'Validation succeeds for raw local date');
  const normalizedIso = validationWithRawLocalDate.sanitizedRecords[0].recordDate;
  // In Asia/Jakarta (+07:00), 2026-09-08T11:54:00+07:00 in UTC is 2026-09-08T04:54:00.000Z
  assertCondition(
    normalizedIso === '2026-09-08T04:54:00.000Z',
    `Raw date '2026-09-08T11:54:00' with Asia/Jakarta (+07:00) normalized to '${normalizedIso}' (expected 2026-09-08T04:54:00.000Z)`
  );

  // Test 6: Record Validator 1-based category index & invalid date fallback
  applicationLogger.info('\nTEST 6: Category Resolution by 1-based Index & Invalid Date Fallback');
  const validationWithCategoryIndex = validateAndSanitizeFinancialRecords(
    [
      {
        accountId: '1',
        categoryId: '1',
        amount: -15000,
        recordDate: 'not-a-valid-date',
        note: 'Beli nasi',
      },
    ],
    mockAccounts,
    mockCategories
  );

  assertCondition(validationWithCategoryIndex.isValid, 'Validation succeeds for 1-based index and invalid date');
  assertCondition(
    validationWithCategoryIndex.sanitizedRecords[0].accountId === 'acc-jago-expense',
    'Account 1-based index 1 resolved to acc-jago-expense'
  );
  assertCondition(
    validationWithCategoryIndex.sanitizedRecords[0].categoryId === 'cat-food',
    'Category 1-based index 1 resolved to cat-food'
  );
  assertCondition(
    !Number.isNaN(Date.parse(validationWithCategoryIndex.sanitizedRecords[0].recordDate)),
    'Invalid recordDate safely falls back to current ISO date'
  );

  // Test 7: Record Validator NaN Amount Validation
  applicationLogger.info('\nTEST 7: Record Validator Rejects NaN Amount');
  const validationWithNanAmount = validateAndSanitizeFinancialRecords(
    [
      {
        accountId: 'acc-jago-expense',
        amount: Number.NaN,
        note: 'Invalid nominal',
      },
    ],
    mockAccounts,
    mockCategories
  );

  assertCondition(!validationWithNanAmount.isValid, 'Validation fails when amount is NaN');

  console.log('\n======================================================');
  applicationLogger.success('ALL RECEIPT OCR & TIMEZONE TESTS PASSED SUCCESSFULLY!');
  console.log('======================================================\n');
}

runReceiptOcrPromptTestSuite().catch((error: unknown) => {
  applicationLogger.error(`Test Suite Execution Failed: ${error}`);
  process.exit(1);
});
