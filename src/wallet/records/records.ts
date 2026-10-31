import type {
  CreateRecordInputPayload,
  WalletCreateRecordsResponse,
} from '../types.js';
import {
  type WalletToolCaller,
  type SanitizedRecordPayloadItem,
  type SanitizedRecordTransferPayload,
  callCreateRecords,
} from '../mcp/toolWrappers.js';
import { WalletMcpRequestError } from '../mcp/errors.js';
import { validateCreateRecordsResponse } from './recordValidation.js';
import {
  resolveAndEnsureLabels,
  type LabelResolverCache,
  type LabelCreatorClient,
} from './labelResolver.js';
import { normalizeTransactionRecordDate } from './recordDateNormalizer.js';
import { applicationLogger } from '../../lib/logger.js';

export type RecordsClient = WalletToolCaller & LabelCreatorClient;

export interface RecordsCache extends LabelResolverCache {}

export function normalizeRecordDate(recordDateString?: string): string {
  return normalizeTransactionRecordDate(recordDateString);
}

export function sanitizeRecordPayload(
  recordsPayload: CreateRecordInputPayload[]
): SanitizedRecordPayloadItem[] {
  return recordsPayload.map(recordItem => {
    let sanitizedTransfer: SanitizedRecordTransferPayload | undefined = undefined;

    if (recordItem.transfer) {
      sanitizedTransfer = {
        pairingMode: recordItem.transfer.pairingMode,
        ...(recordItem.transfer.accountId ? { accountId: recordItem.transfer.accountId } : {}),
        ...(recordItem.transfer.recordId ? { recordId: recordItem.transfer.recordId } : {}),
        ...(recordItem.transfer.counterAmount !== undefined
          ? { counterAmount: recordItem.transfer.counterAmount }
          : {}),
      };
    }

    const sanitizedRecordItem: SanitizedRecordPayloadItem = {
      accountId: recordItem.accountId,
      amount: recordItem.amount,
      recordDate: normalizeRecordDate(recordItem.recordDate),
      ...(recordItem.categoryId ? { categoryId: recordItem.categoryId } : {}),
      ...(recordItem.note ? { note: recordItem.note } : {}),
      ...(recordItem.counterParty ? { counterParty: recordItem.counterParty } : {}),
      ...(Array.isArray(recordItem.labelIds) && recordItem.labelIds.length > 0
        ? { labelIds: recordItem.labelIds }
        : {}),
      ...(sanitizedTransfer ? { transfer: sanitizedTransfer } : {}),
    };

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
    createRecordsResult = await callCreateRecords(client, {
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

