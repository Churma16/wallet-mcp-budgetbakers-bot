import assert from 'node:assert';
import test from 'node:test';
import { WalletMcpClientService } from '../src/services/walletMcpService.js';
import { detectFastPathAction } from '../src/utils/fastPathIntentDetector.js';

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

test('local page filtering preserves upstream pagination and later matches remain reachable', async () => {
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
  };

  const firstPage = await client.fetchRecords({ searchQuery: 'target merchant', limit: 10, page: 1 });
  assert.strictEqual(firstPage.records.length, 2);
  assert.strictEqual(firstPage.total, 30);
  assert.strictEqual(firstPage.totalPages, 3);
  assert.strictEqual(firstPage.hasMore, true);
  assert.strictEqual(firstPage.nextOffset, 10);

  const secondPage = await client.fetchRecords({ searchQuery: 'target merchant', limit: 10, page: 2 });
  assert.deepStrictEqual(capturedOffsets, [0, 10]);
  assert.strictEqual(secondPage.page, 2);
  assert.strictEqual(secondPage.records.length, 1);
  assert.strictEqual(secondPage.records[0].id, 'page-2-0');
  assert.strictEqual(secondPage.total, 30);
  assert.strictEqual(secondPage.totalPages, 3);
  assert.strictEqual(secondPage.hasMore, true);
  assert.strictEqual(secondPage.nextOffset, 20);
});

console.log('[SUCCESS] PR #114 transaction search review regression tests passed.');
