import type { ChannelMessageFormatter } from './types.js';
import { decodeHtmlEntities, replaceDelimitedMarkup } from './htmlUtils.js';

/**
 * Normalizes and formats outgoing messages for WhatsApp delivery:
 * 1. Converts standard Markdown formatting (double asterisks, double tildes) into native WhatsApp syntax.
 * 2. Transpiles common HTML formatting tags (<b>, <i>, <s>, <code>, <pre>) into WhatsApp syntax.
 * 3. Decodes escaped HTML entities (&amp;, &lt;, &gt;) back to literal text characters via single-pass decoding.
 */
export function formatWhatsAppMarkdown(sourceText: string): string {
  if (!sourceText) {
    return '';
  }

  let transformedText = sourceText;

  // 1. Multi-line code block: <pre><code>...</code></pre> or <pre>...</pre> -> ```...```
  transformedText = transformedText.replace(/<pre>(?:<code>)?([\s\S]*?)(?:<\/code>)?<\/pre>/gi, '```$1```');

  // 2. Single-line inline code: <code>...</code> -> `...`
  transformedText = transformedText.replace(/<code>([^<]+)<\/code>/gi, '`$1`');

  // 3. HTML bold: <b>...</b> or <strong>...</strong> -> *...*
  transformedText = transformedText.replace(/<(?:b|strong)>([\s\S]*?)<\/(?:b|strong)>/gi, '*$1*');

  // 4. HTML italic: <i>...</i> or <em>...</em> -> _..._
  transformedText = transformedText.replace(/<(?:i|em)>([\s\S]*?)<\/(?:i|em)>/gi, '_$1_');

  // 5. HTML strikethrough: <s>...</s> or <del>... or <strike>... -> ~...~
  transformedText = transformedText.replace(/<(?:s|del|strike)>([\s\S]*?)<\/(?:s|del|strike)>/gi, '~$1~');

  // 6. Decode HTML entities safely via single-pass matching to prevent double-unescaping
  transformedText = decodeHtmlEntities(transformedText);

  // 7. Normalize Markdown bold and strikethrough for WhatsApp (**bold** -> *bold*, ~~strike~~ -> ~strike~)
  transformedText = replaceDelimitedMarkup(transformedText, '**', content => `*${content}*`);
  transformedText = replaceDelimitedMarkup(transformedText, '~~', content => `~${content}~`);

  return transformedText;
}

export class WhatsAppMessageFormatter implements ChannelMessageFormatter {
  public readonly channelName = 'whatsapp' as const;

  public format(sourceText: string): string {
    return formatWhatsAppMarkdown(sourceText);
  }
}
