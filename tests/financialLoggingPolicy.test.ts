import {
  isFinancialPayloadDebugEnabled,
  minimizeFinancialLogMessage,
  summarizeFinancialLogPayload,
} from '../src/utils/financialLoggingPolicy.js';

function assertCondition(description: string, condition: boolean): void {
  if (!condition) {
    console.error(`[FAIL] ${description}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[PASS] ${description}`);
}

const originalDebugFlag = process.env.DEBUG_FINANCIAL_PAYLOADS;

try {
  process.env.DEBUG_FINANCIAL_PAYLOADS = 'false';

  assertCondition(
    'financial payload debugging is disabled by default-style false value',
    isFinancialPayloadDebugEnabled() === false
  );

  const sensitivePayload = {
    method: 'create_records',
    records: [
      {
        amount: 125000,
        note: 'Dinner with Alice',
        counterParty: 'Kopi Senja',
        accountId: 'wallet-account-123',
      },
    ],
    accessToken: 'super-secret-token',
  };

  const summarizedPayload = summarizeFinancialLogPayload(sensitivePayload);
  const serializedSummary = JSON.stringify(summarizedPayload);

  assertCondition('default summary preserves payload shape metadata', summarizedPayload.payloadType === 'object');
  assertCondition('default summary preserves record count metadata', summarizedPayload.recordCount === 1);
  assertCondition('default summary does not contain transaction amount', !serializedSummary.includes('125000'));
  assertCondition('default summary does not contain transaction note', !serializedSummary.includes('Dinner with Alice'));
  assertCondition('default summary does not contain counterparty', !serializedSummary.includes('Kopi Senja'));
  assertCondition('default summary does not contain credential value', !serializedSummary.includes('super-secret-token'));

  const rawMessage = 'Gate passed | Amount: IDR 125000, Merchant: Kopi Senja, Ref: TX-991';
  const minimizedMessage = minimizeFinancialLogMessage(rawMessage);

  assertCondition('embedded amount is removed from default log message', !minimizedMessage.includes('125000'));
  assertCondition('embedded merchant is removed from default log message', !minimizedMessage.includes('Kopi Senja'));
  assertCondition('embedded reference is removed from default log message', !minimizedMessage.includes('TX-991'));

  const emailSubjectMessage = 'Processing detected email transaction: "Paid IDR 125000 to Kopi Senja"';
  assertCondition(
    'email transaction subject is removed from default log message',
    minimizeFinancialLogMessage(emailSubjectMessage) === 'Processing detected email transaction.'
  );

  process.env.DEBUG_FINANCIAL_PAYLOADS = 'true';
  assertCondition('financial payload debugging recognizes explicit true opt-in', isFinancialPayloadDebugEnabled() === true);
  assertCondition('debug opt-in preserves detailed financial message', minimizeFinancialLogMessage(rawMessage) === rawMessage);
} finally {
  if (originalDebugFlag === undefined) {
    delete process.env.DEBUG_FINANCIAL_PAYLOADS;
  } else {
    process.env.DEBUG_FINANCIAL_PAYLOADS = originalDebugFlag;
  }
}

if (process.exitCode) {
  throw new Error('Financial logging policy tests failed');
}

console.log('[SUCCESS] Financial logging policy tests passed.');
