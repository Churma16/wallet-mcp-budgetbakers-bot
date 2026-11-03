import type { ChannelMessageFormatter } from './types.js';
import { decodeHtmlEntities, replaceDelimitedMarkup, stripHtmlTags } from './htmlUtils.js';

/**
 * Normalizes messages for interactive terminal / console output:
 * 1. Strips HTML tags cleanly and decodes entities safely via single-pass matching.
 * 2. Unwraps formatting markers (*bold*, _italic_, ~strike~) into plain legible terminal text.
 */
export function formatConsolePlainText(sourceText: string): string {
  if (!sourceText) {
    return '';
  }

  // 1. Strip HTML tags iteratively until a fixed point is reached
  let transformedText = stripHtmlTags(sourceText);

  // 2. Decode HTML entities in a single pass to eliminate double-unescaping
  transformedText = decodeHtmlEntities(transformedText);

  // 3. Unwrap double-asterisk and single-asterisk bold
  transformedText = replaceDelimitedMarkup(transformedText, '**', content => content);
  transformedText = replaceDelimitedMarkup(transformedText, '*', content => content);

  // 4. Unwrap italic
  transformedText = replaceDelimitedMarkup(transformedText, '_', content => content);

  // 5. Unwrap double-tilde and single-tilde strikethrough
  transformedText = replaceDelimitedMarkup(transformedText, '~~', content => content);
  transformedText = replaceDelimitedMarkup(transformedText, '~', content => content);

  return transformedText;
}

export class ConsoleMessageFormatter implements ChannelMessageFormatter {
  public readonly channelName = 'console' as const;

  public format(sourceText: string): string {
    return formatConsolePlainText(sourceText);
  }
}
