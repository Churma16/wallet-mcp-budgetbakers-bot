import { evaluateEmailThroughGateOne } from '../src/utils/emailGateEvaluator.js';
import { parseCurrencyAmountStringToNumber } from '../src/utils/emailGateEvaluator.js';
import { detectPendingConfirmationAction } from '../src/utils/fastPathIntentDetector.js';

console.log('====================================================');
console.log('[test] Running Email Logic Gate & Dictionary Test Suite');
console.log('====================================================\n');

let passedTestsCount = 0;
let totalTestsCount = 0;

function assertCondition(testName: string, condition: boolean, extraDetail?: string): void {
  totalTestsCount++;
  if (condition) {
    console.log(`[PASS] ${testName}`);
    passedTestsCount++;
  } else {
    console.error(`[FAIL] ${testName}${extraDetail ? ` -> ${extraDetail}` : ''}`);
  }
}

// ------------------------------------------------------------
// 1. Currency Parsing Tests
// ------------------------------------------------------------
console.log('--- 1. Testing Indonesian Currency Parsing ---');
assertCondition('Parse standard ID format "45.000"', parseCurrencyAmountStringToNumber('45.000') === 45000);
assertCondition('Parse ID format with cents "45.000,00"', parseCurrencyAmountStringToNumber('45.000,00') === 45000);
assertCondition('Parse large amount "1.500.000"', parseCurrencyAmountStringToNumber('1.500.000') === 1500000);
assertCondition('Parse prefix "Rp 120.500"', parseCurrencyAmountStringToNumber('Rp 120.500') === 120500);
assertCondition('Parse US format "25,000.00"', parseCurrencyAmountStringToNumber('25,000.00') === 25000);
assertCondition('Parse US format without cents "45,000"', parseCurrencyAmountStringToNumber('45,000') === 45000);
assertCondition('Parse plain digits "45000"', parseCurrencyAmountStringToNumber('45000') === 45000);
assertCondition('Parse empty or invalid amount fallback to 0', parseCurrencyAmountStringToNumber('') === 0);
assertCondition('Parse non-numeric text returns 0', parseCurrencyAmountStringToNumber('invalid') === 0);

// Setup mock test environment
const now = new Date();
const startupCutoff = new Date(now.getTime() - 10 * 60 * 1000); // 10 mins ago
const processedReferences = new Set<string>();

// ------------------------------------------------------------
// 2. Real-World Bank Email Gate 1 Evaluations
// ------------------------------------------------------------
console.log('\n--- 2. Testing Bank & E-Wallet Real-world Gate 1 Rules ---');

// Test A: Bank Mandiri (Livin')
const mandiriSample = evaluateEmailThroughGateOne(
  'Notifikasi Transaksi Livin by Mandiri: Debit Rekening',
  'noreply@bankmandiri.co.id',
  `Yth. Nasabah, transaksi berhasil pada 06 Sep 2026.
   Nomor Rekening: 1234567890
   Nomor Referensi: MANDIRI98765432
   Total Debet: Rp 45.000,00
   Keterangan: QRIS Kopi Kenangan`,
  now,
  startupCutoff,
  processedReferences
);
assertCondition('Mandiri QRIS email passed Gate 1', mandiriSample.passed);
assertCondition('Mandiri matched bank is "mandiri"', mandiriSample.matchedBankRule?.bankKey === 'mandiri');
assertCondition('Mandiri amount is 45000', mandiriSample.candidateAmount === 45000);
assertCondition('Mandiri ref is "MANDIRI98765432"', mandiriSample.referenceNumber === 'MANDIRI98765432');

// Test B: Bank Jago
const jagoSample = evaluateEmailThroughGateOne(
  'Uang keluar dari Kantong Utama',
  'noreply@jago.com',
  `Hai, uang sebesar Rp 150.000 telah keluar dari Kantong Utama kamu.
   Penerima: Indomaret Point
   ID Transaksi: JAGO112233
   Waktu: 06 Sep 2026`,
  now,
  startupCutoff,
  processedReferences
);
assertCondition('Bank Jago email passed Gate 1', jagoSample.passed);
assertCondition('Bank Jago matched bank is "jago"', jagoSample.matchedBankRule?.bankKey === 'jago');
assertCondition('Bank Jago amount is 150000', jagoSample.candidateAmount === 150000);
assertCondition('Bank Jago ref is "JAGO112233"', jagoSample.referenceNumber === 'JAGO112233');

