import type { SupportedMessengerChannel } from '../types.js';
import type { ChannelMessageFormatter } from './types.js';
import { formatTelegramHtml, TelegramMessageFormatter } from './telegramFormatter.js';
import { formatWhatsAppMarkdown, WhatsAppMessageFormatter } from './whatsappFormatter.js';
import { formatConsolePlainText, ConsoleMessageFormatter } from './consoleFormatter.js';

export type { ChannelMessageFormatter };
export {
  formatTelegramHtml,
  TelegramMessageFormatter,
  formatWhatsAppMarkdown,
  WhatsAppMessageFormatter,
  formatConsolePlainText,
  ConsoleMessageFormatter,
};

const formatterRegistry: Record<SupportedMessengerChannel, ChannelMessageFormatter> = {
  telegram: new TelegramMessageFormatter(),
  whatsapp: new WhatsAppMessageFormatter(),
  console: new ConsoleMessageFormatter(),
};

/**
 * Dispatches formatting for the target messenger channel.
 */
export function formatMessageForChannel(channel: SupportedMessengerChannel, sourceText: string): string {
  const formatter = formatterRegistry[channel];
  if (!formatter) {
    return sourceText;
  }
  return formatter.format(sourceText);
}
