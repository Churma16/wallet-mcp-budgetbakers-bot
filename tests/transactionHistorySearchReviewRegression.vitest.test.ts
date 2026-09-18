import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  WalletMcpClientService,
  MAX_TRANSACTION_SEARCH_SCAN_CALLS_PER_REQUEST,
} from '../src/services/walletMcpService.js';
import { detectFastPathAction } from '../src/utils/fastPathIntentDetector.js';
import { formatTransactionHistoryMessage } from '../src/utils/humanResponseFormatter.js';
import { setActiveLanguage } from '../src/i18n/index.js';

describe('PR #114 transaction search review regression tests', () => {
  beforeEach(() => {
    setActiveLanguage('id');
  });

  afterEach(() => {
    setActiveLanguage('id');
  });

  describe('intent detection and literal query preservation', () => {
    it('quoted search literals are not consumed as structured filters', () => {
      const quotedIncome = detectFastPathAction('search "income"');
      expect(typeof quotedIncome).toBe('object');
      expect((quotedIncome as any)?.options.searchQuery).toBe('income');
      expect((quotedIncome as any)?.options.recordType).toBeUndefined();

      const quotedToday = detectFastPathAction('search "today"');
      expect((quotedToday as any)?.options.searchQuery).toBe('today');
      expect((quotedToday as any)?.options.datePeriod).toBeUndefined();

      const quotedOldest = detectFastPathAction('cari "oldest"');
      expect((quotedOldest as any)?.options.searchQuery).toBe('oldest');
      expect((quotedOldest as any)?.options.sort).toBe('newest');

      const quotedNumber = detectFastPathAction('cari "5"');
      expect((quotedNumber as any)?.options.searchQuery).toBe('5');
      expect((quotedNumber as any)?.options.limit).toBeUndefined();
    });

    it('dedicated single-token search keeps filter-like words literal', () => {
      const literalIncome = detectFastPathAction('search income');
      expect((literalIncome as any)?.type).toBe('TRANSACTION_HISTORY');
      expect((literalIncome as any)?.options.searchQuery).toBe('income');
      expect((literalIncome as any)?.options.recordType).toBeUndefined();

      const literalToday = detectFastPathAction('search today');
      expect((literalToday as any)?.type).toBe('TRANSACTION_HISTORY');
      expect((literalToday as any)?.options.searchQuery).toBe('today');
      expect((literalToday as any)?.options.datePeriod).toBeUndefined();

      const literalAccount = detectFastPathAction('cari bca');
      expect((literalAccount as any)?.type).toBe('TRANSACTION_HISTORY');
      expect((literalAccount as any)?.options.searchQuery).toBe('bca');
      expect((literalAccount as any)?.options.accountName).toBeUndefined();

      const literalNumber = detectFastPathAction('search 5');
      expect((literalNumber as any)?.type).toBe('TRANSACTION_HISTORY');
      expect((literalNumber as any)?.options.searchQuery).toBe('5');
      expect((literalNumber as any)?.options.limit).toBeUndefined();
    });
  });

  describe('search scan pagination and lookahead execution', () => {
    it('incremental local search keeps records and pagination on the same semantics', async () => {
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
      expect(firstPage.records.length).toBe(2);
      expect(firstPage.total).toBeUndefined();
      expect(firstPage.totalPages).toBeUndefined();
      expect(firstPage.hasMore).toBe(true);
      expect(firstPage.nextOffset).toBe(2);
      expect(capturedOffsets).toEqual([0, 10]);

      const secondPage = await client.fetchRecords({ searchQuery: 'target merchant', limit: 2, page: 2 });
      expect(capturedOffsets).toEqual([0, 10, 20]);
      expect(secondPage.page).toBe(2);
      expect(secondPage.offset).toBe(2);
      expect(secondPage.records.length).toBe(1);
      expect(secondPage.records[0].id).toBe('page-2-0');
      expect(secondPage.total).toBe(3);
      expect(secondPage.totalPages).toBe(2);
      expect(secondPage.hasMore).toBe(false);
      expect(secondPage.nextOffset).toBeNull();
    });

    it('broad search stops after page lookahead and reuses cached candidates', async () => {
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
      expect(firstPage.records.length).toBe(5);
      expect(firstPage.records[0].id).toBe('broad-0');
      expect(firstPage.total).toBeUndefined();
      expect(firstPage.totalPages).toBeUndefined();
      expect(firstPage.hasMore).toBe(true);
      expect(capturedOffsets).toEqual([0, 5]);

      const callsAfterFirstPage = capturedOffsets.length;
      const secondPage = await client.fetchRecords({ searchQuery: 'target merchant', limit: 5, page: 2 });
      expect(secondPage.records.length).toBe(5);
      expect(secondPage.records[0].id).toBe('broad-5');
      expect(secondPage.hasMore).toBe(true);
      expect(capturedOffsets.length).toBe(callsAfterFirstPage);
      expect(capturedOffsets).toEqual([0, 5]);
    });

    it('sparse search stops at the per-request MCP scan budget and returns an actionable unresolved state', async () => {
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
      expect(capturedOffsets.length).toBe(MAX_TRANSACTION_SEARCH_SCAN_CALLS_PER_REQUEST);
      expect(capturedOffsets).toEqual([0, 10, 60, 110, 160]);
      expect(firstAttempt.records.length).toBe(0);
      expect(firstAttempt.total).toBeUndefined();
      expect(firstAttempt.totalPages).toBeUndefined();
      expect(firstAttempt.hasMore).toBe(false);
      expect(firstAttempt.nextOffset).toBeNull();
      expect(firstAttempt.unresolvedFilters?.length).toBe(1);
      expect(firstAttempt.unresolvedFilters?.[0].filterKey).toBe('searchQuery');
      expect(firstAttempt.unresolvedFilters?.[0].reason).toBe('UNRESOLVED');
      expect(firstAttempt.unresolvedFilters?.[0].message || '').toMatch(/scan budget/i);

      setActiveLanguage('en');
      const formattedEn = formatTransactionHistoryMessage(firstAttempt);
      expect(formattedEn).toMatch(/retry the same search/i);
      expect(formattedEn).toMatch(/account, category, or date filters/i);

      setActiveLanguage('id');
      const formattedId = formatTransactionHistoryMessage(firstAttempt);
      expect(formattedId).toMatch(/ulangi pencarian yang sama/i);
      expect(formattedId).toMatch(/filter akun, kategori, atau tanggal/i);

      const firstAttemptCallCount = capturedOffsets.length;
      const secondAttempt = await client.fetchRecords({ searchQuery: 'needle merchant', limit: 10, page: 1 });
      expect(capturedOffsets.length).toBe(firstAttemptCallCount + MAX_TRANSACTION_SEARCH_SCAN_CALLS_PER_REQUEST);
      expect(capturedOffsets[firstAttemptCallCount]).toBe(210);
      expect(secondAttempt.unresolvedFilters?.[0].reason).toBe('UNRESOLVED');
    });

    it('unknown lookahead stays resumable until the next match is verified', async () => {
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
      expect(capturedOffsets.length).toBe(MAX_TRANSACTION_SEARCH_SCAN_CALLS_PER_REQUEST);
      expect(firstAttempt.records.length).toBe(10);
      expect(firstAttempt.unresolvedFilters).toBeUndefined();
      expect(firstAttempt.total).toBeUndefined();
      expect(firstAttempt.totalPages).toBeUndefined();
      expect(firstAttempt.hasMore).toBe(false);
      expect(firstAttempt.nextOffset).toBeNull();
      expect(firstAttempt.continuationUnknown).toBe(true);

      setActiveLanguage('en');
      const firstFormattedEn = formatTransactionHistoryMessage(firstAttempt);
      expect(firstFormattedEn).toMatch(/more matching transactions may still exist/i);
      expect(firstFormattedEn).toMatch(/retry the same search/i);

      setActiveLanguage('id');
      const firstFormattedId = formatTransactionHistoryMessage(firstAttempt);
      expect(firstFormattedId).toMatch(/transaksi yang cocok mungkin masih ada/i);
      expect(firstFormattedId).toMatch(/ulangi pencarian yang sama/i);

      const retry = await client.fetchRecords({ searchQuery: 'target merchant', limit: 10, page: 1 });
      expect(capturedOffsets.length).toBe(MAX_TRANSACTION_SEARCH_SCAN_CALLS_PER_REQUEST + 1);
      expect(retry.records.length).toBe(10);
      expect(retry.hasMore).toBe(true);
      expect(retry.nextOffset).toBe(10);
      expect(retry.continuationUnknown).toBe(false);

      setActiveLanguage('en');
      const retryFormatted = formatTransactionHistoryMessage(retry);
      expect(retryFormatted).toMatch(/next page/i);
      expect(retryFormatted).not.toMatch(/more matching transactions may still exist/i);
    });
  });
});
