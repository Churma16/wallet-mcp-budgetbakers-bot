import axios from 'axios';
import { applicationLogger } from '../../utils/logger.js';
import { getDictionary, SupportedLanguage } from '../../i18n/index.js';
import { SupportedMessengerChannel } from './types.js';

export type MediaRejectionStage = 'declared_size' | 'metadata' | 'download_stream' | 'buffer';

export interface RejectOversizedMediaParameters {
  channel: SupportedMessengerChannel;
  chatIdentifier: string;
  senderIdentifier: string;
  maxMediaDownloadBytes: number;
  actualBytes?: number;
  rejectionStage: MediaRejectionStage;
  sendTextMessage: (chatIdentifier: string, messageText: string) => Promise<void>;
  additionalMetadata?: Record<string, unknown>;
}

export interface HandleMediaDownloadFailureParameters {
  channel: SupportedMessengerChannel;
  chatIdentifier: string;
  senderIdentifier: string;
  downloadError: unknown;
  sendTextMessage: (chatIdentifier: string, messageText: string) => Promise<void>;
  redactToken?: string;
  additionalMetadata?: Record<string, unknown>;
}

/**
 * Converts a byte count into rounded megabytes (MB)
 */
export function formatBytesToMegabytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return 0;
  }
  return Math.round(bytes / (1024 * 1024));
}

/**
 * Converts a byte count into a formatted megabytes display string with decimal places
 */
export function formatBytesToMegabytesDisplay(bytes: number, decimalPlaces: number = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return (0).toFixed(decimalPlaces);
  }
  return (bytes / (1024 * 1024)).toFixed(decimalPlaces);
}

/**
 * Evaluates whether an incoming media file size strictly exceeds the configured byte threshold
 */
export function isMediaSizeExceeded(actualBytes: number, maxBytes: number): boolean {
  if (!Number.isFinite(actualBytes) || actualBytes <= 0) {
    return false;
  }
  return actualBytes > maxBytes;
}

/**
 * Determines whether an error was caused by exceeding HTTP / stream body or content length limits
 */
export function isMediaPayloadSizeLimitExceeded(error: unknown): boolean {
  if (!error) {
    return false;
  }

  const isAxiosLimitCode =
    axios.isAxiosError(error) && error.code === 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED';
  const isGenericLimitCode =
    (error as { code?: string })?.code === 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED';

  const rawErrorMessage =
    error instanceof Error
      ? error.message
      : typeof (error as { message?: unknown })?.message === 'string'
        ? (error as { message: string }).message
        : String(error);
  const normalizedErrorMessage = rawErrorMessage.toLowerCase();
  const containsLimitSubstring =
    normalizedErrorMessage.includes('maxcontentlength') ||
    normalizedErrorMessage.includes('maxbodylength');

  return isAxiosLimitCode || isGenericLimitCode || containsLimitSubstring;
}

/**
 * Normalizes channel identifiers to standard human-facing channel display names
 */
export function getChannelDisplayName(channel: SupportedMessengerChannel | string): string {
  const normalizedChannel = (channel || '').trim().toLowerCase();
  switch (normalizedChannel) {
    case 'whatsapp':
      return 'WhatsApp';
    case 'telegram':
      return 'Telegram';
    case 'console':
      return 'Console';
    default:
      return channel;
  }
}

/**
 * Formats a localized user warning message when incoming media exceeds size boundaries
 */
export function formatMediaTooLargeMessage(
  maxMediaDownloadBytes: number,
  languageCode?: SupportedLanguage
): string {
  const localizedDictionary = getDictionary(languageCode);
  const maxMegabytes = formatBytesToMegabytes(maxMediaDownloadBytes);
  return localizedDictionary.errors.mediaTooLarge(maxMegabytes);
}

/**
 * Formats a localized user message when media download fails
 */
