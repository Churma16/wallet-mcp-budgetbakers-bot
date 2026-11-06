import type {
  CreateRecordInputPayload,
  WalletCreateRecordsResponse,
  PatchRecordInputPayload,
  WalletPatchRecordsResponse,
  WalletDeleteRecordsResponse,
  ClearableRecordField,
  WalletTransferInput,
} from '../types.js';
import {
  type WalletToolCaller,
  type SanitizedRecordPayloadItem,
  type SanitizedRecordTransferPayload,
  type SanitizedPatchRecordItem,
  callCreateRecords,
  callPatchRecords,
  callDeleteDocuments,
} from '../mcp/toolWrappers.js';
import { WalletMcpRequestError } from '../mcp/errors.js';
import {
  validateCreateRecordsResponse,
  validateDeleteRecordsResponse,
  validatePatchRecordsResponse,
} from './recordValidation.js';
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

export function sanitizeTransferPayload(
  transfer: WalletTransferInput
): SanitizedRecordTransferPayload {
  if (
    transfer.pairingMode === 'existing' &&
    (!transfer.recordId || typeof transfer.recordId !== 'string' || !transfer.recordId.trim())
  ) {
    throw new WalletMcpRequestError(
      '[error] Transfer pairingMode \'existing\' requires a valid target recordId',
      'DEFINITIVE_FAILURE'
    );
  }

  return {
    pairingMode: transfer.pairingMode,
    ...(transfer.accountId ? { accountId: transfer.accountId } : {}),
    ...(transfer.recordId ? { recordId: transfer.recordId.trim() } : {}),
    ...(transfer.counterAmount !== undefined
      ? { counterAmount: transfer.counterAmount }
      : {}),
  };
}

