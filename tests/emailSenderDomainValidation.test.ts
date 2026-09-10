import {
  evaluateEmailThroughGateOne,
  extractSenderDomain,
} from '../src/utils/emailGateEvaluator.js';

let passedTestsCount = 0;
let totalTestsCount = 0;

function assertCondition(testName: string, condition: boolean): void {
  totalTestsCount++;
  if (condition) {
    console.log(`[PASS] ${testName}`);
    passedTestsCount++;
  } else {
    console.error(`[FAIL] ${testName}`);
  }
}

const now = new Date();
const startupCutoff = new Date(now.getTime() - 10 * 60 * 1000);
const transactionSubject = 'Notifikasi Transaksi Livin by Mandiri: Debit Rekening';
const transactionBody = 'Total Debet: Rp 50.000';

const malformedSenderCases = [
  ['double opening angle bracket', '<<noreply@bankmandiri.co.id>'],
  ['multiple angle-bracket address groups', 'x<evil@attacker.com><noreply@bankmandiri.co.id>'],
  ['unbalanced opening angle bracket', '<noreply@bankmandiri.co.id'],
  ['unbalanced closing angle bracket', 'noreply@bankmandiri.co.id>'],
] as const;

for (const [caseName, senderValue] of malformedSenderCases) {
  assertCondition(
    `${caseName} does not produce a sender domain`,
    extractSenderDomain(senderValue) === undefined
  );

  const gateResult = evaluateEmailThroughGateOne(
    transactionSubject,
    senderValue,
    transactionBody,
    now,
    startupCutoff,
    new Set<string>()
  );

  assertCondition(
    `${caseName} fails Gate 1 sender validation`,
    !gateResult.passed && gateResult.reason === 'UNMATCHED_SENDER_DOMAIN'
  );
}

assertCondition(
  'legitimate display-name wrapped sender still parses',
  extractSenderDomain('Livin by Mandiri <noreply@bankmandiri.co.id>') === 'bankmandiri.co.id'
);

console.log(`Test Results: ${passedTestsCount}/${totalTestsCount} assertions passed.`);

if (passedTestsCount !== totalTestsCount) {
  process.exit(1);
}
