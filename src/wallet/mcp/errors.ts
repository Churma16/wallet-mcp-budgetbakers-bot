import {
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
} from '@modelcontextprotocol/client';
import type {
  WalletMcpDispatchOutcome,
  WalletMcpFailureClassification,
} from './capabilityTypes.js';
import { redactSensitiveData } from '../../lib/logger.js';

export interface FailureOutcome {
  readonly dispatchOutcome: WalletMcpDispatchOutcome;
  readonly classification: WalletMcpFailureClassification;
}

interface KeywordRule<T> {
  readonly keywords: readonly string[];
  readonly value: T;
}

const KEYWORD_FAILURE_RULES: readonly KeywordRule<FailureOutcome>[] = [
  {
    keywords: ['timeout', 'network', 'fetch failed', 'etimedout', 'econnrefused'],
    value: { dispatchOutcome: 'UNKNOWN', classification: 'TRANSIENT' },
  },
  {
    keywords: ['permission', 'unauthorized', 'forbidden', 'scope', '401', '403'],
    value: { dispatchOutcome: 'DEFINITIVE_FAILURE', classification: 'AUTHORIZATION' },
  },
  {
    keywords: [
      'method not found',
      'tool not found',
      'unknown tool',
      'not supported',
      'not implemented',
      '-32601',
      '405',
      'unavailable',
    ],
    value: { dispatchOutcome: 'DEFINITIVE_FAILURE', classification: 'TOOL_UNAVAILABLE' },
  },
];

function matchKeywordFailureOutcome(lowerMessage: string): FailureOutcome | undefined {
  for (const rule of KEYWORD_FAILURE_RULES) {
    if (rule.keywords.some(keyword => lowerMessage.includes(keyword))) {
      return rule.value;
    }
  }
  return undefined;
}

function inferClassificationFromMessage(
  message: string,
  dispatchOutcome: WalletMcpDispatchOutcome
): WalletMcpFailureClassification {
  const lowerMessage = message.toLowerCase();
  const keywordOutcome = matchKeywordFailureOutcome(lowerMessage);
  if (keywordOutcome) {
    return keywordOutcome.classification;
  }
  if (dispatchOutcome === 'UNKNOWN') {
    return 'TRANSIENT';
  }
  return 'REQUEST_INVALID';
}

/**
 * Structured request and protocol error representing failure outcomes from Wallet MCP dispatch,
 * encoding failure classification, dispatch certainty, and credential redaction.
 */
export class WalletMcpRequestError extends Error {
  public readonly classification: WalletMcpFailureClassification;

  constructor(
    message: string,
    public readonly dispatchOutcome: WalletMcpDispatchOutcome,
    classification?: WalletMcpFailureClassification
  ) {
    super(message);
    this.name = 'WalletMcpRequestError';
    this.classification = classification ?? inferClassificationFromMessage(message, dispatchOutcome);
  }
}

export function isWalletMcpDispatchOutcomeUnknown(error: unknown): boolean {
  return error instanceof WalletMcpRequestError && error.dispatchOutcome === 'UNKNOWN';
}

export function isWalletMcpDefinitiveFailure(error: unknown): boolean {
  return error instanceof WalletMcpRequestError && error.dispatchOutcome === 'DEFINITIVE_FAILURE';
}

export function isWalletMcpCapabilityRejection(error: unknown): boolean {
  if (error instanceof WalletMcpRequestError) {
    return error.classification === 'AUTHORIZATION' || error.classification === 'TOOL_UNAVAILABLE';
  }
  return false;
}

export function sanitizeMcpErrorMessage(error: unknown, accessToken?: string): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  let sanitized = redactSensitiveData(rawMessage);
  if (accessToken && accessToken.length > 4) {
    sanitized = sanitized.replaceAll(accessToken, '[REDACTED_ACCESS_TOKEN]');
  }
  return sanitized;
}

/**
 * Lookup table for discrete HTTP status codes returned by SdkHttpError.
 */
const HTTP_STATUS_FAILURE_MAP: Readonly<Record<number, FailureOutcome>> = {
  400: { dispatchOutcome: 'DEFINITIVE_FAILURE', classification: 'REQUEST_INVALID' },
  401: { dispatchOutcome: 'DEFINITIVE_FAILURE', classification: 'AUTHORIZATION' },
  403: { dispatchOutcome: 'DEFINITIVE_FAILURE', classification: 'AUTHORIZATION' },
  404: { dispatchOutcome: 'DEFINITIVE_FAILURE', classification: 'UNKNOWN' },
  405: { dispatchOutcome: 'DEFINITIVE_FAILURE', classification: 'TOOL_UNAVAILABLE' },
  408: { dispatchOutcome: 'UNKNOWN', classification: 'TRANSIENT' },
  429: { dispatchOutcome: 'DEFINITIVE_FAILURE', classification: 'TRANSIENT' },
};