export function sanitizeRecordPayload(
  recordsPayload: CreateRecordInputPayload[]
): SanitizedRecordPayloadItem[] {
  return recordsPayload.map(recordItem => {
    let sanitizedTransfer: SanitizedRecordTransferPayload | undefined = undefined;

    if (recordItem.transfer) {
      sanitizedTransfer = sanitizeTransferPayload(recordItem.transfer);
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

export async function patchRecords(
  client: RecordsClient,
  patchPayloadList: PatchRecordInputPayload[]
): Promise<WalletPatchRecordsResponse> {
  const sanitizedPatchList: SanitizedPatchRecordItem[] = patchPayloadList.map(item => {
    const clearFields =
      Array.isArray(item.$clear) && item.$clear.length > 0
        ? Array.from(new Set(item.$clear))
        : undefined;

    const hasClear = (field: ClearableRecordField) => Boolean(clearFields?.includes(field));

    let sanitizedTransfer: SanitizedRecordTransferPayload | undefined = undefined;
    if (item.transfer && !hasClear('transfer')) {
      sanitizedTransfer = sanitizeTransferPayload(item.transfer);
    }

    return {
      id: item.id,
      ...(item.accountId ? { accountId: item.accountId } : {}),
      ...(item.amount !== undefined ? { amount: item.amount } : {}),
      ...(item.categoryId && !hasClear('categoryId') ? { categoryId: item.categoryId } : {}),
      ...(Array.isArray(item.labelIds) && item.labelIds.length > 0 && !hasClear('labelIds')
        ? { labelIds: item.labelIds }
        : {}),
      ...(item.note !== undefined && !hasClear('note') ? { note: item.note } : {}),
      ...(item.counterParty !== undefined && !hasClear('counterParty') ? { counterParty: item.counterParty } : {}),
      ...(item.recordDate ? { recordDate: normalizeRecordDate(item.recordDate) } : {}),
      ...(clearFields ? { $clear: clearFields } : {}),
      ...(sanitizedTransfer ? { transfer: sanitizedTransfer } : {}),
    };
  });

  applicationLogger.fileDetail('mcp', `Prepared ${sanitizedPatchList.length} Record(s) for MCP Patch Dispatch`, {
    originalPatches: patchPayloadList,
    sanitizedPatches: sanitizedPatchList,
  });

  let patchResult: unknown;
  try {
    patchResult = await callPatchRecords(client, {
      records: sanitizedPatchList,
    });
  } catch (error) {
    if (error instanceof WalletMcpRequestError) {
      throw error;
    }

    throw new WalletMcpRequestError(
      `[error] MCP Tool 'patch_records' returned an unclassified result-processing failure`,
      'UNKNOWN'
    );
  }

  return validatePatchRecordsResponse(patchResult, sanitizedPatchList.length);
}


/**
 * Deletes one or more transaction records in BudgetBakers Wallet cloud using the official delete_documents tool.
 * Handles referential validation, empty input guards, batch limits, and paired transfer atomic deletion.
 */
export async function deleteRecords(
  client: WalletToolCaller,
  recordIds: string | readonly string[] | string[]
): Promise<WalletDeleteRecordsResponse> {
  const rawList = Array.isArray(recordIds) ? recordIds : [recordIds];
  const sanitizedList = Array.from(
    new Set(
      rawList
        .map(id => (typeof id === 'string' ? id.trim() : ''))
        .filter(id => id.length > 0)
    )
  );

  if (sanitizedList.length === 0) {
    throw new WalletMcpRequestError(
      "[error] Referential validation error: No valid record IDs provided for deletion",
      'DEFINITIVE_FAILURE'
    );
  }

  if (sanitizedList.length > 20) {
    throw new WalletMcpRequestError(
      `[error] Referential validation error: Maximum 20 record IDs allowed per deletion request, received ${sanitizedList.length}`,
      'DEFINITIVE_FAILURE'
    );
  }

  applicationLogger.fileDetail('mcp', `Prepared ${sanitizedList.length} Record ID(s) for MCP Delete Dispatch`, {
    ids: sanitizedList,
  });

  const extractPartnerLegId = (errorText: string): string | null => {
    const uuidMatches = errorText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
    if (!uuidMatches) return null;
    const partnerId = uuidMatches.find(
      candidate => !sanitizedList.some(existing => existing.toLowerCase() === candidate.toLowerCase())
    );
    return partnerId ?? null;
  };

  let deleteResult: unknown;
  try {
    deleteResult = await callDeleteDocuments(client, {
      type: 'records',
      ids: sanitizedList,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const partnerId = extractPartnerLegId(errorMessage);

    if (partnerId && sanitizedList.length < 20) {
      applicationLogger.info(
        `[INFO] Detected paired transfer partner leg '${partnerId}' from upstream error, retrying atomic deletion...`
      );
      try {
        const retryResult = await callDeleteDocuments(client, {
          type: 'records',
          ids: [...sanitizedList, partnerId],
        });
        return validateDeleteRecordsResponse(retryResult, sanitizedList.length + 1);
      } catch (retryError) {
        if (retryError instanceof WalletMcpRequestError) {
          throw retryError;
        }
        throw new WalletMcpRequestError(
          `[error] MCP Tool 'delete_documents' failed during paired transfer atomic retry: ${
            retryError instanceof Error ? retryError.message : String(retryError)
          }`,
          'UNKNOWN'
        );
      }
    }

    if (error instanceof WalletMcpRequestError) {
      throw error;
    }

    throw new WalletMcpRequestError(
      `[error] MCP Tool 'delete_documents' returned an unclassified result-processing failure: ${errorMessage}`,
      'UNKNOWN'
    );
  }

  const rawResults =
    deleteResult &&
    typeof deleteResult === 'object' &&
    'results' in deleteResult &&
    Array.isArray((deleteResult as { results: unknown[] }).results)
      ? (deleteResult as { results: Array<{ success?: boolean; error?: string }> }).results
      : undefined;

  const failedItem = rawResults?.find(r => r.success === false && typeof r.error === 'string');
  const partnerId = failedItem?.error ? extractPartnerLegId(failedItem.error) : null;

  if (partnerId && sanitizedList.length < 20) {
    applicationLogger.info(
      `[INFO] Detected paired transfer partner leg '${partnerId}' from result error, retrying atomic deletion...`
    );
    try {
      const retryResult = await callDeleteDocuments(client, {
        type: 'records',
        ids: [...sanitizedList, partnerId],
      });
      return validateDeleteRecordsResponse(retryResult, sanitizedList.length + 1);
    } catch (retryError) {
      if (retryError instanceof WalletMcpRequestError) {
        throw retryError;
      }
      throw new WalletMcpRequestError(
        `[error] MCP Tool 'delete_documents' failed during paired transfer atomic retry: ${
          retryError instanceof Error ? retryError.message : String(retryError)
        }`,
        'UNKNOWN'
      );
    }
  }

  return validateDeleteRecordsResponse(deleteResult, sanitizedList.length);
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

  public async preparePatchRecordsForDispatch(
    patches: PatchRecordInputPayload[]
  ): Promise<PatchRecordInputPayload[]> {
    for (const patch of patches) {
      if (patch.$clear?.includes('labelIds')) {
        patch.labelIds = undefined;
        patch.labels = undefined;
        continue;
      }
      if (patch.labels && patch.labels.length > 0) {
        const { resolvedLabelIds, resolvedLabelNames } = await resolveAndEnsureLabels(
          patch.labels,
          this.cache,
          this.client
        );
        patch.labelIds = resolvedLabelIds.length > 0 ? resolvedLabelIds : undefined;
        patch.labels = resolvedLabelNames.length > 0 ? resolvedLabelNames : undefined;
      }
    }
    return patches;
  }
}

export * from './recordValidation.js';
export * from './labelResolver.js';

