import { WALLET_MCP_TOOL_NAMES } from './constants.js';
import type {
  CreateRecordInputPayload,
  WalletCreateRecordsResponse,
} from './types.js';
import { WalletMcpRequestError } from './errors.js';
import { validateCreateRecordsResponse } from './recordValidation.js';
import {
  resolveAndEnsureLabels,
  type LabelResolverCache,
  type LabelCreatorClient,
} from './labelResolver.js';
import { normalizeTransactionRecordDate } from './recordDateNormalizer.js';
import { applicationLogger } from '../lib/logger.js';

export interface RecordsClient extends LabelCreatorClient {
  callMcpTool<T>(toolName: string, args?: Record<string, unknown>): Promise<T>;
}

export interface RecordsCache extends LabelResolverCache {}

export function normalizeRecordDate(recordDateString?: string): string {
  return normalizeTransactionRecordDate(recordDateString);
}

export function sanitizeRecordPayload(
  recordsPayload: CreateRecordInputPayload[]
): Record<string, unknown>[] {
  return recordsPayload.map(recordItem => {
    const sanitizedRecordItem: Record<string, unknown> = {
      accountId: recordItem.accountId,
      amount: recordItem.amount,
      recordDate: normalizeRecordDate(recordItem.recordDate),
    };

    if (recordItem.categoryId) {
      sanitizedRecordItem.categoryId = recordItem.categoryId;
    }
    if (recordItem.note) {
      sanitizedRecordItem.note = recordItem.note;
    }
    if (recordItem.counterParty) {
      sanitizedRecordItem.counterParty = recordItem.counterParty;
    }
    if (Array.isArray(recordItem.labelIds) && recordItem.labelIds.length > 0) {
      sanitizedRecordItem.labelIds = recordItem.labelIds;
    }
    if (recordItem.transfer) {
      const transfer: Record<string, unknown> = {
        pairingMode: recordItem.transfer.pairingMode,
      };
      if (recordItem.transfer.accountId) {
        transfer.accountId = recordItem.transfer.accountId;
      }
      if (recordItem.transfer.recordId) {
        transfer.recordId = recordItem.transfer.recordId;
      }
      if (recordItem.transfer.counterAmount) {
        transfer.counterAmount = recordItem.transfer.counterAmount;
      }
      sanitizedRecordItem.transfer = transfer;
    }

    return sanitizedRecordItem;
  });
}

export async function prepareRecordsForWalletDispatch(
  records: CreateRecordInputPayload[],
  cache: RecordsCache,
  client: LabelCreatorClient
): Promise<CreateRecordInputPayload[]> {
  for (const record of records) {
    if (record.labels && record.labels.length > 0) {
      const { resolvedLabelIds, resolvedLabelNames } = await resolveAndEnsureLabels(
        record.labels,
        cache,
        client
      );
      record.labelIds = resolvedLabelIds.length > 0 ? resolvedLabelIds : undefined;
      record.labels = resolvedLabelNames.length > 0 ? resolvedLabelNames : undefined;
    }
  }
  return records;
}

export async function createRecords(
  client: RecordsClient,
  recordsPayload: CreateRecordInputPayload[]
): Promise<WalletCreateRecordsResponse> {
  const sanitizedRecordPayloadList = sanitizeRecordPayload(recordsPayload);

  applicationLogger.fileDetail('mcp', `Prepared ${sanitizedRecordPayloadList.length} Record(s) for MCP Dispatch`, {
    originalRecords: recordsPayload,
    sanitizedRecords: sanitizedRecordPayloadList,
  });

  let createRecordsResult: unknown;
  try {
    createRecordsResult = await client.callMcpTool<unknown>(WALLET_MCP_TOOL_NAMES.CREATE_RECORDS, {
      records: sanitizedRecordPayloadList,
    });
  } catch (error) {
    if (error instanceof WalletMcpRequestError) {
      throw error;
    }

    throw new WalletMcpRequestError(
      `[error] MCP Tool 'create_records' returned an unclassified result-processing failure`,
      'UNKNOWN'
    );
  }

  return validateCreateRecordsResponse(createRecordsResult, sanitizedRecordPayloadList.length);
}

/**
 * Prepares and enriches transaction record payloads prior to Wallet MCP dispatch,
 * resolving accounts, categories, and tags/labels with automatic label provisioning.
 */
export class WalletRecordPreparationService {
  constructor(
    private readonly cache: RecordsCache,
    private readonly client: LabelCreatorClient
  ) {}

  public prepareRecordsForDispatch(
    records: CreateRecordInputPayload[]
  ): Promise<CreateRecordInputPayload[]> {
    return prepareRecordsForWalletDispatch(records, this.cache, this.client);
  }
}

export * from './recordValidation.js';
export * from './labelResolver.js';
