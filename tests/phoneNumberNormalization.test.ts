import { normalizePhoneNumber } from '../src/config/environmentConfig.js';

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

function assertNormalization(
  testCaseIdentifier: string,
  rawNumber: string,
  expectedDigits: string,
  defaultCurrency?: string,
  appTimezone?: string,
  appLanguage?: string
): void {
  let actualResult = '';
  try {
    actualResult = normalizePhoneNumber(rawNumber, defaultCurrency, appTimezone, appLanguage);
    assertCondition(
      testCaseIdentifier,
      actualResult === expectedDigits,
      `Expected '${expectedDigits}', got '${actualResult}'`
    );
  } catch (normalizationError) {
    const errorMessage = normalizationError instanceof Error ? normalizationError.message : String(normalizationError);
    testStatistics.totalCount++;
    testStatistics.failedCount++;
    console.error(`  [FAIL] ${testCaseIdentifier} -> Unexpected error thrown: ${errorMessage}`);
  }
}

function assertThrowsCondition(
  testCaseIdentifier: string,
  expectedMessageSubstring: string,
  callback: () => void
): void {
  testStatistics.totalCount++;
  try {
    callback();
    testStatistics.failedCount++;
    console.error(`  [FAIL] ${testCaseIdentifier} -> Expected an error to be thrown`);
  } catch (thrownError) {
    const errorMessage = thrownError instanceof Error ? thrownError.message : String(thrownError);
    if (expectedMessageSubstring && errorMessage.includes(expectedMessageSubstring)) {
      testStatistics.passedCount++;
      console.log(`  [PASS] ${testCaseIdentifier}`);
    } else {
      testStatistics.failedCount++;
      console.error(
        `  [FAIL] ${testCaseIdentifier} -> Expected error containing '${expectedMessageSubstring}', got: ${errorMessage}`
      );
    }
  }
}

