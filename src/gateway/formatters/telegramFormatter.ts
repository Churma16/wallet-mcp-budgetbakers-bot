import type { ChannelMessageFormatter } from './types.js';
import { replaceDelimitedMarkup } from './htmlUtils.js';

/**
 * Helper to escape HTML reserved characters to prevent parsing errors in Telegram HTML parse mode.
 */
export function escapeHtmlEntities(rawText: string): string {
  return rawText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Converts canonical chat markup (*bold*, **bold**, _italic_, ~strike~, ~~strike~~, `code`, ```code```)
 * into safe, valid Telegram HTML.
 */
export function formatTelegramHtml(sourceText: string): string {
  if (!sourceText) {
    return '';
  }

  // 1. Escape HTML special entities
  let transformedText = escapeHtmlEntities(sourceText);

  // 2. Multi-line code block: ```code``` -> <pre>code</pre>
  transformedText = transformedText.replace(/```([\s\S]*?)```/g, '<pre>$1</pre>');

  // 3. Single-line inline code: `code` -> <code>code</code>
  transformedText = transformedText.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // 4. Bold: **text** and *text* -> <b>text</b>
  transformedText = replaceDelimitedMarkup(transformedText, '**', content => `<b>${content}</b>`);
  transformedText = replaceDelimitedMarkup(transformedText, '*', content => `<b>${content}</b>`);

  // 5. Italic: _text_ -> <i>text</i>
  transformedText = replaceDelimitedMarkup(transformedText, '_', content => `<i>${content}</i>`);

  // 6. Strikethrough: ~~text~~ and ~text~ -> <s>text</s>
  transformedText = replaceDelimitedMarkup(transformedText, '~~', content => `<s>${content}</s>`);
  transformedText = replaceDelimitedMarkup(transformedText, '~', content => `<s>${content}</s>`);

  return transformedText;
}

export class TelegramMessageFormatter implements ChannelMessageFormatter {
  public readonly channelName = 'telegram' as const;

  public format(sourceText: string): string {
    return formatTelegramHtml(sourceText);
  }
}