/**
 * Lookup table for discrete MCP SDK error codes returned by SdkError.
 */
const SDK_ERROR_CODE_MAP: Readonly<Record<string, FailureOutcome>> = {
  [SdkErrorCode.CapabilityNotSupported]: {
    dispatchOutcome: 'DEFINITIVE_FAILURE',
    classification: 'TOOL_UNAVAILABLE',
  },
  [SdkErrorCode.MethodNotSupportedByProtocolVersion]: {
    dispatchOutcome: 'DEFINITIVE_FAILURE',
    classification: 'TOOL_UNAVAILABLE',
  },
  [SdkErrorCode.NotInitialized]: {
    dispatchOutcome: 'DEFINITIVE_FAILURE',
    classification: 'UNKNOWN',
  },
  [SdkErrorCode.ConnectionClosed]: {
    dispatchOutcome: 'UNKNOWN',
    classification: 'TRANSIENT',
  },
  [SdkErrorCode.RequestTimeout]: {
    dispatchOutcome: 'UNKNOWN',
    classification: 'TRANSIENT',
  },
  [SdkErrorCode.SendFailed]: {
    dispatchOutcome: 'UNKNOWN',
    classification: 'TRANSIENT',
  },
};

/**
 * Lookup table for discrete JSON-RPC protocol error codes returned by ProtocolError.
 */
const PROTOCOL_ERROR_CODE_MAP: Readonly<Record<number, FailureOutcome>> = {
  [-32601]: { dispatchOutcome: 'DEFINITIVE_FAILURE', classification: 'TOOL_UNAVAILABLE' },
  [-32602]: { dispatchOutcome: 'DEFINITIVE_FAILURE', classification: 'REQUEST_INVALID' },
};

type FailureClassifierStrategy = (error: unknown, lowerMessage: string) => FailureOutcome | undefined;

/**
 * Extensible classifier pipeline executing ordered evaluation strategies.
 */
const CLASSIFIER_STRATEGIES: readonly FailureClassifierStrategy[] = [
  // Strategy 1: JSON-RPC ProtocolError
  (error, lowerMessage) => {
    if (!ProtocolError.isInstance(error)) return undefined;
    return (
      PROTOCOL_ERROR_CODE_MAP[error.code as number] ??
      matchKeywordFailureOutcome(lowerMessage) ?? {
        dispatchOutcome: 'DEFINITIVE_FAILURE',
        classification: 'REQUEST_INVALID',
      }
    );
  },

  // Strategy 2: HTTP Transport Error (SdkHttpError)
  error => {
    if (!SdkHttpError.isInstance(error)) return undefined;
    const mapped = HTTP_STATUS_FAILURE_MAP[error.status];
    if (mapped) return mapped;
    if (error.status >= 500) {
      return { dispatchOutcome: 'UNKNOWN', classification: 'TRANSIENT' };
    }
    return { dispatchOutcome: 'DEFINITIVE_FAILURE', classification: 'UNKNOWN' };
  },

  // Strategy 3: MCP SDK Error (SdkError)
  error => {
    if (!SdkError.isInstance(error)) return undefined;
    return (
      SDK_ERROR_CODE_MAP[String(error.code)] ?? {
        dispatchOutcome: 'UNKNOWN',
        classification: 'UNKNOWN',
      }
    );
  },

  // Strategy 4: Fallback Substring Matching
  (_error, lowerMessage) => matchKeywordFailureOutcome(lowerMessage),
];

/**
 * Classifies an unknown error into a structured WalletMcpRequestError
 * using table-driven lookups and an extensible strategy pipeline.
 */
export function classifyMcpFailure(
  error: unknown,
  operationName: string,
  accessToken?: string
): WalletMcpRequestError {
  if (error instanceof WalletMcpRequestError) {
    return error;
  }

  const sanitizedMessage = sanitizeMcpErrorMessage(error, accessToken);
  const lowerMessage = sanitizedMessage.toLowerCase();

  let resolvedOutcome: FailureOutcome = {
    dispatchOutcome: 'UNKNOWN',
    classification: 'UNKNOWN',
  };

  for (const strategy of CLASSIFIER_STRATEGIES) {
    const outcome = strategy(error, lowerMessage);
    if (outcome) {
      resolvedOutcome = outcome;
      break;
    }
  }

  return new WalletMcpRequestError(
    `[error] MCP operation '${operationName}' failed: ${sanitizedMessage}`,
    resolvedOutcome.dispatchOutcome,
    resolvedOutcome.classification
  );
}
