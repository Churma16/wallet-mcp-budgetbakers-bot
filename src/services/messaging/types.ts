export type SupportedMessengerChannel = 'whatsapp' | 'telegram';

export type AdapterConnectionState = 'idle' | 'connected' | 'reconnecting' | 'failed';

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

