import { describe, expect, it, vi } from 'vitest';
import { WalletMcpClientService } from '../src/services/walletMcpService.js';
import { validateAndSanitizeFinancialRecords } from '../src/utils/recordValidator.js';
import type { WalletAccountItem, WalletCategoryItem } from '../src/types/walletTypes.js';

const accounts: WalletAccountItem[] = [
  { id: 'acc-jago', name: 'Jago Expense', currency: 'IDR' },
  { id: 'acc-gopay', name: 'GoPay', currency: 'IDR' },
];

describe('native paired transfers (issue #143)', () => {
  it('normalizes current category hierarchy and writable-state metadata', async () => {
    const client = new WalletMcpClientService('https://example.invalid', 'test-token');
    vi.spyOn(client, 'callMcpTool').mockResolvedValue({
      categories: [
        {
          id: 'cat-food',
          name: 'Food',
          group: { id: 'food_and_drinks', name: 'Food and drinks' },
          systemId: 'food_and_drinks__groceries',
          cardinality: 'need',
          customCategory: false,
          archived: false,
          enabled: true,
        },
        {
          id: 'cat-transfer',
          name: 'Transfer',
          group: { id: 'system_categories', name: 'System categories' },
          systemId: 'transfer',
          customCategory: false,
          archived: false,
          enabled: true,
        },
      ],
    });

    const categories = await client.fetchCategories(true);
    expect(categories[0]).toMatchObject({
      group: { id: 'food_and_drinks', name: 'Food and drinks' },
      systemId: 'food_and_drinks__groceries',
      cardinality: 'need',
      customCategory: false,
      enabled: true,
      archived: false,
      isAssignable: true,
    });
    expect(categories[1].isAssignable).toBe(false);
  });

  it('resolves both accounts and keeps a transfer as one category-free native input', () => {
    const result = validateAndSanitizeFinancialRecords(
      [{
        accountHint: 'jago expense',
        amount: -20_000,
        note: 'Transfer jago expense ke gopay 20k',
        transfer: { pairingMode: 'new', accountHint: 'gopay' },
      }],
      accounts,
      [],
      'Transfer jago expense ke gopay 20k',
      new Date('2026-09-14T12:00:00Z')
    );

    expect(result.isValid).toBe(true);
    expect(result.sanitizedRecords).toHaveLength(1);
    expect(result.sanitizedRecords[0]).toMatchObject({
      accountId: 'acc-jago',
      amount: -20_000,
      transfer: { pairingMode: 'new', accountId: 'acc-gopay' },
    });
    expect(result.sanitizedRecords[0].categoryId).toBeUndefined();
  });

  it('rejects a positive source-side amount from malformed model output', () => {
    const result = validateAndSanitizeFinancialRecords(
      [{
        accountHint: 'jago expense',
        amount: 20_000,
        transfer: { pairingMode: 'new', accountHint: 'gopay' },
      }],
      accounts,
      [],
      undefined,
      new Date('2026-09-14T12:00:00Z')
    );

    expect(result.isValid).toBe(false);
    expect(result.validationErrors).toContain(
      'Transaksi #1: Nominal sumber transfer harus bernilai negatif.'
    );
  });

  it('rejects non-assignable category metadata before ordinary dispatch', () => {
    const categories: WalletCategoryItem[] = [{
      id: 'transfer-category',
      name: 'Transfer',
      group: { id: 'system_categories', name: 'System categories' },
      isAssignable: false,
    }];
    const result = validateAndSanitizeFinancialRecords(
      [{ accountHint: 'gopay', categoryHint: 'Transfer', amount: -20_000 }],
      accounts,
      categories,
      undefined,
      new Date('2026-09-14T12:00:00Z')
    );

    expect(result.isValid).toBe(false);
    expect(result.validationErrors).toContain(
      'Transaksi #1: Kategori yang dipilih tidak dapat digunakan untuk transaksi biasa.'
    );
  });

  it('dispatches the verified MCP transfer shape and accepts explained mirror writes', async () => {
    const client = new WalletMcpClientService('https://example.invalid', 'test-token');
    const post = vi.fn().mockResolvedValue({
      data: {
        result: {
          structuredContent: {
            summary: { total: 1, succeeded: 1, clientErrors: 0, serverErrors: 0, documentsWritten: 2 },
            results: [{
              inputIndex: 0,
              id: 'root-record',
              success: true,
              pairingMode: 'new',
              createdMirrorRecordId: 'mirror-record',
            }],
            agentHints: [{ type: 'transfer.fx_derived', severity: 'info' }],
          },
        },
      },
    });
    (client as any).httpClient.post = post;

    const response = await client.createRecords([{
      accountId: 'acc-jago',
      amount: -20_000,
      recordDate: '2026-09-14T12:00:00Z',
      transfer: { pairingMode: 'new', accountId: 'acc-gopay' },
    }]);

    const sentRecord = post.mock.calls[0][1].params.arguments.records[0];
    expect(sentRecord).toMatchObject({
      accountId: 'acc-jago',
      amount: -20_000,
      transfer: { pairingMode: 'new', accountId: 'acc-gopay' },
    });
    expect(sentRecord.categoryId).toBeUndefined();
    expect(response.results?.[0].createdMirrorRecordId).toBe('mirror-record');
    expect(response.agentHints?.[0].type).toBe('transfer.fx_derived');
  });

  it('fails closed on duplicate or out-of-range input correlation', () => {
    const client = new WalletMcpClientService('https://example.invalid', 'test-token');
    expect(() => client.validateCreateRecordsResponse({
      summary: { total: 2, succeeded: 2, clientErrors: 0, serverErrors: 0, documentsWritten: 2 },
      results: [
        { inputIndex: 0, id: 'one', success: true },
        { inputIndex: 0, id: 'two', success: true },
      ],
    }, 2)).toThrow(expect.objectContaining({
      dispatchOutcome: 'UNKNOWN',
      message: expect.stringContaining('duplicate root'),
    }));
  });

  it('accepts an explicitly correlated root plus mirror result', () => {
    const client = new WalletMcpClientService('https://example.invalid', 'test-token');
    const response = client.validateCreateRecordsResponse({
      summary: { total: 1, succeeded: 1, clientErrors: 0, serverErrors: 0, documentsWritten: 2 },
      results: [
        {
          inputIndex: 0,
          id: 'root-1',
          success: true,
          pairingMode: 'new',
          createdMirrorRecordId: 'mirror-1',
        },
        {
          inputIndex: 0,
          id: 'mirror-1',
          success: true,
          isMirror: true,
          mirrorOfRecordId: 'root-1',
        },
      ],
    }, 1);

    expect(response.results).toHaveLength(2);
  });

  it('accepts multiple paired transfers and a mixed ordinary-transfer batch', () => {
    const client = new WalletMcpClientService('https://example.invalid', 'test-token');
    const multipleTransfers = client.validateCreateRecordsResponse({
      summary: { total: 2, succeeded: 2, clientErrors: 0, serverErrors: 0, documentsWritten: 4 },
      results: [
        { inputIndex: 0, id: 'root-1', success: true, pairingMode: 'new', createdMirrorRecordId: 'mirror-1' },
        { inputIndex: 0, id: 'mirror-1', success: true, resultType: 'mirror', mirrorOfRecordId: 'root-1' },
        { inputIndex: 1, id: 'root-2', success: true, pairingMode: 'new', createdMirrorRecordId: 'mirror-2' },
        { inputIndex: 1, id: 'mirror-2', success: true, resultType: 'mirror', mirrorOfRecordId: 'root-2' },
      ],
    }, 2);
    expect(multipleTransfers.summary?.documentsWritten).toBe(4);

    const mixed = client.validateCreateRecordsResponse({
      summary: { total: 2, succeeded: 2, clientErrors: 0, serverErrors: 0, documentsWritten: 3 },
      results: [
        { inputIndex: 0, id: 'ordinary', success: true },
        { inputIndex: 1, id: 'root', success: true, pairingMode: 'new', createdMirrorRecordId: 'mirror' },
        { inputIndex: 1, id: 'mirror', success: true, isMirror: true, mirrorOfRecordId: 'root' },
      ],
    }, 2);
    expect(mixed.summary?.succeeded).toBe(2);
  });

  it.each([
    {
      name: 'missing root',
      payload: {
        summary: { total: 1, succeeded: 1, clientErrors: 0, serverErrors: 0, documentsWritten: 1 },
        results: [{ inputIndex: 0, id: 'mirror', success: true, isMirror: true }],
      },
      message: 'missing root',
    },
    {
      name: 'uncorrelated mirror',
      payload: {
        summary: { total: 1, succeeded: 1, clientErrors: 0, serverErrors: 0, documentsWritten: 2 },
        results: [
          { inputIndex: 0, id: 'root', success: true },
          { inputIndex: 0, id: 'other', success: true, isMirror: true, mirrorOfRecordId: 'not-root' },
        ],
      },
      message: 'uncorrelated mirror',
    },
    {
      name: 'duplicate mirror',
      payload: {
        summary: { total: 1, succeeded: 1, clientErrors: 0, serverErrors: 0, documentsWritten: 2 },
        results: [
          { inputIndex: 0, id: 'root', success: true, createdMirrorRecordId: 'mirror' },
          { inputIndex: 0, id: 'mirror', success: true, isMirror: true },
          { inputIndex: 0, id: 'mirror', success: true, resultType: 'mirror' },
        ],
      },
      message: 'duplicate mirror',
    },
    {
      name: 'contradictory mirror',
      payload: {
        summary: { total: 1, succeeded: 1, clientErrors: 0, serverErrors: 0, documentsWritten: 2 },
        results: [
          { inputIndex: 0, id: 'root', success: true, createdMirrorRecordId: 'mirror' },
          { inputIndex: 0, id: 'mirror', success: false, isMirror: true },
        ],
      },
      message: 'contradictory mirror',
    },
  ])('fails closed on $name evidence', ({ payload, message }) => {
    const client = new WalletMcpClientService('https://example.invalid', 'test-token');
    expect(() => client.validateCreateRecordsResponse(payload, 1)).toThrow(
      expect.objectContaining({
        dispatchOutcome: 'UNKNOWN',
        message: expect.stringContaining(message),
      })
    );
  });
});
