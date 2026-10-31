export type SupportedMessengerChannel = 'whatsapp' | 'telegram' | 'console';

export type AdapterConnectionState = 'idle' | 'connected' | 'reconnecting' | 'failed' | 'stopping';

export interface IncomingUserMessageEvent {
  channel: SupportedMessengerChannel;
  senderIdentifier: string;
  chatIdentifier: string;
  messageType: 'text' | 'image';
  textPayload?: string;
  imageBuffer?: Buffer;
  imageMimeType?: string;
}

export type UserMessageCallback = (incomingEvent: IncomingUserMessageEvent) => Promise<void>;

export interface MessagingAdapter {
  readonly channelName: SupportedMessengerChannel;
  startConnection(): Promise<void>;
  stopConnection?(): Promise<void>;
  sendTextMessage(targetChatIdentifier: string, messageText: string): Promise<void>;
  sendTypingPresence(targetChatIdentifier: string): Promise<void>;
  clearTypingPresence(targetChatIdentifier: string): Promise<void>;
  sendBroadcastNotification(messageText: string): Promise<void>;
  getConnectionState?(): AdapterConnectionState;
}

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

export interface TelegramSafeguardConfiguration {
  maxStartupAttempts?: number;
  startupRetryBaseDelayMs?: number;
  startupRetryMaxDelayMs?: number;
  maxMediaDownloadBytes?: number;
}

export interface WhatsappSafeguardConfiguration {
  maxReconnectAttempts?: number;
  maxBackoffSeconds?: number;
  messageQueueIntervalMs?: number;
  typingPresenceCooldownMs?: number;
  maxMediaDownloadBytes?: number;
}

export interface ConsoleAdapterConfiguration {
  readonly inputStream?: NodeJS.ReadableStream;
  readonly outputStream?: NodeJS.WritableStream;
  readonly promptPrefix?: string;
  readonly senderIdentifier?: string;
  readonly chatIdentifier?: string;
  readonly onExitRequested?: () => void | Promise<void>;
}

export interface MessagingGatewayConfiguration {
  maxBackgroundReconnectAttempts?: number;
  backgroundReconnectBaseDelayMs?: number;
  backgroundReconnectMaxDelayMs?: number;
}
