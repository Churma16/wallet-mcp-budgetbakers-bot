import type {
  WalletCreateRecordsResponse,
  WalletMcpDispatchOutcome,
} from '../types.js';
import { WalletMcpRequestError } from '../mcp/errors.js';

export function validateCreateRecordsResponse(
  createRecordsResult: unknown,
  expectedRecordCount: number
): WalletCreateRecordsResponse {
  if (!createRecordsResult || typeof createRecordsResult !== 'object' || Array.isArray(createRecordsResult)) {
    throw new WalletMcpRequestError(
      `[error] MCP Tool 'create_records' returned an unverifiable response`,
      'UNKNOWN'
    );
  }

  const typedResult = createRecordsResult as WalletCreateRecordsResponse;
  const summary = typedResult.summary;
  const results = typedResult.results;
  const hasSummary = summary !== undefined;
  const hasResults = Array.isArray(results);

  if (!hasSummary && !hasResults) {
    throw new WalletMcpRequestError(
      `[error] MCP Tool 'create_records' returned no recognized success evidence`,
      'UNKNOWN'
    );
  }

  let summaryResolvedErrors: number | undefined;

  if (hasSummary) {
    const totalValid =
      typeof summary?.total === 'number' && Number.isInteger(summary.total) && summary.total >= 0;
    const succeededValid =
      typeof summary?.succeeded === 'number' && Number.isInteger(summary.succeeded) && summary.succeeded >= 0;

    const expectedSummaryTotal = hasResults ? results.length : expectedRecordCount;
    if (!totalValid || !succeededValid || summary?.total !== expectedSummaryTotal) {
      throw new WalletMcpRequestError(
        `[error] MCP Tool 'create_records' returned an invalid or mismatched summary`,
        'UNKNOWN'
      );
    }

    const optionalFields = [
      summary?.failed,
      summary?.clientErrors,
      summary?.serverErrors,
      summary?.documentsWritten,
    ];
    for (const field of optionalFields) {
      if (field !== undefined && (typeof field !== 'number' || !Number.isInteger(field) || field < 0)) {
        throw new WalletMcpRequestError(
          `[error] MCP Tool 'create_records' returned an invalid or mismatched summary`,
          'UNKNOWN'
        );
      }
    }

    const hasClientErrors = summary?.clientErrors !== undefined;
    const hasServerErrors = summary?.serverErrors !== undefined;
    const hasFailed = summary?.failed !== undefined;

    if (hasClientErrors !== hasServerErrors) {
      throw new WalletMcpRequestError(
        `[error] MCP Tool 'create_records' returned an invalid or mismatched summary`,
        'UNKNOWN'
      );
    }

    if (hasClientErrors && hasServerErrors) {
      summaryResolvedErrors = (summary?.clientErrors ?? 0) + (summary?.serverErrors ?? 0);
      if (hasFailed && summary?.failed !== summaryResolvedErrors) {
        throw new WalletMcpRequestError(
          `[error] MCP Tool 'create_records' returned an invalid or mismatched summary`,
          'UNKNOWN'
        );
      }
    } else if (hasFailed) {
      summaryResolvedErrors = summary?.failed;
    }

    if (summaryResolvedErrors !== undefined) {
      if ((summary?.succeeded ?? 0) + summaryResolvedErrors !== expectedRecordCount) {
        throw new WalletMcpRequestError(
          `[error] MCP Tool 'create_records' returned an invalid or mismatched summary`,
          'UNKNOWN'
        );
      }
    }

    if (
      summary?.documentsWritten !== undefined &&
      summary.documentsWritten < summary.succeeded
    ) {
      throw new WalletMcpRequestError(
        `[error] MCP Tool 'create_records' returned an invalid or mismatched summary`,
        'UNKNOWN'
      );
    }
    if (
      summary?.documentsWritten !== undefined &&
      summary.documentsWritten > summary.succeeded &&
      !hasResults
    ) {
      throw new WalletMcpRequestError(
        `[error] MCP Tool 'create_records' returned unexplained document-write evidence`,
        'UNKNOWN'
      );
    }
  }

  let resultSuccessCount = 0;
  let resultFailureCount = 0;
  let rootResults: NonNullable<WalletCreateRecordsResponse['results']> = [];
  let mirrorResults: NonNullable<WalletCreateRecordsResponse['results']> = [];

  if (hasResults) {
    if (results.length < expectedRecordCount) {
      throw new WalletMcpRequestError(
        `[error] MCP Tool 'create_records' returned an unexpected number of per-record results`,
        'UNKNOWN'
      );
    }

    const invalidResultShape = results.some(result => !result || typeof result.success !== 'boolean');
    if (invalidResultShape) {
      throw new WalletMcpRequestError(
        `[error] MCP Tool 'create_records' returned invalid per-record results`,
        'UNKNOWN'
      );
    }

    const rootResultsByInputIndex = new Map<number, (typeof results)[number]>();
    for (const result of results) {
      if (
        !Number.isInteger(result.inputIndex) ||
        (result.inputIndex as number) < 0 ||
        (result.inputIndex as number) >= expectedRecordCount
      ) {
        throw new WalletMcpRequestError(
          `[error] MCP Tool 'create_records' returned uncorrelated per-record results`,
          'UNKNOWN'
        );
      }
      const isMirrorResult = result.isMirror === true || result.resultType === 'mirror';
      if (isMirrorResult) {
        mirrorResults.push(result);
        continue;
      }
      if (rootResultsByInputIndex.has(result.inputIndex as number)) {
        throw new WalletMcpRequestError(
          `[error] MCP Tool 'create_records' returned duplicate root results`,
          'UNKNOWN'
        );
      }
      rootResultsByInputIndex.set(result.inputIndex as number, result);
    }

    if (rootResultsByInputIndex.size !== expectedRecordCount) {
      throw new WalletMcpRequestError(
        `[error] MCP Tool 'create_records' returned missing root results`,
        'UNKNOWN'
      );
    }

    rootResults = [...rootResultsByInputIndex.values()];
    const mirrorInputIndexes = new Set<number>();
    for (const mirrorResult of mirrorResults) {
      if (mirrorInputIndexes.has(mirrorResult.inputIndex as number)) {
        throw new WalletMcpRequestError(
          `[error] MCP Tool 'create_records' returned duplicate mirror results`,
          'UNKNOWN'
        );
      }
      mirrorInputIndexes.add(mirrorResult.inputIndex as number);
      const rootResult = rootResultsByInputIndex.get(mirrorResult.inputIndex as number)!;
      const mirrorIdMatches =
        typeof mirrorResult.id === 'string' &&
        rootResult.createdMirrorRecordId === mirrorResult.id;
      const rootIdMatches =
        typeof mirrorResult.mirrorOfRecordId === 'string' &&
        rootResult.id === mirrorResult.mirrorOfRecordId;
      if (!mirrorIdMatches && !rootIdMatches) {
        throw new WalletMcpRequestError(
          `[error] MCP Tool 'create_records' returned an uncorrelated mirror result`,
          'UNKNOWN'
        );
      }
      if (mirrorResult.success !== true || rootResult.success !== true) {
        throw new WalletMcpRequestError(
          `[error] MCP Tool 'create_records' returned contradictory mirror evidence`,
          'UNKNOWN'
        );
      }
    }

    resultSuccessCount = rootResults.filter(result => result.success === true).length;
    resultFailureCount = rootResults.length - resultSuccessCount;
  }

  if (hasSummary && hasResults) {
    if (summary?.succeeded !== resultSuccessCount) {
      throw new WalletMcpRequestError(
        `[error] MCP Tool 'create_records' returned inconsistent summary and per-record results`,
        'UNKNOWN'
      );
    }

    const confirmedSecondaryDocumentIds = new Set<string>();
    for (const result of rootResults) {
      if (result.success === true && typeof result.createdMirrorRecordId === 'string') {
        confirmedSecondaryDocumentIds.add(result.createdMirrorRecordId);
      }
    }
    for (const result of mirrorResults) {
      if (result.success === true && typeof result.id === 'string') {
        confirmedSecondaryDocumentIds.add(result.id);
      }
    }
    const confirmedExistingWrites = rootResults.filter(result =>
      result.success === true && result.pairingMode === 'existing'
    ).length;
    const minimumDocumentsWritten = summary?.succeeded ?? 0;
    const maximumExplainedDocumentsWritten =
      minimumDocumentsWritten + confirmedSecondaryDocumentIds.size + confirmedExistingWrites;
    if (
      summary?.documentsWritten !== undefined &&
      (summary.documentsWritten < minimumDocumentsWritten ||
        summary.documentsWritten > maximumExplainedDocumentsWritten)
    ) {
      throw new WalletMcpRequestError(
        `[error] MCP Tool 'create_records' returned unexplained document-write evidence`,
        'UNKNOWN'
      );
    }
  }

  const totalFailureCount = summaryResolvedErrors !== undefined
    ? summaryResolvedErrors
    : resultFailureCount;

  if (totalFailureCount > 0 || (hasResults && resultFailureCount > 0)) {
    const failureCount = Math.max(totalFailureCount, resultFailureCount);
    const firstFailureItem = hasResults
      ? rootResults.find(result => result.success === false)
      : undefined;
    const firstFailureDetail = firstFailureItem?.error;

    const hasServerErrors = (summary?.serverErrors !== undefined && summary.serverErrors > 0) ||
      (hasResults && rootResults.some(r => r.success === false && r.errorType === 'server_error'));

    const hasPartialSuccess = (summary?.succeeded !== undefined && summary.succeeded > 0) ||
      (hasResults && resultSuccessCount > 0);

    const dispatchOutcome: WalletMcpDispatchOutcome = (hasServerErrors || hasPartialSuccess)
      ? 'UNKNOWN'
      : 'DEFINITIVE_FAILURE';

    throw new WalletMcpRequestError(
      `[error] MCP Tool 'create_records' rejected ${failureCount} record(s)` +
        (firstFailureDetail ? `: ${firstFailureDetail}` : ''),
      dispatchOutcome
    );
  }

  const summaryConfirmsFullSuccess = Boolean(
    hasSummary &&
    summary?.succeeded === expectedRecordCount &&
    (summaryResolvedErrors === 0 || (summaryResolvedErrors === undefined && summary?.documentsWritten === expectedRecordCount))
  );
  const resultsConfirmFullSuccess = Boolean(
    hasResults &&
    resultSuccessCount === expectedRecordCount &&
    resultFailureCount === 0
  );

  if (!summaryConfirmsFullSuccess && !resultsConfirmFullSuccess) {
    throw new WalletMcpRequestError(
      `[error] MCP Tool 'create_records' did not provide positive evidence for all ${expectedRecordCount} submitted record(s)`,
      'UNKNOWN'
    );
  }

  return typedResult;
}
