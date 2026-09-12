import { applicationLogger } from '../../utils/logger.js';
import type { ExtractedFinancialIntent, ExtractedFinancialRecordItem } from './financialAiProvider.js';

/**
 * Extracts the content of the first triple-backtick code fence using linear index scanning
 * (avoids `[\s\S]`-style quantifier backtracking). Returns null when no closing fence exists.
 */
function extractMarkdownCodeFenceContent(rawText: string): string | null {
  const fenceMarker = '```';
  const fenceOpenIndex = rawText.indexOf(fenceMarker);
  if (fenceOpenIndex === -1) {
    return null;
  }

  const contentStartIndex = fenceOpenIndex + fenceMarker.length;
  const fenceCloseIndex = rawText.indexOf(fenceMarker, contentStartIndex);
  if (fenceCloseIndex === -1) {
    return null;
  }

  let extractedContent = rawText.slice(contentStartIndex, fenceCloseIndex).trim();
  const firstLineBreakIndex = extractedContent.indexOf('\n');
  const openingLabelLine = (firstLineBreakIndex === -1
    ? extractedContent
    : extractedContent.slice(0, firstLineBreakIndex)).trim();

  if (/^json$/i.test(openingLabelLine)) {
    extractedContent = firstLineBreakIndex === -1 ? '' : extractedContent.slice(firstLineBreakIndex).trim();
  }

  return extractedContent;
}

/**
 * Dedicated error class for AI response extraction and parsing failures.
 */
export class AiResponseParseError extends Error {
  constructor(
    message: string,
    public readonly rawResponseContent?: string
  ) {
    super(message);
    this.name = 'AiResponseParseError';
  }
}

/**
 * Checks whether an error is an AiResponseParseError.
 */
export function isAiResponseParseError(error: unknown): error is AiResponseParseError {
  return error instanceof AiResponseParseError || (
    error instanceof Error && error.name === 'AiResponseParseError'
  );
}

/**
 * Robustly extracts and parses a JSON object from arbitrary LLM response text.
 * Strips reasoning tokens (<think>...</think>), markdown code blocks, and extraneous chatter.
 */
export function extractAndParseJsonObject<T>(rawResponseText: string): T {
  let sanitizedText = rawResponseText.trim();

  // Strip DeepSeek / reasoning thoughts block if present: <think>...</think>
  sanitizedText = sanitizedText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // Check if enclosed inside markdown code block
  const extractedFenceContent = extractMarkdownCodeFenceContent(sanitizedText);
  if (extractedFenceContent !== null) {
    sanitizedText = extractedFenceContent;
  }

  // Fast path direct JSON parse
  try {
    return JSON.parse(sanitizedText) as T;
  } catch {
    // Fallback: extract the first contiguous JSON object matching { ... }
    const firstBraceIndex = sanitizedText.indexOf('{');
    const lastBraceIndex = sanitizedText.lastIndexOf('}');

    if (firstBraceIndex !== -1 && lastBraceIndex !== -1 && lastBraceIndex > firstBraceIndex) {
      const extractedJsonSubstring = sanitizedText.substring(firstBraceIndex, lastBraceIndex + 1);
      try {
        return JSON.parse(extractedJsonSubstring) as T;
      } catch (parseError: unknown) {
        const errorMessage = parseError instanceof Error ? parseError.message : String(parseError);
        applicationLogger.fileDetail('error', 'Failed substring JSON parse attempt', {
          errorMessage,
          extractedJsonSubstring,
        });
        throw new AiResponseParseError(
          `Unable to parse JSON from AI response: ${errorMessage}`,
          rawResponseText
        );
      }
    }

    throw new AiResponseParseError(
      'No valid JSON object structure found in AI response',
      rawResponseText
    );
  }
}

/**
 * Validates the runtime envelope of parsed Receipt Vision model output.
 * Ensures that action is valid, records are an array of non-null objects for CREATE_RECORD,
 * and preserves observable fields without letting unvalidated structures leak into downstream handlers.
 */
export function validateReceiptFinancialIntentEnvelope(
  rawParsedObject: unknown,
  rawResponseContent?: string
): ExtractedFinancialIntent {
  if (!rawParsedObject || typeof rawParsedObject !== 'object' || Array.isArray(rawParsedObject)) {
    throw new AiResponseParseError(
      'Receipt Vision output is not a valid JSON object',
      rawResponseContent
    );
  }

  const rawRecord = rawParsedObject as Record<string, unknown>;
  const allowedActions = new Set<string>([
    'CREATE_RECORD',
    'RECORD_EXPENSE',
    'RECORD_INCOME',
    'RECORD_TRANSFER',
    'CHECK_BUDGET',
    'CHECK_BALANCE',
    'GENERAL_REPLY',
  ]);

  const rawAction = rawRecord.action;
  if (typeof rawAction !== 'string' || !allowedActions.has(rawAction)) {
    throw new AiResponseParseError(
      `Receipt Vision output contains invalid action: ${String(rawAction)}`,
      rawResponseContent
    );
  }

  const validatedAction = rawAction as ExtractedFinancialIntent['action'];

  if (
    validatedAction === 'CREATE_RECORD' ||
    validatedAction === 'RECORD_EXPENSE' ||
    validatedAction === 'RECORD_INCOME' ||
    validatedAction === 'RECORD_TRANSFER'
  ) {
    if (!('records' in rawRecord) || !Array.isArray(rawRecord.records)) {
      throw new AiResponseParseError(
        `Receipt Vision ${validatedAction} intent requires records to be an array`,
        rawResponseContent
      );
    }

    const validatedRecords: ExtractedFinancialRecordItem[] = [];
    for (let index = 0; index < rawRecord.records.length; index++) {
      const item = rawRecord.records[index];
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new AiResponseParseError(
          `Receipt Vision record item at index ${index} must be a non-null object`,
          rawResponseContent
        );
      }
      const rawItem = item as Record<string, unknown>;
      validatedRecords.push({
        accountId: typeof rawItem.accountId === 'string' ? rawItem.accountId : '',
        categoryId: typeof rawItem.categoryId === 'string' ? rawItem.categoryId : undefined,
        amount: rawItem.amount as any,
        recordDate: typeof rawItem.recordDate === 'string' ? rawItem.recordDate : '',
        note: typeof rawItem.note === 'string' ? rawItem.note : '',
        counterParty: typeof rawItem.counterParty === 'string' ? rawItem.counterParty : undefined,
        labels: Array.isArray(rawItem.labels)
          ? rawItem.labels.filter((l): l is string => typeof l === 'string')
          : undefined,
        ...(typeof rawItem.currency === 'string' ? { currency: rawItem.currency } : {}),
      });
    }

    return {
      action: validatedAction,
      records: validatedRecords,
      explanation: typeof rawRecord.explanation === 'string' ? rawRecord.explanation : undefined,
    };
  }

  return {
    action: validatedAction,
    explanation: typeof rawRecord.explanation === 'string' ? rawRecord.explanation : undefined,
  };
}
