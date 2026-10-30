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
import { redactSensitiveData } from '../utils/logger.js';

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
    if (classification !== undefined) {
      this.classification = classification;
    } else {
      const lowerMessage = message.toLowerCase();
      if (
        lowerMessage.includes('permission') ||
        lowerMessage.includes('unauthorized') ||
        lowerMessage.includes('forbidden') ||
        lowerMessage.includes('scope') ||
        lowerMessage.includes('401') ||
        lowerMessage.includes('403')
      ) {
        this.classification = 'AUTHORIZATION';
      } else if (
        lowerMessage.includes('method not found') ||
        lowerMessage.includes('tool not found') ||
        lowerMessage.includes('unknown tool') ||
        lowerMessage.includes('not supported') ||
        lowerMessage.includes('not implemented') ||
        lowerMessage.includes('-32601') ||
        lowerMessage.includes('405')
      ) {
        this.classification = 'TOOL_UNAVAILABLE';
      } else if (
        dispatchOutcome === 'UNKNOWN' ||
        lowerMessage.includes('timeout') ||
        lowerMessage.includes('network') ||
        lowerMessage.includes('econnrefused')
      ) {
        this.classification = 'TRANSIENT';
      } else {
        this.classification = 'REQUEST_INVALID';
      }
    }
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

export function classifyMcpFailure(
  error: unknown,
  operationName: string,
  accessToken?: string
): WalletMcpRequestError {
  if (error instanceof WalletMcpRequestError) {
    return error;
  }

  const sanitizedMessage = sanitizeMcpErrorMessage(error, accessToken);
  let dispatchOutcome: WalletMcpDispatchOutcome = 'UNKNOWN';
  let classification: WalletMcpFailureClassification = 'UNKNOWN';

  if (ProtocolError.isInstance(error)) {
    dispatchOutcome = 'DEFINITIVE_FAILURE';
    if (error.code === -32601) {
      classification = 'TOOL_UNAVAILABLE';
    } else if (error.code === -32602) {
      classification = 'REQUEST_INVALID';
    } else {
      const lowerMessage = (error.message || '').toLowerCase();
      if (
        lowerMessage.includes('permission') ||
        lowerMessage.includes('unauthorized') ||
        lowerMessage.includes('forbidden') ||
        lowerMessage.includes('scope')
      ) {
        classification = 'AUTHORIZATION';
      } else if (
        lowerMessage.includes('not found') ||
        lowerMessage.includes('not supported') ||
        lowerMessage.includes('not implemented') ||
        lowerMessage.includes('unavailable')
      ) {
        classification = 'TOOL_UNAVAILABLE';
      } else {
        classification = 'REQUEST_INVALID';
      }
    }
  } else if (SdkHttpError.isInstance(error)) {
    if (error.status === 400) {
      dispatchOutcome = 'DEFINITIVE_FAILURE';
      classification = 'REQUEST_INVALID';
    } else if (error.status === 401 || error.status === 403) {
      dispatchOutcome = 'DEFINITIVE_FAILURE';
      classification = 'AUTHORIZATION';
    } else if (error.status === 404) {
      dispatchOutcome = 'DEFINITIVE_FAILURE';
      classification = 'UNKNOWN';
    } else if (error.status === 405) {
      dispatchOutcome = 'DEFINITIVE_FAILURE';
      classification = 'TOOL_UNAVAILABLE';
    } else if (error.status === 408) {
      dispatchOutcome = 'UNKNOWN';
      classification = 'TRANSIENT';
    } else if (error.status === 429) {
      dispatchOutcome = 'DEFINITIVE_FAILURE';
      classification = 'TRANSIENT';
    } else if (error.status >= 500) {
      dispatchOutcome = 'UNKNOWN';
      classification = 'TRANSIENT';
    } else {
      dispatchOutcome = 'DEFINITIVE_FAILURE';
      classification = 'UNKNOWN';
    }
  } else if (SdkError.isInstance(error)) {
    if (
      error.code === SdkErrorCode.CapabilityNotSupported ||
      error.code === SdkErrorCode.MethodNotSupportedByProtocolVersion
    ) {
      dispatchOutcome = 'DEFINITIVE_FAILURE';
      classification = 'TOOL_UNAVAILABLE';
    } else if (error.code === SdkErrorCode.NotInitialized) {
      dispatchOutcome = 'DEFINITIVE_FAILURE';
      classification = 'UNKNOWN';
    } else if (
      error.code === SdkErrorCode.ConnectionClosed ||
      error.code === SdkErrorCode.RequestTimeout ||
      error.code === SdkErrorCode.SendFailed
    ) {
      dispatchOutcome = 'UNKNOWN';
      classification = 'TRANSIENT';
    } else {
      dispatchOutcome = 'UNKNOWN';
      classification = 'UNKNOWN';
    }
  } else {
    const lowerMessage = sanitizedMessage.toLowerCase();
    if (
      lowerMessage.includes('timeout') ||
      lowerMessage.includes('network') ||
      lowerMessage.includes('fetch failed') ||
      lowerMessage.includes('etimedout') ||
      lowerMessage.includes('econnrefused')
    ) {
      dispatchOutcome = 'UNKNOWN';
      classification = 'TRANSIENT';
    } else if (
      lowerMessage.includes('permission') ||
      lowerMessage.includes('unauthorized') ||
      lowerMessage.includes('forbidden') ||
      lowerMessage.includes('scope')
    ) {
      dispatchOutcome = 'DEFINITIVE_FAILURE';
      classification = 'AUTHORIZATION';
    } else if (
      lowerMessage.includes('method not found') ||
      lowerMessage.includes('tool not found') ||
      lowerMessage.includes('unknown tool') ||
      lowerMessage.includes('not supported')
    ) {
      dispatchOutcome = 'DEFINITIVE_FAILURE';
      classification = 'TOOL_UNAVAILABLE';
    } else {
      dispatchOutcome = 'UNKNOWN';
      classification = 'UNKNOWN';
    }
  }

  return new WalletMcpRequestError(
    `[error] MCP operation '${operationName}' failed: ${sanitizedMessage}`,
    dispatchOutcome,
    classification
  );
}
