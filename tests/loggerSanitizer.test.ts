import fs from 'fs';
import path from 'path';
import {
  maskSensitiveValue,
  maskAccountNumbersAndPansInString,
  sanitizeSensitiveLogPayload,
  sanitizeLogArgument,
  applicationLogger,
} from '../src/utils/logger.js';

function runLoggerSanitizerTests(): void {
  console.log('[TEST] Starting Bank Account Number and PAN Sanitizer Unit Tests');

  let allTestsPassed = true;

  function assertCondition(testCaseName: string, passedCondition: boolean, failureDetails?: string): void {
    if (!passedCondition) {
      console.error(`[FAIL] ${testCaseName}${failureDetails ? `: ${failureDetails}` : ''}`);
      allTestsPassed = false;
    } else {
      console.log(`[PASS] ${testCaseName}`);
    }
  }

  // =========================================================================
  // 1. maskSensitiveValue Unit Tests
  // =========================================================================
  console.log('\n--- 1. Testing maskSensitiveValue ---');

  const standard12DigitAccount = '507431877335';
  assertCondition(
    'Mask 12-digit bank account number',
    maskSensitiveValue(standard12DigitAccount) === '5074****7335'
  );

  const numeric12DigitAccount = 507431877335;
  assertCondition(
    'Mask numeric 12-digit bank account number',
    maskSensitiveValue(numeric12DigitAccount) === '5074****7335'
  );

  const standard13DigitAccount = '1200012497769';
  assertCondition(
    'Mask 13-digit Mandiri bank account number',
    maskSensitiveValue(standard13DigitAccount) === '1200****7769'
  );

  const standard19DigitPan = '9360000801144353984';
  assertCondition(
    'Mask 19-digit customer PAN',
    maskSensitiveValue(standard19DigitPan) === '9360****3984'
  );

  const standard19DigitMerchantPan = '9360054217431877335';
  assertCondition(
    'Mask 19-digit merchant PAN',
    maskSensitiveValue(standard19DigitMerchantPan) === '9360****7335'
  );

  const hyphenatedAccount = '5074-3187-7335';
  assertCondition(
    'Mask hyphenated bank account number',
    maskSensitiveValue(hyphenatedAccount) === '5074****7335'
  );

  const spaceSeparatedAccount = '5074 3187 7335';
  assertCondition(
    'Mask space-separated bank account number',
    maskSensitiveValue(spaceSeparatedAccount) === '5074****7335'
  );

  const bankLabeledAccount = 'BCA 507431877335';
  assertCondition(
    'Mask bank labeled account string',
    maskSensitiveValue(bankLabeledAccount) === 'BCA 5074****7335'
  );

  assertCondition(
    'Mask short 4-digit code to ****',
    maskSensitiveValue('1234') === '****'
  );

  assertCondition(
    'Preserve already masked value',
    maskSensitiveValue('5074****7335') === '5074****7335'
  );

  // =========================================================================
  // 2. maskAccountNumbersAndPansInString Pattern Tests
  // =========================================================================
  console.log('\n--- 2. Testing maskAccountNumbersAndPansInString ---');

  const sentenceWithTwoAccounts = 'Transfer dari rekening 507431877335 ke rekening Mandiri 1200012497769 berhasil.';
  const maskedSentenceResult = maskAccountNumbersAndPansInString(sentenceWithTwoAccounts);
  assertCondition(
    'Mask multiple account numbers in continuous text',
    maskedSentenceResult.includes('5074****7335') &&
    maskedSentenceResult.includes('1200****7769') &&
    !maskedSentenceResult.includes('507431877335') &&
    !maskedSentenceResult.includes('1200012497769')
  );

  const stringEmbeddedJson = '{"bankAccountNumber": "507431877335", "pan": "9360000801144353984"}';
  const maskedJsonResult = maskAccountNumbersAndPansInString(stringEmbeddedJson);
  assertCondition(
    'Mask embedded JSON sensitive keys',
    maskedJsonResult.includes('"bankAccountNumber": "5074****7335"') &&
    maskedJsonResult.includes('"pan": "9360****3984"')
  );

  const whatsAppJidString = 'User sender: 6281234567890@s.whatsapp.net incoming';
  const maskedWhatsAppJidResult = maskAccountNumbersAndPansInString(whatsAppJidString);
  assertCondition(
    'Preserve WhatsApp user JID without masking phone number digits',
    maskedWhatsAppJidResult.includes('6281234567890@s.whatsapp.net')
  );

  const emailString = 'Alert sent to finance.user1234567890@example.com for verification';
  const maskedEmailResult = maskAccountNumbersAndPansInString(emailString);
  assertCondition(
    'Preserve email address containing digits without masking',
    maskedEmailResult.includes('finance.user1234567890@example.com')
  );

  const shortNumberString = 'Invoice INV-123456789 processed';
  assertCondition(
    'Preserve short number below 10 digits untouched',
    maskAccountNumbersAndPansInString(shortNumberString) === shortNumberString
  );

  const overlong20DigitString = 'Checksum 12345678901234567890 valid';
  assertCondition(
    'Preserve overlong 20-digit number untouched',
    maskAccountNumbersAndPansInString(overlong20DigitString) === overlong20DigitString
  );

  // =========================================================================
  // 3. Key-based Masking in sanitizeSensitiveLogPayload
  // =========================================================================
  console.log('\n--- 3. Testing Sensitive Key Recognition ---');

  const sensitiveKeysPayload = {
    bankAccountNumber: '507431877335',
    accountNumber: 1200012497769,
    customerPan: '9360000801144353984',
    merchantPan: 9360054217431877335n,
    pan: '9360000801144353984',
    sourceOfFund: 'BCA 507431877335',
    bank_account_number: '507431877335',
  };

  const sanitizedKeysResult = sanitizeSensitiveLogPayload(sensitiveKeysPayload) as Record<string, unknown>;

  assertCondition('bankAccountNumber masked', sanitizedKeysResult.bankAccountNumber === '5074****7335');
  assertCondition('accountNumber (numeric) masked', sanitizedKeysResult.accountNumber === '1200****7769');
  assertCondition('customerPan masked', sanitizedKeysResult.customerPan === '9360****3984');
  assertCondition('merchantPan (bigint) masked', sanitizedKeysResult.merchantPan === '9360****7335');
  assertCondition('pan masked', sanitizedKeysResult.pan === '9360****3984');
  assertCondition('sourceOfFund masked', sanitizedKeysResult.sourceOfFund === 'BCA 5074****7335');
  assertCondition('bank_account_number (snake_case) masked', sanitizedKeysResult.bank_account_number === '5074****7335');

  // =========================================================================
  // 4. Non-Sensitive Field Preservation (Amounts, Balances, IDs, Timestamps)
  // =========================================================================
  console.log('\n--- 4. Testing Non-Sensitive Field Preservation ---');

  const nonSensitiveMetadataPayload = {
    amount: 15000000000, // 15 billion (11 digits)
    balance: 25000000000, // 25 billion (11 digits)
    spentAmount: 5000000000,
    limitAmount: 50000000000,
    id: '123456789012',
    accountId: 'acc-jago-expense',
    transactionId: '123456789012',
    recordId: '123456789012',
    categoryId: 'cat-groceries',
    categoryName: 'Food & Beverage',
    timestamp: 1773064485000, // 13 digits Unix timestamp
    mtimeMs: 1773064485000,
  };

  const sanitizedMetadataResult = sanitizeSensitiveLogPayload(nonSensitiveMetadataPayload) as typeof nonSensitiveMetadataPayload;

  assertCondition('Amount (11 digits) preserved as number', sanitizedMetadataResult.amount === 15000000000);
  assertCondition('Balance (11 digits) preserved as number', sanitizedMetadataResult.balance === 25000000000);
  assertCondition('spentAmount preserved as number', sanitizedMetadataResult.spentAmount === 5000000000);
  assertCondition('limitAmount preserved as number', sanitizedMetadataResult.limitAmount === 50000000000);
  assertCondition('transactionId preserved untouched', sanitizedMetadataResult.transactionId === '123456789012');
  assertCondition('recordId preserved untouched', sanitizedMetadataResult.recordId === '123456789012');
  assertCondition('accountId preserved untouched', sanitizedMetadataResult.accountId === 'acc-jago-expense');
  assertCondition('categoryName preserved untouched', sanitizedMetadataResult.categoryName === 'Food & Beverage');
  assertCondition('timestamp (13 digits) preserved', sanitizedMetadataResult.timestamp === 1773064485000);

  // =========================================================================
  // 5. Nested Object and Array Traversal (MCP get_accounts simulation)
  // =========================================================================
  console.log('\n--- 5. Testing Nested Object and Array Traversal ---');

  const mcpGetAccountsResponseMock = {
    accounts: [
      {
        id: 'acc-bca-checking',
        name: 'BCA Tahapan',
        currency: 'IDR',
        balance: 12500000,
        bankAccountNumber: '507431877335',
      },
      {
        id: 'acc-mandiri-tabungan',
        name: 'Mandiri Payroll',
        currency: 'IDR',
        balance: 45000000,
        bankAccountNumber: '1200012497769',
      },
    ],
    metadata: {
      totalAccounts: 2,
      lastSyncTimestamp: 1773064485000,
      auditNote: 'Customer PAN 9360000801144353984 attached to profile',
    },
  };

  const sanitizedMcpResponse = sanitizeSensitiveLogPayload(mcpGetAccountsResponseMock) as typeof mcpGetAccountsResponseMock;

  assertCondition(
    'Nested account 1 bankAccountNumber masked',
    sanitizedMcpResponse.accounts[0].bankAccountNumber === '5074****7335'
  );
  assertCondition(
    'Nested account 2 bankAccountNumber masked',
    sanitizedMcpResponse.accounts[1].bankAccountNumber === '1200****7769'
  );
  assertCondition(
    'Nested account 1 balance untouched',
    sanitizedMcpResponse.accounts[0].balance === 12500000
  );
  assertCondition(
    'Nested audit note PAN masked in continuous string',
    sanitizedMcpResponse.metadata.auditNote.includes('9360****3984') &&
    !sanitizedMcpResponse.metadata.auditNote.includes('9360000801144353984')
  );

  // =========================================================================
  // 6. Error Objects Traversal & Custom Properties
  // =========================================================================
  console.log('\n--- 6. Testing Error Objects Traversal ---');

  const errorWithSensitiveDetails = new Error('Payment gateway rejected PAN 9360000801144353984 for account 507431877335');
  (errorWithSensitiveDetails as Record<string, unknown>).customAccountPayload = {
    accountNumber: '1200012497769',
  };

  const sanitizedErrorResult = sanitizeSensitiveLogPayload(errorWithSensitiveDetails) as Error & { customAccountPayload?: { accountNumber: string } };

  assertCondition(
    'Error message PAN and account masked',
    sanitizedErrorResult.message.includes('9360****3984') &&
    sanitizedErrorResult.message.includes('5074****7335') &&
    !sanitizedErrorResult.message.includes('9360000801144353984') &&
    !sanitizedErrorResult.message.includes('507431877335')
  );

  assertCondition(
    'Error stack trace masked',
    sanitizedErrorResult.stack !== undefined &&
    !sanitizedErrorResult.stack.includes('9360000801144353984') &&
    !sanitizedErrorResult.stack.includes('507431877335')
  );

  assertCondition(
    'Custom Error property masked',
    sanitizedErrorResult.customAccountPayload?.accountNumber === '1200****7769'
  );

  // =========================================================================
  // 7. Circular Reference Resilience
  // =========================================================================
  console.log('\n--- 7. Testing Circular Reference Safety ---');

  const circularRootObject: Record<string, unknown> = {
    title: 'Circular Reference Test',
    account: {
      bankAccountNumber: '507431877335',
    },
  };
  circularRootObject.self = circularRootObject;
  (circularRootObject.account as Record<string, unknown>).parent = circularRootObject;

  let circularTestSurvivedWithoutCrash = false;
  let sanitizedCircularResult: Record<string, unknown> = {};

  try {
    sanitizedCircularResult = sanitizeSensitiveLogPayload(circularRootObject) as Record<string, unknown>;
    circularTestSurvivedWithoutCrash = true;
  } catch (circularError: unknown) {
    console.error(`[FAIL] Circular reference threw error: ${circularError}`);
  }

  assertCondition(
    'Circular reference handled without crash',
    circularTestSurvivedWithoutCrash
  );

  assertCondition(
    'Circular child bankAccountNumber masked correctly',
    (sanitizedCircularResult.account as Record<string, unknown>)?.bankAccountNumber === '5074****7335'
  );

  assertCondition(
    'Circular reference node replaced with [CIRCULAR]',
    sanitizedCircularResult.self === '[CIRCULAR]' &&
    (sanitizedCircularResult.account as Record<string, unknown>)?.parent === '[CIRCULAR]'
  );

  // =========================================================================
  // 8. sanitizeLogArgument Backwards Compatibility
  // =========================================================================
  console.log('\n--- 8. Testing sanitizeLogArgument Integration ---');

  const legacyArgumentPayload = {
    bankAccountNumber: '507431877335',
    note: 'Payment to 9360054217431877335',
  };

  const legacySanitizedResult = sanitizeLogArgument(legacyArgumentPayload) as typeof legacyArgumentPayload;

  assertCondition(
    'sanitizeLogArgument delegates to sanitizeSensitiveLogPayload',
    legacySanitizedResult.bankAccountNumber === '5074****7335' &&
    legacySanitizedResult.note.includes('9360****7335')
  );

  // =========================================================================
  // 9. applicationLogger.fileDetail and Disk Output Verification
  // =========================================================================
  console.log('\n--- 9. Testing applicationLogger.fileDetail File Output ---');

  const logDir = path.resolve(process.cwd(), 'logs');
  const currentDate = new Date();
  const yearString = currentDate.getFullYear();
  const monthString = String(currentDate.getMonth() + 1).padStart(2, '0');
  const dayString = String(currentDate.getDate()).padStart(2, '0');
  const todayLogFilePath = path.join(logDir, `app-${yearString}-${monthString}-${dayString}.log`);

  const uniqueTestMarker = `SANITIZER_LOG_ENTRY_${Math.random().toString(36).slice(2, 8)}`;
  applicationLogger.fileDetail('mcp', `Test MCP Account Dispatch [${uniqueTestMarker}]`, {
    accountList: [
      {
        accountName: 'BCA Tahapan Gold',
        bankAccountNumber: '507431877335',
        customerPan: '9360000801144353984',
      },
    ],
  });

  if (fs.existsSync(todayLogFilePath)) {
    const fileLogContent = fs.readFileSync(todayLogFilePath, 'utf-8');
    const markerIndex = fileLogContent.lastIndexOf(uniqueTestMarker);
    const targetLogBlock = markerIndex !== -1 ? fileLogContent.slice(markerIndex) : '';

    const logContainsMarker = markerIndex !== -1;
    const logContainsMaskedAccount = targetLogBlock.includes('5074****7335');
    const logContainsMaskedPan = targetLogBlock.includes('9360****3984');
    const logContainsPlainAccount = targetLogBlock.includes('507431877335');
    const logContainsPlainPan = targetLogBlock.includes('9360000801144353984');

    assertCondition(
      'Log file contains test marker',
      logContainsMarker
    );
    assertCondition(
      'Log block contains masked bank account number (5074****7335)',
      logContainsMaskedAccount
    );
    assertCondition(
      'Log block contains masked PAN (9360****3984)',
      logContainsMaskedPan
    );
    assertCondition(
      'Log block does NOT contain unmasked bank account number (507431877335)',
      !logContainsPlainAccount
    );
    assertCondition(
      'Log block does NOT contain unmasked PAN (9360000801144353984)',
      !logContainsPlainPan
    );
  } else {
    assertCondition('Log file exists on disk', false, `Log file not found at ${todayLogFilePath}`);
  }

  // =========================================================================
  // Final Result
  // =========================================================================
  if (!allTestsPassed) {
    console.error('\n[FAIL] Some logger sanitizer unit tests failed.');
    process.exit(1);
  }

  console.log('\n[PASS] All logger sanitizer unit tests passed successfully.');
}

runLoggerSanitizerTests();
