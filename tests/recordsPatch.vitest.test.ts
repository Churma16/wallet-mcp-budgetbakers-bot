import { describe, it, expect, vi } from 'vitest';
import { patchRecords, WalletRecordPreparationService } from '../src/wallet/records/records.js';
import { WalletMcpRequestError } from '../src/wallet/mcp/errors.js';
import type { RecordsClient, RecordsCache, LabelCreatorClient } from '../src/wallet/records/records.js';

describe('wallet/records/records - patchRecords and preparePatchRecordsForDispatch', () => {
  it('successfully dispatches patchRecords and normalizes response', async () => {
    const mockClient = {
      callMcpTool: vi.fn(async () => ({
        summary: { total: 1, succeeded: 1 },
        results: [{ id: 'rec-1', success: true }],
      })),
      createLabel: vi.fn(),
    } as unknown as RecordsClient;

    const response = await patchRecords(mockClient, [
      {
        id: 'rec-1',
        amount: -25000,
        categoryId: 'cat-food',
        labelIds: ['lbl-1'],
        note: 'Coffee',
        counterParty: 'Starbucks',
      },
    ]);

    expect(response.summary.succeeded).toBe(1);
    expect(response.results?.[0]?.id).toBe('rec-1');
    expect(mockClient.callMcpTool).toHaveBeenCalledWith(
      'patch_records',
      {
        records: [
          {
            id: 'rec-1',
            amount: -25000,
            categoryId: 'cat-food',
            labelIds: ['lbl-1'],
            note: 'Coffee',
            counterParty: 'Starbucks',
          },
        ],
      }
    );
  });

  it('re-throws existing WalletMcpRequestError from tool wrapper', async () => {
    const mockClient = {
      callMcpTool: vi.fn(async () => {
        throw new WalletMcpRequestError('Scope unauthorized', 'TOOL_EXECUTION_FAILED');
      }),
      createLabel: vi.fn(),
    } as unknown as RecordsClient;

    await expect(patchRecords(mockClient, [{ id: 'rec-1' }])).rejects.toThrow(WalletMcpRequestError);
  });

  it('wraps unclassified error into WalletMcpRequestError with UNKNOWN code', async () => {
    const mockClient = {
      callMcpTool: vi.fn(async () => {
        throw new TypeError('Network socket destroyed unexpectedly');
      }),
      createLabel: vi.fn(),
    } as unknown as RecordsClient;

    await expect(patchRecords(mockClient, [{ id: 'rec-1' }])).rejects.toThrow(
      /unclassified result-processing failure/
    );
  });

  it('prepares and enriches patch record labels via WalletRecordPreparationService', async () => {
    const mockCache: RecordsCache = {
      getAccountByNameOrId: vi.fn(),
      getCategoryByNameOrId: vi.fn(),
      getCategories: vi.fn(() => []),
      findLabelByName: vi.fn((name: string) => {
        if (name === 'existing') return { id: 'lbl-existing', name: 'existing' };
        return undefined;
      }),
      isLabelsLoaded: vi.fn(() => true),
      addLabelToCache: vi.fn(),
    };

    const mockLabelCreator: LabelCreatorClient = {
      createLabel: vi.fn(async (name: string) => ({ id: `lbl-${name}`, name })),
    };

    const prepService = new WalletRecordPreparationService(mockCache, mockLabelCreator);

    const patches = await prepService.preparePatchRecordsForDispatch([
      {
        id: 'rec-1',
        labels: ['existing', 'new-label'],
      },
    ]);

    expect(patches[0].labelIds).toEqual(['lbl-existing', 'lbl-new-label']);
    expect(patches[0].labels).toEqual(['existing', 'new-label']);
  });
});