// Test B2: Bank Jago English Merchant Payment
const jagoPaymentSample = evaluateEmailThroughGateOne(
  'You have made a payment to Kantin Euis',
  'noreply@jago.com',
  `Thank you for trusting Jago! You have made a payment, and here are the details:
   From 507431877335
   To Kantin Euis 9360000801144353984
   Amount Rp 10.000
   Transaction Date 08 September 2026, 11:54 WIB
   Transaction Status Successful
   Acquirer Name Bank Mandiri`,
  now,
  startupCutoff,
  processedReferences
);
assertCondition('Bank Jago English payment email passed Gate 1', jagoPaymentSample.passed);
assertCondition('Bank Jago English payment matched bank is "jago"', jagoPaymentSample.matchedBankRule?.bankKey === 'jago');
assertCondition('Bank Jago English payment amount is 10000', jagoPaymentSample.candidateAmount === 10000);

// Test B3: Bank Jago English Debit Card Transaction
const jagoDebitCardSample = evaluateEmailThroughGateOne(
  'You have made a transaction using your debit card',
  'noreply@jago.com',
  `Assalamu'alaikum John Doe,
   You have recently made a transaction of Rp38.889 using your Jago debit card.
   You can view the transaction history in your Pocket Details inside the Jago app.`,
  now,
  startupCutoff,
  processedReferences
);
assertCondition('Bank Jago English debit card email passed Gate 1', jagoDebitCardSample.passed);
assertCondition('Bank Jago English debit card matched bank is "jago"', jagoDebitCardSample.matchedBankRule?.bankKey === 'jago');
assertCondition('Bank Jago English debit card amount is 38889', jagoDebitCardSample.candidateAmount === 38889);

// Test C: GoPay / Gojek
const gopaySample = evaluateEmailThroughGateOne(
  'Bukti Pembayaran Pesanan GoFood kamu',
  'receipt@gojek.com',
  `Terima kasih sudah memesan GoFood!
   No. Pesanan: RB-99887766
   Total Pembayaran: Rp 65.500
   Metode: GoPay`,
  now,
  startupCutoff,
  processedReferences
);
assertCondition('GoPay receipt passed Gate 1', gopaySample.passed);
assertCondition('GoPay matched bank is "gopay"', gopaySample.matchedBankRule?.bankKey === 'gopay');
assertCondition('GoPay amount is 65500', gopaySample.candidateAmount === 65500);
assertCondition('GoPay order ID extracted', gopaySample.referenceNumber === 'RB-99887766');

// Test D: OVO
const ovoSample = evaluateEmailThroughGateOne(
  'Rincian Transaksi OVO Cash Berhasil',
  'no-reply@ovo.id',
  `Pembayaran OVO berhasil dilakukan.
   Nominal: Rp 28.000
   Merchant: Parkir Mall
   No. Referensi: OVO554433`,
  now,
  startupCutoff,
  processedReferences
);
assertCondition('OVO email passed Gate 1', ovoSample.passed);
assertCondition('OVO matched bank is "ovo"', ovoSample.matchedBankRule?.bankKey === 'ovo');
assertCondition('OVO amount is 28000', ovoSample.candidateAmount === 28000);

// Test E: DANA
const danaSample = evaluateEmailThroughGateOne(
  'Pembayaran Berhasil di DANA',
  'notification@dana.id',
  `Transaksi kamu sebesar Rp 80.000 berhasil diproses.
   Merchant: Pulsa Telkomsel
   ID Pesanan: DANA778899`,
  now,
  startupCutoff,
  processedReferences
);
assertCondition('DANA email passed Gate 1', danaSample.passed);
assertCondition('DANA matched bank is "dana"', danaSample.matchedBankRule?.bankKey === 'dana');
assertCondition('DANA amount is 80000', danaSample.candidateAmount === 80000);

// Test F: ShopeePay
const shopeeSample = evaluateEmailThroughGateOne(
  'Rincian Pesanan Shopee & Pembayaran Berhasil',
  'no-reply@shopeepay.co.id',
  `Pembayaran berhasil dengan ShopeePay.
   Total Pesanan: Rp 125.000
   ID Pesanan: 260906SP123456`,
  now,
  startupCutoff,
  processedReferences
);
assertCondition('ShopeePay email passed Gate 1', shopeeSample.passed);
assertCondition('ShopeePay matched bank is "shopeepay"', shopeeSample.matchedBankRule?.bankKey === 'shopeepay');
assertCondition('ShopeePay amount is 125000', shopeeSample.candidateAmount === 125000);

// ------------------------------------------------------------
// 3. Security, Blacklist & Edge Cases Filter Tests
// ------------------------------------------------------------
console.log('\n--- 3. Testing Blacklist, Security & Edge Cases (Must be Rejected) ---');

