import assert from 'node:assert';
import test from 'node:test';
import {
  WalletMcpClientService,
  MAX_TRANSACTION_SEARCH_SCAN_CALLS_PER_REQUEST,
} from '../src/services/walletMcpService.js';
import { detectFastPathAction } from '../src/utils/fastPathIntentDetector.js';
import { formatTransactionHistoryMessage } from '../src/utils/humanResponseFormatter.js';
import { setActiveLanguage } from '../src/i18n/index.js';

console.log('[TEST] Starting PR #114 transaction search review regression tests...');

test('quoted search literals are not consumed as structured filters', () => {
  const quotedIncome = detectFastPathAction('search "income"');
  assert.strictEqual(typeof quotedIncome, 'object');
  assert.strictEqual((quotedIncome as any)?.options.searchQuery, 'income');
  assert.strictEqual((quotedIncome as any)?.options.recordType, undefined);

  const quotedToday = detectFastPathAction('search "today"');
  assert.strictEqual((quotedToday as any)?.options.searchQuery, 'today');
  assert.strictEqual((quotedToday as any)?.options.datePeriod, undefined);

  const quotedOldest = detectFastPathAction('cari "oldest"');
  assert.strictEqual((quotedOldest as any)?.options.searchQuery, 'oldest');
  assert.strictEqual((quotedOldest as any)?.options.sort, 'newest');

  const quotedNumber = detectFastPathAction('cari "5"');
  assert.strictEqual((quotedNumber as any)?.options.searchQuery, '5');
  assert.strictEqual((quotedNumber as any)?.options.limit, undefined);
});

test('dedicated single-token search keeps filter-like words literal', () => {
  const literalIncome = detectFastPathAction('search income');
  assert.strictEqual((literalIncome as any)?.type, 'TRANSACTION_HISTORY');
  assert.strictEqual((literalIncome as any)?.options.searchQuery, 'income');
  assert.strictEqual((literalIncome as any)?.options.recordType, undefined);

  const literalToday = detectFastPathAction('search today');
  assert.strictEqual((literalToday as any)?.type, 'TRANSACTION_HISTORY');
  assert.strictEqual((literalToday as any)?.options.searchQuery, 'today');
  assert.strictEqual((literalToday as any)?.options.datePeriod, undefined);

  const literalAccount = detectFastPathAction('cari bca');
  assert.strictEqual((literalAccount as any)?.type, 'TRANSACTION_HISTORY');
  assert.strictEqual((literalAccount as any)?.options.searchQuery, 'bca');
  assert.strictEqual((literalAccount as any)?.options.accountName, undefined);

  const literalNumber = detectFastPathAction('search 5');
  assert.strictEqual((literalNumber as any)?.type, 'TRANSACTION_HISTORY');
  assert.strictEqual((literalNumber as any)?.options.searchQuery, '5');
  assert.strictEqual((literalNumber as any)?.options.limit, undefined);
});

test('incremental local search keeps records and pagination on the same semantics', async () => {
  const client = new WalletMcpClientService('http://localhost:8080', 'mock-token');
  const capturedOffsets: number[] = [];

  client.callMcpTool = async <T>(_toolName: string, args: Record<string, unknown> = {}): Promise<T> => {
    const offset = Number(args.offset ?? 0);
    capturedOffsets.push(offset);

    if (offset === 0) {
      return {
        records: Array.from({ length: 10 }, (_, index) => ({
          id: `page-1-${index}`,
          accountId: 'acc-1',
          amount: -(index + 1),
          currency: 'IDR',
          recordDate: '2026-09-11T10:00:00Z',
          recordType: 'expense',
          counterParty: index < 2 ? `Target Merchant ${index}` : `Other Merchant ${index}`,
        })),
        total: 30,
      } as T;
    }

    if (offset === 10) {
      return {
        records: Array.from({ length: 10 }, (_, index) => ({
          id: `page-2-${index}`,
          accountId: 'acc-1',
          amount: -(index + 11),
          currency: 'IDR',
          recordDate: '2026-09-10T10:00:00Z',
          recordType: 'expense',
          counterParty: index === 0 ? 'Target Merchant Later' : `Other Merchant ${index + 10}`,
        })),
        total: 30,
      } as T;
    }

    return {
      records: Array.from({ length: 10 }, (_, index) => ({
        id: `page-3-${index}`,
        accountId: 'acc-1',
        amount: -(index + 21),
        currency: 'IDR',
        recordDate: '2026-09-09T10:00:00Z',
        recordType: 'expense',
        counterParty: `Other Merchant ${index + 20}`,
      })),
      total: 30,
    } as T;
  };

  const firstPage = await client.fetchRecords({ searchQuery: 'target merchant', limit: 2, page: 1 });
  assert.strictEqual(firstPage.records.length, 2);
  assert.strictEqual(firstPage.total, undefined);
  assert.strictEqual(firstPage.totalPages, undefined);
  assert.strictEqual(firstPage.hasMore, true);
  assert.strictEqual(firstPage.nextOffset, 2);
  assert.deepStrictEqual(capturedOffsets, [0, 10]);

  const secondPage = await client.fetchRecords({ searchQuery: 'target merchant', limit: 2, page: 2 });
  assert.deepStrictEqual(capturedOffsets, [0, 10, 20]);
  assert.strictEqual(secondPage.page, 2);
  assert.strictEqual(secondPage.offset, 2);
  assert.strictEqual(secondPage.records.length, 1);
  assert.strictEqual(secondPage.records[0].id, 'page-2-0');
  assert.strictEqual(secondPage.total, 3);
  assert.strictEqual(secondPage.totalPages, 2);
  assert.strictEqual(secondPage.hasMore, false);
  assert.strictEqual(secondPage.nextOffset, null);
});