async function runTestSuite(): Promise<void> {
  console.log('====================================================');
  console.log('[INFO] Running International E.164 Phone Normalization Test Suite');
  console.log('====================================================\n');

  // ----------------------------------------------------
  // TEST GROUP 1: Global Non-Digit Sanitization (E.164 Formatting)
  // ----------------------------------------------------
  console.log('[TEST GROUP 1] Global Non-Digit Format Sanitization');
  {
    assertNormalization('TG-1.1: US number with +, spaces, and dashes is stripped to E.164', '+1 (415) 555-2671', '14155552671');
    assertNormalization('TG-1.2: UK number with leading + and spaces is stripped to E.164', '+44 7911 123456', '447911123456');
    assertNormalization('TG-1.3: Singapore number with leading + and spaces is stripped to E.164', '+65 9123 4567', '6591234567');
    assertNormalization('TG-1.4: Indonesian number with +, spaces, and dashes is stripped to E.164', '+62 812-3456-7890', '6281234567890');
    assertNormalization('TG-1.5: Parentheses and dots are stripped alongside other formatting', '(+1) 415.555.2671', '14155552671');
    assertNormalization('TG-1.6: Parenthesized UK trunk zero (+44 (0)...) is removed', '+44 (0) 7911 123456', '447911123456');
    assertNormalization('TG-1.7: Parenthesized Australian trunk zero (+61 (0)...) is removed', '+61 (0) 412 345 678', '61412345678');
    assertNormalization('TG-1.8: Parenthesized Indonesian trunk zero (+62 (0812)...) is removed', '+62 (0812) 3456-7890', '6281234567890');
  }

  // ----------------------------------------------------
  // TEST GROUP 2: Pass-Through of Already-Valid E.164 Numbers
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 2] Already-Normalized E.164 Pass-Through');
  {
    assertNormalization('TG-2.1: US digits are returned unchanged', '14155552671', '14155552671');
    assertNormalization('TG-2.2: UK digits are returned unchanged', '447911123456', '447911123456');
    assertNormalization('TG-2.3: Singapore digits are returned unchanged', '6591234567', '6591234567');
    assertNormalization('TG-2.4: Indonesian digits are returned unchanged', '6281234567890', '6281234567890');
    assertNormalization('TG-2.5: WhatsApp JID suffix is stripped before sanitization', '6281234567890@s.whatsapp.net', '6281234567890');
    assertNormalization('TG-2.6: Arbitrary domain suffix (@c.us) is stripped before sanitization', '6281234567890@c.us', '6281234567890');
  }

  // ----------------------------------------------------
  // TEST GROUP 3: Indonesian Local '08' -> '628' Auto-Conversion
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 3] Indonesian Domestic Trunk Auto-Conversion');
  {
    assertNormalization('TG-3.1: IDR currency triggers 08 to 628 conversion', '0812-3456-7890', '6281234567890', 'IDR');
    assertNormalization('TG-3.2: Asia/Jakarta timezone triggers 08 to 628 conversion', '081234567890', '6281234567890', 'USD', 'Asia/Jakarta');
    assertNormalization('TG-3.3: Both IDR and Jakarta context converts formatted 08 input', '08 12 3456 7890', '6281234567890', 'IDR', 'Asia/Jakarta');
    assertNormalization('TG-3.4: Asia/Makassar timezone (WITA) triggers 08 to 628 conversion', '081234567890', '6281234567890', 'USD', 'Asia/Makassar');
    assertNormalization('TG-3.5: Asia/Jayapura timezone (WIT) triggers 08 to 628 conversion', '081234567890', '6281234567890', 'USD', 'Asia/Jayapura');
    assertNormalization('TG-3.6: Asia/Pontianak timezone (WIB) triggers 08 to 628 conversion', '081234567890', '6281234567890', 'USD', 'Asia/Pontianak');
    assertNormalization('TG-3.7: Indonesian response language triggers 08 to 628 conversion', '081234567890', '6281234567890', 'USD', 'America/New_York', 'id');
  }

  // ----------------------------------------------------
  // TEST GROUP 4: Domestic Trunk Prefix (Leading 0) Rejection
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 4] Domestic Trunk Prefix (Leading 0) Rejection');
  {
    assertThrowsCondition(
      'TG-4.1: UK 07 prefix is rejected outside Indonesian context',
      'cannot start with',
      () => normalizePhoneNumber('07911 123456', 'GBP', 'Europe/London')
    );
    assertThrowsCondition(
      'TG-4.2: Australian 04 prefix is rejected outside Indonesian context',
      'cannot start with',
      () => normalizePhoneNumber('0412 345 678', 'AUD', 'Australia/Sydney')
    );
    assertThrowsCondition(
      'TG-4.3: Indonesian 08 prefix is rejected when region is NOT Indonesian',
      'cannot start with',
      () => normalizePhoneNumber('081234567890', 'USD', 'America/New_York')
    );
    assertThrowsCondition(
      'TG-4.4: Unresolvable 01 prefix is rejected',
      'E.164',
      () => normalizePhoneNumber('0151 1234567', 'EUR', 'Europe/Berlin')
    );
    assertThrowsCondition(
      'TG-4.5: Leading 0 without any regional context is rejected',
      'cannot start with',
      () => normalizePhoneNumber('081234567890')
    );
    assertThrowsCondition(
      'TG-4.6: English response language does NOT enable Indonesian conversion',
      'cannot start with',
      () => normalizePhoneNumber('081234567890', 'USD', 'America/New_York', 'en')
    );
  }

  // ----------------------------------------------------
  // TEST GROUP 5: ITU-T E.164 Length Constraints (7 - 15 Digits)
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 5] ITU-T E.164 Length Constraint Enforcement');
  {
    assertNormalization('TG-5.1: Minimum 7-digit number is accepted', '1234567', '1234567');
    assertNormalization('TG-5.2: Maximum 15-digit number is accepted', '123456789012345', '123456789012345');
    assertThrowsCondition(
      'TG-5.3: 6-digit number is rejected as below E.164 minimum',
      '7 and 15 digits',
      () => normalizePhoneNumber('123456', 'USD', 'America/New_York')
    );
    assertThrowsCondition(
      'TG-5.4: 16-digit number is rejected as above E.164 maximum',
      '7 and 15 digits',
      () => normalizePhoneNumber('1234567890123456', 'USD', 'America/New_York')
    );
  }

  // ----------------------------------------------------
  // TEST GROUP 6: Empty Input Handling
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 6] Empty & Whitespace Input Handling');
  {
    assertNormalization('TG-6.1: Empty string returns empty without throwing', '', '');
    assertNormalization('TG-6.2: Whitespace-only input returns empty without throwing', '   ', '');
  }

  // ----------------------------------------------------
  // TEST GROUP 7: Actionable Error Message Content
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 7] Actionable Error Messaging');
  {
    assertThrowsCondition(
      'TG-7.1: Leading-zero error educates with international examples',
      '6281234567890 for ID',
      () => normalizePhoneNumber('07911 123456', 'GBP', 'Europe/London')
    );
    assertThrowsCondition(
      'TG-7.2: Length error explains ITU-T E.164 constraint',
      'comply with the ITU-T E.164 standard',
      () => normalizePhoneNumber('123456', 'USD', 'America/New_York')
    );
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
    console.log('[SUCCESS] All international E.164 phone normalization tests passed!\n');
    process.exit(0);
  }
}

runTestSuite().catch(suiteError => {
  console.error(`[ERROR] Test suite execution failed: ${suiteError}`);
  process.exit(1);
});