// Case 1: OTP Email (Must be rejected)
const otpEmail = evaluateEmailThroughGateOne(
  'Kode OTP Verifikasi Login Mandiri',
  'noreply@bankmandiri.co.id',
  'Jangan berikan kode OTP 123456 kepada siapa pun.',
  now,
  startupCutoff,
  processedReferences
);
assertCondition('OTP email rejected by Gate 1', !otpEmail.passed && otpEmail.reason === 'SUBJECT_BLACKLIST_KEYWORD_MATCH');

// Case 2: Promo / Voucher Email (Must be rejected)
const promoEmail = evaluateEmailThroughGateOne(
  'Promo Diskon Spesial ShopeePay 50%',
  'no-reply@shopeepay.co.id',
  'Dapatkan cashback koin hingga 50rb hanya hari ini!',
  now,
  startupCutoff,
  processedReferences
);
assertCondition('Promo email rejected by Gate 1', !promoEmail.passed && promoEmail.reason === 'SUBJECT_BLACKLIST_KEYWORD_MATCH');

// Case 3: Email from Unknown Sender (Must be rejected)
const unknownSenderEmail = evaluateEmailThroughGateOne(
  'Notifikasi Pembayaran Tagihan',
  'billing@random-service.xyz',
  'Tagihan Anda sebesar Rp 50.000 telah terbit.',
  now,
  startupCutoff,
  processedReferences
);
assertCondition('Unknown sender domain rejected', !unknownSenderEmail.passed && unknownSenderEmail.reason === 'UNMATCHED_SENDER_DOMAIN');

// Case 4: Email received before startup (Must be rejected)
const pastDate = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 1 day ago
const oldEmail = evaluateEmailThroughGateOne(
  'Notifikasi Transaksi Debit Rekening',
  'noreply@bankmandiri.co.id',
  'Total Debet: Rp 50.000',
  pastDate,
  startupCutoff,
  processedReferences
);
assertCondition('Historical email before startup rejected', !oldEmail.passed && oldEmail.reason === 'EMAIL_BEFORE_STARTUP_CUTOFF');

// Case 5: Duplicate Reference ID (Must be rejected)
processedReferences.add('MANDIRI98765432');
const duplicateEmail = evaluateEmailThroughGateOne(
  'Notifikasi Transaksi Livin by Mandiri: Debit Rekening',
  'noreply@bankmandiri.co.id',
  'Nomor Referensi: MANDIRI98765432 Total Debet: Rp 45.000',
  now,
  startupCutoff,
  processedReferences
);
assertCondition('Duplicate reference ID rejected', !duplicateEmail.passed && duplicateEmail.reason === 'DUPLICATE_TRANSACTION_REFERENCE_NUMBER');

// Case 6: Bank Jago Debit Card Being Processed Email (Must be rejected)
const jagoProcessEmail = evaluateEmailThroughGateOne(
  'Your new Jago debit card is being process',
  'noreply@jago.com',
  'Your card request has been received and is being processed.',
  now,
  startupCutoff,
  processedReferences
);
assertCondition('Jago debit card being processed email rejected by Gate 1', !jagoProcessEmail.passed && jagoProcessEmail.reason === 'SUBJECT_BLACKLIST_KEYWORD_MATCH');

// Case 7: Bank Jago Marketing / Fresh New Look Email (Must be rejected)
const jagoMarketingEmail = evaluateEmailThroughGateOne(
  'Your Jago Syariah Card is getting a fresh new look!',
  'noreply@jago.com',
  'We have updated the design of our cards.',
  now,
  startupCutoff,
  processedReferences
);
assertCondition('Jago card marketing email rejected by Gate 1', !jagoMarketingEmail.passed && jagoMarketingEmail.reason === 'SUBJECT_BLACKLIST_KEYWORD_MATCH');

// Case 8: Allowed domain as attacker-controlled parent substring (Issue #24)
const maliciousSuffixSender = evaluateEmailThroughGateOne(
  'Notifikasi Transaksi Livin by Mandiri: Debit Rekening',
  'alert@bankmandiri.co.id.attacker-domain.com',
  'Total Debet: Rp 50.000',
  now,
  startupCutoff,
  new Set<string>()
);
assertCondition(
  'Spoofed parent domain containing allowed bank domain is rejected',
  !maliciousSuffixSender.passed && maliciousSuffixSender.reason === 'UNMATCHED_SENDER_DOMAIN'
);

// Case 9: Allowed domain only in local part (Issue #24)
const localPartSpoofSender = evaluateEmailThroughGateOne(
  'Notifikasi Transaksi Livin by Mandiri: Debit Rekening',
  'bankmandiri.co.id@attacker-domain.com',
  'Total Debet: Rp 50.000',
  now,
  startupCutoff,
  new Set<string>()
);
assertCondition(
  'Allowed bank domain appearing only in local part is rejected',
  !localPartSpoofSender.passed && localPartSpoofSender.reason === 'UNMATCHED_SENDER_DOMAIN'
);

