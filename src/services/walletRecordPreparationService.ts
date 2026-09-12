import { CreateRecordInputPayload } from '../types/walletTypes.js';
import { WalletCacheService } from './walletCacheService.js';
import { WalletMcpClientService } from './walletMcpService.js';
import { resolveAndEnsureLabels } from './walletLabelResolver.js';

/**
 * Resolves labels and populates labelIds and canonical label names for an array of records
 * before dispatching them to the Wallet MCP service.
 */
export async function prepareRecordsForWalletDispatch(
  records: CreateRecordInputPayload[],
  walletCacheService: WalletCacheService,
  walletMcpClient: WalletMcpClientService
): Promise<CreateRecordInputPayload[]> {
  for (const record of records) {
    if (record.labels && record.labels.length > 0) {
      const { resolvedLabelIds, resolvedLabelNames } = await resolveAndEnsureLabels(
        record.labels,
        walletCacheService,
        walletMcpClient
      );
      record.labelIds = resolvedLabelIds.length > 0 ? resolvedLabelIds : undefined;
      record.labels = resolvedLabelNames.length > 0 ? resolvedLabelNames : undefined;
    }
  }
  return records;
}

/**
 * Service that encapsulates record preparation dependencies (WalletCacheService and WalletMcpClientService)
 * to prepare financial records consistently before MCP dispatch.
 */
export class WalletRecordPreparationService {
  constructor(
    private readonly walletCacheService: WalletCacheService,
    private readonly walletMcpClient: WalletMcpClientService
  ) {}

  public async prepareRecordsForDispatch(
    records: CreateRecordInputPayload[]
  ): Promise<CreateRecordInputPayload[]> {
    return prepareRecordsForWalletDispatch(
      records,
      this.walletCacheService,
      this.walletMcpClient
    );
  }
}
