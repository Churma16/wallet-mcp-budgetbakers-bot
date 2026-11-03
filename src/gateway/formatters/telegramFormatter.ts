import type { ChannelMessageFormatter } from './types.js';

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

  // Allowed delimiter/punctuation boundaries around formatted markup
  const boundaryBefore = '(?<=^|[\\s([{<"\'“‘/•—–;\\-])';
  const boundaryAfter = '(?=$|[\\s)\\]}>"\'”’.,!?:;&/•—–;\\-])';

  // 4a. Double-asterisk bold: **text** -> <b>text</b> (common in standard Markdown/LLM outputs)
  transformedText = transformedText.replace(
    new RegExp(`${boundaryBefore}\\*\\*([^\\s*\\n](?:[^*\\n]*[^\\s*\\n])?)\\*\\*${boundaryAfter}`, 'gm'),
    '<b>$1</b>'
  );

  // 4b. Single-asterisk bold: *text* -> <b>text</b>
  transformedText = transformedText.replace(
    new RegExp(`${boundaryBefore}\\*([^\\s*\\n](?:[^*\\n]*[^\\s*\\n])?)\\*${boundaryAfter}`, 'gm'),
    '<b>$1</b>'
  );

  // 5. Italic: _text_ -> <i>text</i>
  transformedText = transformedText.replace(
    new RegExp(`${boundaryBefore}_([^\\s_\\n](?:[^_\\n]*[^\\s_\\n])?)_${boundaryAfter}`, 'gm'),
    '<i>$1</i>'
  );

  // 6a. Double-tilde strikethrough: ~~text~~ -> <s>text</s>
  transformedText = transformedText.replace(
    new RegExp(`${boundaryBefore}~~([^\\s~\\n](?:[^~\\n]*[^\\s~\\n])?)~~${boundaryAfter}`, 'gm'),
    '<s>$1</s>'
  );

  // 6b. Single-tilde strikethrough: ~text~ -> <s>text</s>
  transformedText = transformedText.replace(
    new RegExp(`${boundaryBefore}~([^\\s~\\n](?:[^~\\n]*[^\\s~\\n])?)~${boundaryAfter}`, 'gm'),
    '<s>$1</s>'
  );

  return transformedText;
}

/**
 * Backward compatibility alias for legacy callers and tests.
 */
export const convertWhatsAppMarkupToTelegramHtml = formatTelegramHtml;

export class TelegramMessageFormatter implements ChannelMessageFormatter {
  public readonly channelName = 'telegram' as const;

  public format(sourceText: string): string {
    return formatTelegramHtml(sourceText);
  }
}
