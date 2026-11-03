import type { SupportedMessengerChannel } from '../types.js';

/**
 * Contract for channel-specific message formatters.
 * Decouples message representations across delivery channels (WhatsApp, Telegram, Console).
 */
export interface ChannelMessageFormatter {
  readonly channelName: SupportedMessengerChannel;
  format(sourceText: string): string;
}