// Case 10: Display name contains allowlisted domain but address does not (Issue #24)
const displayNameSpoofSender = evaluateEmailThroughGateOne(
  'Notifikasi Transaksi Livin by Mandiri: Debit Rekening',
  'bankmandiri.co.id Security <alert@attacker-domain.com>',
  'Total Debet: Rp 50.000',
  now,
  startupCutoff,
  new Set<string>()
);
assertCondition(
  'Allowed bank domain appearing only in display name is rejected',
  !displayNameSpoofSender.passed && displayNameSpoofSender.reason === 'UNMATCHED_SENDER_DOMAIN'
);

// Case 11: Legitimate display-name wrapped sender is accepted (Issue #24)
const displayNameLegitimateSender = evaluateEmailThroughGateOne(
  'Notifikasi Transaksi Livin by Mandiri: Debit Rekening',
  'Livin by Mandiri <noreply@bankmandiri.co.id>',
  'Total Debet: Rp 50.000',
  now,
  startupCutoff,
  new Set<string>()
);
assertCondition('Legitimate display-name wrapped bank sender is accepted', displayNameLegitimateSender.passed);

// Case 12: Legitimate subdomain is explicitly accepted by suffix boundary policy (Issue #24)
const legitimateSubdomainSender = evaluateEmailThroughGateOne(
  'Notifikasi Transaksi Livin by Mandiri: Debit Rekening',
  'alert@notify.bankmandiri.co.id',
  'Total Debet: Rp 50.000',
  now,
  startupCutoff,
  new Set<string>()
);
assertCondition('Legitimate subdomain of configured bank domain is accepted', legitimateSubdomainSender.passed);

// Case 13: Malformed sender values fail closed (Issue #24)
const malformedSender = evaluateEmailThroughGateOne(
  'Notifikasi Transaksi Livin by Mandiri: Debit Rekening',
  'noreply@@bankmandiri.co.id',
  'Total Debet: Rp 50.000',
  now,
  startupCutoff,
  new Set<string>()
);
assertCondition(
  'Malformed sender address is rejected',
  !malformedSender.passed && malformedSender.reason === 'UNMATCHED_SENDER_DOMAIN'
);

// ------------------------------------------------------------
// 4. WhatsApp Pending Confirmation Intent Tests
// ------------------------------------------------------------
console.log('\n--- 4. Testing WhatsApp Pending Confirmation Intent Detector ---');

const confirmLatest = detectPendingConfirmationAction('Ya');
assertCondition('Detect "Ya" as CONFIRM LATEST', confirmLatest?.actionType === 'CONFIRM' && confirmLatest.targetScope === 'LATEST');

const confirmSpecific = detectPendingConfirmationAction('catat #2');
assertCondition('Detect "catat #2" as CONFIRM Ticket 2', confirmSpecific?.actionType === 'CONFIRM' && confirmSpecific.targetScope === 2);

const confirmAll = detectPendingConfirmationAction('ya semua');
assertCondition('Detect "ya semua" as CONFIRM ALL', confirmAll?.actionType === 'CONFIRM' && confirmAll.targetScope === 'ALL');

const rejectLatest = detectPendingConfirmationAction('Batal');
assertCondition('Detect "Batal" as REJECT LATEST', rejectLatest?.actionType === 'REJECT' && rejectLatest.targetScope === 'LATEST');

const rejectSpecific = detectPendingConfirmationAction('batal 1');
assertCondition('Detect "batal 1" as REJECT Ticket 1', rejectSpecific?.actionType === 'REJECT' && rejectSpecific.targetScope === 1);

const rejectAll = detectPendingConfirmationAction('abaikan semua');
assertCondition('Detect "abaikan semua" as REJECT ALL', rejectAll?.actionType === 'REJECT' && rejectAll.targetScope === 'ALL');

const normalMessage = detectPendingConfirmationAction('makan siang 35rb bca');
assertCondition('Normal expense message is NOT intercepted as confirmation intent', normalMessage === null);

// ------------------------------------------------------------
// Summary
// ------------------------------------------------------------
console.log('\n====================================================');
console.log(`Test Results: ${passedTestsCount}/${totalTestsCount} assertions passed.`);
console.log('====================================================');

if (passedTestsCount === totalTestsCount) {
  console.log('[SUCCESS] All Email Gate Rules & Intent Detector Tests Passed Successfully!\n');
  process.exit(0);
} else {
  console.error('[WARN] Some tests failed. Please review the output above.\n');
  process.exit(1);
}