test('broad search stops after page lookahead and reuses cached candidates', async () => {
  const client = new WalletMcpClientService('http://localhost:8080', 'mock-token');
  const capturedOffsets: number[] = [];

  client.callMcpTool = async <T>(_toolName: string, args: Record<string, unknown> = {}): Promise<T> => {
    const offset = Number(args.offset ?? 0);
    const limit = Number(args.limit ?? 10);
    capturedOffsets.push(offset);

    return {
      records: Array.from({ length: limit }, (_, index) => ({
        id: `broad-${offset + index}`,
        accountId: 'acc-1',
        amount: -(offset + index + 1),
        currency: 'IDR',
        recordDate: '2026-09-11T10:00:00Z',
        recordType: 'expense',
        counterParty: `Target Merchant ${offset + index}`,
      })),
      total: 1000,
    } as T;
  };

  const firstPage = await client.fetchRecords({ searchQuery: 'target merchant', limit: 5, page: 1 });
  assert.strictEqual(firstPage.records.length, 5);
  assert.strictEqual(firstPage.records[0].id, 'broad-0');
  assert.strictEqual(firstPage.total, undefined);
  assert.strictEqual(firstPage.totalPages, undefined);
  assert.strictEqual(firstPage.hasMore, true);
  assert.deepStrictEqual(capturedOffsets, [0, 5]);

  const callsAfterFirstPage = capturedOffsets.length;
  const secondPage = await client.fetchRecords({ searchQuery: 'target merchant', limit: 5, page: 2 });
  assert.strictEqual(secondPage.records.length, 5);
  assert.strictEqual(secondPage.records[0].id, 'broad-5');
  assert.strictEqual(secondPage.hasMore, true);
  assert.strictEqual(capturedOffsets.length, callsAfterFirstPage);
  assert.deepStrictEqual(capturedOffsets, [0, 5]);
});

test('sparse search stops at the per-request MCP scan budget and returns an actionable unresolved state', async () => {
  const client = new WalletMcpClientService('http://localhost:8080', 'mock-token');
  const capturedOffsets: number[] = [];

  client.callMcpTool = async <T>(_toolName: string, args: Record<string, unknown> = {}): Promise<T> => {
    const offset = Number(args.offset ?? 0);
    const limit = Number(args.limit ?? 10);
    capturedOffsets.push(offset);

    return {
      records: Array.from({ length: limit }, (_, index) => ({
        id: `sparse-${offset + index}`,
        accountId: 'acc-1',
        amount: -(offset + index + 1),
        currency: 'IDR',
        recordDate: '2026-09-11T10:00:00Z',
        recordType: 'expense',
        counterParty: `Other Merchant ${offset + index}`,
      })),
      total: 10000,
    } as T;
  };

  const firstAttempt = await client.fetchRecords({ searchQuery: 'needle merchant', limit: 10, page: 1 });
  assert.strictEqual(capturedOffsets.length, MAX_TRANSACTION_SEARCH_SCAN_CALLS_PER_REQUEST);
  assert.deepStrictEqual(capturedOffsets, [0, 10, 60, 110, 160]);
  assert.strictEqual(firstAttempt.records.length, 0);
  assert.strictEqual(firstAttempt.total, undefined);
  assert.strictEqual(firstAttempt.totalPages, undefined);
  assert.strictEqual(firstAttempt.hasMore, false);
  assert.strictEqual(firstAttempt.nextOffset, null);
  assert.strictEqual(firstAttempt.unresolvedFilters?.length, 1);
  assert.strictEqual(firstAttempt.unresolvedFilters?.[0].filterKey, 'searchQuery');
  assert.strictEqual(firstAttempt.unresolvedFilters?.[0].reason, 'UNRESOLVED');
  assert.match(firstAttempt.unresolvedFilters?.[0].message || '', /scan budget/i);

  setActiveLanguage('en');
  const formattedEn = formatTransactionHistoryMessage(firstAttempt);
  assert.match(formattedEn, /retry the same search/i);
  assert.match(formattedEn, /account, category, or date filters/i);

  setActiveLanguage('id');
  const formattedId = formatTransactionHistoryMessage(firstAttempt);
  assert.match(formattedId, /ulangi pencarian yang sama/i);
  assert.match(formattedId, /filter akun, kategori, atau tanggal/i);

  const firstAttemptCallCount = capturedOffsets.length;
  const secondAttempt = await client.fetchRecords({ searchQuery: 'needle merchant', limit: 10, page: 1 });
  assert.strictEqual(capturedOffsets.length, firstAttemptCallCount + MAX_TRANSACTION_SEARCH_SCAN_CALLS_PER_REQUEST);
  assert.strictEqual(capturedOffsets[firstAttemptCallCount], 210);
  assert.strictEqual(secondAttempt.unresolvedFilters?.[0].reason, 'UNRESOLVED');
});