export function formatMediaDownloadFailedMessage(
  channel: SupportedMessengerChannel | string,
  languageCode?: SupportedLanguage
): string {
  const localizedDictionary = getDictionary(languageCode);
  const channelDisplayName = getChannelDisplayName(channel);
  return localizedDictionary.errors.mediaDownloadFailed(channelDisplayName);
}

/**
 * Rejects oversized media with structured warnings and dispatches localized user warning
 */
export async function rejectOversizedMedia(
  parameters: RejectOversizedMediaParameters
): Promise<void> {
  const channelDisplayName = getChannelDisplayName(parameters.channel);
  const maxAllowedMegabytes = formatBytesToMegabytes(parameters.maxMediaDownloadBytes);

  if (parameters.actualBytes !== undefined) {
    const actualMegabytesDisplay = formatBytesToMegabytesDisplay(parameters.actualBytes, 1);
    applicationLogger.warn(
      `[WARN] ${channelDisplayName} image media from ${parameters.senderIdentifier} exceeds size limit (${actualMegabytesDisplay} MB > ${maxAllowedMegabytes} MB). Stage: ${parameters.rejectionStage}. Media rejected.`
    );
  } else {
    applicationLogger.warn(
      `[WARN] ${channelDisplayName} image media from ${parameters.senderIdentifier} rejected due to payload size limit exceeding ${maxAllowedMegabytes} MB. Stage: ${parameters.rejectionStage}.`
    );
  }

  applicationLogger.fileDetail('warn', `${channelDisplayName} Oversized Media Rejected`, {
    channel: parameters.channel,
    chatIdentifier: parameters.chatIdentifier,
    senderIdentifier: parameters.senderIdentifier,
    actualBytes: parameters.actualBytes,
    maxMediaDownloadBytes: parameters.maxMediaDownloadBytes,
    rejectionStage: parameters.rejectionStage,
    ...(parameters.additionalMetadata || {}),
  });

  const localizedErrorMessage = formatMediaTooLargeMessage(parameters.maxMediaDownloadBytes);
  await parameters.sendTextMessage(parameters.chatIdentifier, localizedErrorMessage);
}

/**
 * Handles media download errors with token redaction, structured logging, and localized failure notice
 */
export async function handleMediaDownloadFailure(
  parameters: HandleMediaDownloadFailureParameters
): Promise<void> {
  const channelDisplayName = getChannelDisplayName(parameters.channel);
  const rawErrorMessage =
    parameters.downloadError instanceof Error
      ? parameters.downloadError.message
      : String(parameters.downloadError);

  const sanitizedErrorMessage = parameters.redactToken
    ? rawErrorMessage.replaceAll(parameters.redactToken, '[REDACTED_TOKEN]')
    : rawErrorMessage;

  applicationLogger.error(
    `Failed to download incoming ${channelDisplayName} media from ${parameters.senderIdentifier}: ${sanitizedErrorMessage}`
  );

  const errorDetailPayload =
    parameters.downloadError instanceof Error
      ? {
          name: parameters.downloadError.name,
          message: parameters.redactToken
            ? parameters.downloadError.message.replaceAll(parameters.redactToken, '[REDACTED_TOKEN]')
            : parameters.downloadError.message,
          stack: parameters.downloadError.stack
            ? (parameters.redactToken
                ? parameters.downloadError.stack.replaceAll(parameters.redactToken, '[REDACTED_TOKEN]')
                : parameters.downloadError.stack)
            : undefined,
        }
      : sanitizedErrorMessage;

  applicationLogger.fileDetail('error', `${channelDisplayName} Media Download Failure`, {
    channel: parameters.channel,
    chatIdentifier: parameters.chatIdentifier,
    senderIdentifier: parameters.senderIdentifier,
    error: errorDetailPayload,
    ...(parameters.additionalMetadata || {}),
  });

  const localizedErrorMessage = formatMediaDownloadFailedMessage(parameters.channel);
  await parameters.sendTextMessage(parameters.chatIdentifier, localizedErrorMessage);
}
