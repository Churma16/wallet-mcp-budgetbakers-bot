import { WALLET_MCP_TOOL_NAMES } from './constants.js';
import type {
  WalletRecordAggregationQueryPayload,
  WalletRecordAggregationResponse,
  WalletRecordAggregationResultItem,
} from './types.js';
import { WalletMcpRequestError } from './errors.js';
import { applicationLogger } from '../utils/logger.js';

export interface AggregationInvoker {
  callMcpTool<T>(toolName: string, args?: Record<string, unknown>): Promise<T>;
}

export function validateRecordAggregationResponse(
  rawResponse: unknown,
  queryPayload: WalletRecordAggregationQueryPayload
): WalletRecordAggregationResponse {
  if (!rawResponse || typeof rawResponse !== 'object' || Array.isArray(rawResponse)) {
    throw new WalletMcpRequestError(
      `[error] MCP Tool 'get_records_aggregation' returned an unverifiable non-object response`,
      'UNKNOWN'
    );
  }

  const rawRecord = rawResponse as Record<string, unknown>;
  const rawResults = rawRecord.results;
  if (!Array.isArray(rawResults)) {
    throw new WalletMcpRequestError(
      `[error] MCP Tool 'get_records_aggregation' response is missing a valid results array`,
      'UNKNOWN'
    );
  }

  const expectCurrency = queryPayload.groupBy?.includes('currency') ?? false;
  const expectRecordType = queryPayload.groupBy?.includes('recordType') ?? false;
  const expectAmountSum = queryPayload.compute?.includes('amount:sum') ?? false;

  const validatedResults: WalletRecordAggregationResultItem[] = [];

  for (let rowIndex = 0; rowIndex < rawResults.length; rowIndex += 1) {
    const row = rawResults[rowIndex];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new WalletMcpRequestError(
        `[error] MCP Tool 'get_records_aggregation' returned malformed row at index ${rowIndex}`,
        'UNKNOWN'
      );
    }

    const rowObj = row as Record<string, unknown>;
    const rawCount = rowObj.count;
    if (typeof rawCount !== 'number' || !Number.isFinite(rawCount) || rawCount < 0) {
      throw new WalletMcpRequestError(
        `[error] MCP Tool 'get_records_aggregation' row at index ${rowIndex} has invalid count: ${String(rawCount)}`,
        'UNKNOWN'
      );
    }

    if (rawCount === 0 && rawResults.length === 1 && !rowObj.currency && !rowObj.recordType) {
      validatedResults.push({ count: 0 });
      break;
    }

    if (expectCurrency && (typeof rowObj.currency !== 'string' || rowObj.currency.trim().length === 0)) {
      throw new WalletMcpRequestError(
        `[error] MCP Tool 'get_records_aggregation' row at index ${rowIndex} is missing required currency`,
        'UNKNOWN'
      );
    }

    if (expectRecordType && rowObj.recordType !== 'expense' && rowObj.recordType !== 'income') {
      throw new WalletMcpRequestError(
        `[error] MCP Tool 'get_records_aggregation' row at index ${rowIndex} is missing or has invalid recordType: ${String(rowObj.recordType)}`,
        'UNKNOWN'
      );
    }

    if (expectAmountSum) {
      const amountSum = rowObj['amount:sum'];
      if (typeof amountSum !== 'number' || !Number.isFinite(amountSum)) {
        throw new WalletMcpRequestError(
          `[error] MCP Tool 'get_records_aggregation' row at index ${rowIndex} has non-numeric 'amount:sum': ${String(amountSum)}`,
          'UNKNOWN'
        );
      }
    }

    validatedResults.push(row as WalletRecordAggregationResultItem);
  }

  return {
    results: validatedResults,
    limit: typeof rawRecord.limit === 'number' && Number.isFinite(rawRecord.limit) ? rawRecord.limit : 1000,
    offset: typeof rawRecord.offset === 'number' && Number.isFinite(rawRecord.offset) ? rawRecord.offset : 0,
    isTransfer: typeof rawRecord.isTransfer === 'boolean' || rawRecord.isTransfer === null ? rawRecord.isTransfer : undefined,
    baseCurrency: typeof rawRecord.baseCurrency === 'string' ? rawRecord.baseCurrency : undefined,
    agentHints: Array.isArray(rawRecord.agentHints) ? rawRecord.agentHints as any : undefined,
    _meta: typeof rawRecord._meta === 'object' && rawRecord._meta !== null ? rawRecord._meta as any : undefined,
  };
}

export async function fetchRecordsAggregation(
  client: AggregationInvoker,
  queryPayload: WalletRecordAggregationQueryPayload
): Promise<WalletRecordAggregationResponse> {
  applicationLogger.fileDetail('mcp', 'Dispatching fetchRecordsAggregation to Wallet MCP', {
    groupBy: queryPayload.groupBy,
    compute: queryPayload.compute,
    isTransfer: queryPayload.isTransfer,
  });

  const rawResponse = await client.callMcpTool<unknown>(
    WALLET_MCP_TOOL_NAMES.GET_RECORDS_AGGREGATION,
    queryPayload as Record<string, unknown>
  );

  return validateRecordAggregationResponse(rawResponse, queryPayload);
}
