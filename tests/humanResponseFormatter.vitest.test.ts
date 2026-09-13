import assert from 'node:assert';
import { afterAll, beforeAll, describe, test, vi } from 'vitest';
import {
  formatRecordSuccessMessage,
  formatBalanceSummaryMessage,
  formatErrorMessageForHuman,
  formatTransactionDate,
  formatTransactionHistoryMessage,
  truncateTransactionTitle,
  formatCompactTransactionDate,
  formatCompactTransactionAmount,
  MAX_TRANSACTION_HISTORY_TITLE_LENGTH,
} from '../src/utils/humanResponseFormatter.js';
import { formatConciseErrorMessage } from '../src/utils/logger.js';
import { AiResponseParseError } from '../src/services/ai/jsonExtractionHelper.js';

describe('human response formatter', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T06:00:00.000Z'));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  test('formats a single record created today', () => {
    const message = formatRecordSuccessMessage(
      [{ accountId: 'acc1', amount: -35000, recordDate: new Date().toISOString(), categoryId: 'cat1', note: 'Makan siang' }],
      [{ id: 'acc1', name: 'Gopay' }],
      [{ id: 'cat1', name: 'Makanan & Minuman' }]
    );

    assert.ok(message.includes('Makan siang'), 'Single record message includes note');
    assert.ok(message.includes('Gopay'), 'Single record message includes account');
  });

  test('formats a past-date transaction with its account', () => {
    const message = formatRecordSuccessMessage(
      [{
        accountId: 'acc2',
        amount: -5000,
        recordDate: '2026-09-03T10:15:00.000Z',
        categoryId: 'cat3',
        note: 'Insufficient Funds Fee (Visa payment failed)',
      }],
      [{ id: 'acc2', name: 'Jago Expense' }],
      [{ id: 'cat3', name: 'Charges, fees' }]
    );

    assert.ok(message.includes('Jago Expense'), 'Past record message includes account');
  });

  test('formats multiple records without dropping any items', () => {
    const message = formatRecordSuccessMessage(
      [
        { accountId: 'acc1', amount: -35000, recordDate: new Date().toISOString(), categoryId: 'cat1', note: 'Makan siang' },
        { accountId: 'acc1', amount: -5000, recordDate: new Date().toISOString(), categoryId: 'cat2', note: 'Parkir' },
      ],
      [{ id: 'acc1', name: 'Gopay' }],
      [{ id: 'cat1', name: 'Makanan & Minuman' }, { id: 'cat2', name: 'Transportasi' }]
    );

    assert.ok(message.includes('Makan siang') && message.includes('Parkir'), 'Multi record includes all items');
  });

  test('formats a balance summary containing all accounts', () => {
    const message = formatBalanceSummaryMessage([
      { id: '1', name: 'Cash', balance: 150000, currency: 'IDR' },
      { id: '2', name: 'Dana', balance: 50000, currency: 'IDR' },
      { id: '3', name: 'Gopay', balance: 350000, currency: 'IDR' },
      { id: '4', name: 'Mandiri Debit', balance: 2500000, currency: 'IDR' },
    ]);

    assert.ok(message.includes('Mandiri Debit'), 'Balance summary contains accounts');
  });

  test('maps a 503 AI error to the busy response', () => {
    const message = formatErrorMessageForHuman(
      new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}')
    );

    assert.ok(message.includes('Layanan AI lagi ramai'), 'AI busy error returns aiBusy response');
  });

  test('maps a true MCP schema validation failure to the schema-validation response', () => {
    const message = formatErrorMessageForHuman(
      new Error('[error] MCP Tool create_records failed: schema validation failed at /records/0: unexpected additional properties')
    );

    assert.ok(message.includes('format datanya kurang pas'), 'True schema validation returns schemaValidation error');
  });

  test('does not misclassify a downstream create_records failure as schema validation', () => {
    const message = formatErrorMessageForHuman(
      new Error("[error] MCP Tool 'create_records' rejected 1 record(s) with definitive failure")
    );

    assert.ok(!message.includes('format datanya kurang pas'));
    assert.ok(message.includes('Ada kendala saat memproses pesanmu'));
  });

  test('maps a network timeout to the network-connection response', () => {
    const message = formatErrorMessageForHuman(new Error('connect ETIMEDOUT 104.26.12.31:443'));
    assert.ok(message.includes('Koneksi ke server lagi gangguan'));
  });

  test('maps receipt parse failures to receipt-specific messages in image context', () => {
    const idMessage = formatErrorMessageForHuman(
      new AiResponseParseError('No valid JSON object structure found in AI response', 'Some raw OCR text'),
      undefined,
      'id',
      { isImageMessage: true }
    );
    assert.ok(idMessage.includes('Foto struk belum berhasil dibaca'));

    const enMessage = formatErrorMessageForHuman(
      new AiResponseParseError('Unable to parse JSON from AI response', 'Malformed text'),
      undefined,
      'en',
      { isImageMessage: true }
    );
    assert.ok(enMessage.includes('Could not clearly read the receipt image'));
  });

  test('does not misclassify downstream JSON-RPC failures in image context as OCR failures', () => {
    const message = formatErrorMessageForHuman(
      new Error('[error] MCP JSON-RPC Error: tool execution failed'),
      undefined,
      'id',
      { isImageMessage: true }
    );

    assert.ok(!message.includes('Foto struk belum berhasil dibaca'));
    assert.ok(message.includes('Ada kendala saat memproses pesanmu'));
  });

  test('formats concise quota errors', () => {
    const error = `{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash\\nPlease retry in 37.417182623s.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.Help","links":[{"description":"Learn more about Gemini API quotas","url":"https://ai.google.dev/gemini-api/docs/rate-limits"}]}]}}`;
    assert.ok(formatConciseErrorMessage(error).length > 0);
  });

  test('formats concise unavailable errors', () => {
    const error = `{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}`;
    assert.ok(formatConciseErrorMessage(error).length > 0);
  });

  test('handles invalid and missing transaction dates without throwing', () => {
    assert.doesNotThrow(() => formatTransactionDate('not-a-valid-date'));
    assert.doesNotThrow(() => formatTransactionDate(new Date('invalid')));
    assert.doesNotThrow(() => formatTransactionDate(undefined));
  });

  test('truncates transaction titles deterministically and safely', () => {
    const shortTitle = 'Biaya admin tf';
    assert.strictEqual(truncateTransactionTitle(shortTitle, MAX_TRANSACTION_HISTORY_TITLE_LENGTH), shortTitle);

    const exactLengthTitle = 'A'.repeat(MAX_TRANSACTION_HISTORY_TITLE_LENGTH);
    assert.strictEqual(truncateTransactionTitle(exactLengthTitle, MAX_TRANSACTION_HISTORY_TITLE_LENGTH), exactLengthTitle);

    const longTitle = 'Pengkreditan otomatis PEMAGANGAN ANGKATAN 2 KEMENTERIAN KETENAGAKERJAAN REPUBLIK INDONESIA';
    assert.strictEqual(
      truncateTransactionTitle(longTitle, MAX_TRANSACTION_HISTORY_TITLE_LENGTH),
      'Pengkreditan otomatis PEMAGANGAN ANGKATAN 2...'
    );
    assert.strictEqual(longTitle.startsWith('Pengkreditan otomatis'), true);

    const multilineTitle = 'Pembayaran Toko Buku\nLantai 2\r\nBlok B';
    assert.strictEqual(truncateTransactionTitle(multilineTitle), 'Pembayaran Toko Buku Lantai 2 Blok B');

    const emojiBoundaryTitle = `${'A'.repeat(42)}🎉 EXTRA_TEXT_THAT_SHOULD_BE_TRUNCATED`;
    assert.strictEqual(truncateTransactionTitle(emojiBoundaryTitle), `${'A'.repeat(42)}🎉...`);
  });

  test('formats compact signed amounts across IDR and USD', () => {
    assert.strictEqual(formatCompactTransactionAmount(-20895, 'expense', 'IDR', 'id'), '-Rp20.895');
    assert.strictEqual(formatCompactTransactionAmount(5729876, 'income', 'IDR', 'id'), '+Rp5.729.876');
    assert.strictEqual(formatCompactTransactionAmount(-25, 'expense', 'USD', 'en'), '-$25.00');
    assert.strictEqual(formatCompactTransactionAmount(100.5, 'income', 'USD', 'en'), '+$100.50');
  });

  test('formats compact dates deterministically across year boundaries', () => {
    const fixedReferenceInstant = new Date('2026-06-15T12:00:00.000Z');
    const currentYear = formatCompactTransactionDate(
      new Date('2026-09-11T06:52:00.000Z'),
      'id',
      fixedReferenceInstant
    );
    assert.doesNotMatch(currentYear, /2026/);
    assert.match(currentYear, /13:52/);

    const pastYear = formatCompactTransactionDate(
      new Date('2024-05-10T03:15:00.000Z'),
      'id',
      fixedReferenceInstant
    );
    assert.match(pastYear, /2024/);
  });

  test('formats compact transaction history with the three-line layout in Indonesian and English', () => {
    const page = {
      records: [
        {
          id: 'rec-1', accountId: 'acc-1', accountName: 'Cash', amount: -1000, currency: 'IDR',
          recordDate: '2026-09-11T06:53:00.000Z', recordType: 'expense' as const,
          note: 'Biaya admin tf', category: { id: 'cat-1', name: 'Charges, fees' },
        },
        {
          id: 'rec-2', accountId: 'acc-2', accountName: 'Gopay', amount: -20895, currency: 'IDR',
          recordDate: '2026-09-11T06:52:00.000Z', recordType: 'expense' as const,
          note: 'Pembayaran ke Nodus Digital Store', category: { id: 'cat-2', name: 'Pengeluaran Digital' },
        },
        {
          id: 'rec-3', accountId: 'acc-3', accountName: 'Mandiri Debit Card', amount: 5729876, currency: 'IDR',
          recordDate: '2026-09-10T14:31:00.000Z', recordType: 'income' as const,
          note: 'Pengkreditan otomatis PEMAGANGAN ANGKATAN 2 KEMENTERIAN KETENAGAKERJAAN',
          category: { id: 'cat-3', name: 'Wage, invoices' }, labels: [{ id: 'lbl-1', name: 'salary' }],
        },
      ],
      total: 3741, limit: 10, offset: 0, page: 1, totalPages: 375, nextOffset: 10, hasMore: true,
      sort: 'newest' as const,
    };

    const idMessage = formatTransactionHistoryMessage(page, 'id');
    assert.match(idMessage, /^📋 \*Riwayat Transaksi\*\nHal\. 1\/375 • 3 item/m);
    assert.match(idMessage, /1\. Biaya admin tf\n\*-Rp1\.000\* • Cash\nCharges, fees • \d+ Sep \d\d:\d\d/m);
    assert.match(idMessage, /2\. Pembayaran ke Nodus Digital Store\n\*-Rp20\.895\* • Gopay\nPengeluaran Digital • \d+ Sep \d\d:\d\d/m);
    assert.match(idMessage, /3\. Pengkreditan otomatis PEMAGANGAN ANGKATAN 2\.\.\.\n\*\+Rp5\.729\.876\* • Mandiri Debit Card\nWage, invoices • \d+ Sep \d\d:\d\d • #salary/m);
    assert.ok(idMessage.includes('\n\n1. Biaya admin tf'));
    assert.ok(idMessage.includes('\n\n2. Pembayaran ke Nodus Digital Store'));
    assert.ok(idMessage.includes('\n\n3. Pengkreditan otomatis'));
    const itemsBodyOnly = idMessage.split('\n\n').slice(1, -1).join('\n\n');
    assert.doesNotMatch(itemsBodyOnly, /[💸💰🔄🏷️🔖]/u);

    const enMessage = formatTransactionHistoryMessage(page, 'en');
    assert.match(enMessage, /^📋 \*Transaction History\*\nPage 1\/375 • 3 items/m);
    assert.match(enMessage, /1\. Biaya admin tf\n\*-Rp1,000\* • Cash/m);
    assert.match(enMessage, /3\. Pengkreditan otomatis PEMAGANGAN ANGKATAN 2\.\.\.\n\*\+Rp5,729,876\* • Mandiri Debit Card/m);
  });

  test('falls back safely when optional transaction-history fields are absent', () => {
    const page = {
      records: [{ id: 'rec-fallback', amount: -15000, currency: 'IDR', recordDate: '2026-09-11T10:00:00.000Z' }],
      total: 1, limit: 10, offset: 0, page: 1, totalPages: 1, nextOffset: null, hasMore: false,
      sort: 'newest' as const,
    };
    const message = formatTransactionHistoryMessage(page, 'id');
    assert.match(message, /1\. Pengeluaran\n\*-Rp15\.000\* • Akun\nUmum • \d+ Sep \d\d:\d\d/m);
  });

  test('preserves transfer semantics in compact transaction history', () => {
    const page = {
      records: [{
        id: 'rec-transfer-1', accountId: 'acc-bca', accountName: 'BCA Utama', amount: -500000,
        currency: 'IDR', recordDate: '2026-09-11T06:50:00.000Z', recordType: 'expense' as const,
        transfer: { type: 'transfer' },
      }],
      total: 1, limit: 10, offset: 0, page: 1, totalPages: 1, nextOffset: null, hasMore: false,
      sort: 'newest' as const,
    };
    const message = formatTransactionHistoryMessage(page, 'id');
    assert.match(message, /1\. Transfer \/ Top-Up/);
    assert.match(message, /\*-Rp500\.000\* • BCA Utama/);
    assert.match(message, /Transfer \/ Top-Up • \d+ Sep \d\d:\d\d/);
    assert.strictEqual(message.includes('Pengeluaran'), false);
  });
});