test('unknown lookahead stays resumable until the next match is verified', async () => {
  const client = new WalletMcpClientService('http://localhost:8080', 'mock-token');
  const capturedOffsets: number[] = [];

  client.callMcpTool = async <T>(_toolName: string, args: Record<string, unknown> = {}): Promise<T> => {
    const offset = Number(args.offset ?? 0);
    const limit = Number(args.limit ?? 10);
    capturedOffsets.push(offset);
    const callIndex = capturedOffsets.length;

    return {
      records: Array.from({ length: limit }, (_, index) => {
        const shouldMatch =
          (callIndex === MAX_TRANSACTION_SEARCH_SCAN_CALLS_PER_REQUEST && index < 10) ||
          (callIndex === MAX_TRANSACTION_SEARCH_SCAN_CALLS_PER_REQUEST + 1 && index === 0);
        return {
          id: `lookahead-${offset + index}`,
          accountId: 'acc-1',
          amount: -(offset + index + 1),
          currency: 'IDR',
          recordDate: '2026-09-11T10:00:00Z',
          recordType: 'expense',
          counterParty: shouldMatch ? `Target Merchant ${offset + index}` : `Other Merchant ${offset + index}`,
        };
      }),
      total: 10000,
    } as T;
  };

  const firstAttempt = await client.fetchRecords({ searchQuery: 'target merchant', limit: 10, page: 1 });
  assert.strictEqual(capturedOffsets.length, MAX_TRANSACTION_SEARCH_SCAN_CALLS_PER_REQUEST);
  assert.strictEqual(firstAttempt.records.length, 10);
  assert.strictEqual(firstAttempt.unresolvedFilters, undefined);
  assert.strictEqual(firstAttempt.total, undefined);
  assert.strictEqual(firstAttempt.totalPages, undefined);
  assert.strictEqual(firstAttempt.hasMore, false);
  assert.strictEqual(firstAttempt.nextOffset, null);
  assert.strictEqual(firstAttempt.continuationUnknown, true);

  setActiveLanguage('en');
  const firstFormattedEn = formatTransactionHistoryMessage(firstAttempt);
  assert.match(firstFormattedEn, /more matching transactions may still exist/i);
  assert.match(firstFormattedEn, /retry the same search/i);

  setActiveLanguage('id');
  const firstFormattedId = formatTransactionHistoryMessage(firstAttempt);
  assert.match(firstFormattedId, /transaksi yang cocok mungkin masih ada/i);
  assert.match(firstFormattedId, /ulangi pencarian yang sama/i);

  const retry = await client.fetchRecords({ searchQuery: 'target merchant', limit: 10, page: 1 });
  assert.strictEqual(capturedOffsets.length, MAX_TRANSACTION_SEARCH_SCAN_CALLS_PER_REQUEST + 1);
  assert.strictEqual(retry.records.length, 10);
  assert.strictEqual(retry.hasMore, true);
  assert.strictEqual(retry.nextOffset, 10);
  assert.strictEqual(retry.continuationUnknown, false);

  setActiveLanguage('en');
  const retryFormatted = formatTransactionHistoryMessage(retry);
  assert.match(retryFormatted, /next page/i);
  assert.doesNotMatch(retryFormatted, /more matching transactions may still exist/i);
});

console.log('[SUCCESS] PR #114 transaction search review regression tests passed.');
