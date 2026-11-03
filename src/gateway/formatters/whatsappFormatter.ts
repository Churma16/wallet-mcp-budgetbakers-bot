import type { ChannelMessageFormatter } from './types.js';

/**
 * Normalizes and formats outgoing messages for WhatsApp delivery:
 * 1. Converts standard Markdown formatting (double asterisks, double tildes) into native WhatsApp syntax.
 * 2. Transpiles common HTML formatting tags (<b>, <i>, <s>, <code>, <pre>) into WhatsApp syntax.
 * 3. Decodes escaped HTML entities (&amp;, &lt;, &gt;) back to literal text characters.
 */
export function formatWhatsAppMarkdown(sourceText: string): string {
  if (!sourceText) {
    return '';
  }

  let transformedText = sourceText;

  // 1. Decode HTML entities if any were pre-escaped
  transformedText = transformedText
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  // 2. Multi-line code block: <pre><code>...</code></pre> or <pre>...</pre> -> ```...```
  transformedText = transformedText.replace(/<pre>(?:<code>)?([\s\S]*?)(?:<\/code>)?<\/pre>/gi, '```$1```');

  // 3. Single-line inline code: <code>...</code> -> `...`
  transformedText = transformedText.replace(/<code>([^<]+)<\/code>/gi, '`$1`');

  // 4. HTML bold: <b>...</b> or <strong>...</strong> -> *...*
  transformedText = transformedText.replace(/<(?:b|strong)>([\s\S]*?)<\/(?:b|strong)>/gi, '*$1*');

  // 5. HTML italic: <i>...</i> or <em>...</em> -> _..._
  transformedText = transformedText.replace(/<(?:i|em)>([\s\S]*?)<\/(?:i|em)>/gi, '_$1_');

  // 6. HTML strikethrough: <s>...</s> or <del>... or <strike>... -> ~...~
  transformedText = transformedText.replace(/<(?:s|del|strike)>([\s\S]*?)<\/(?:s|del|strike)>/gi, '~$1~');

  // Delimiter boundaries for standard markdown normalization
  const boundaryBefore = '(?<=^|[\\s([{<"\'“‘/•—–;\\-])';
  const boundaryAfter = '(?=$|[\\s)\\]}>"\'”’.,!?:;&/•—–;\\-])';

  // 7. Double-asterisk bold -> single-asterisk WhatsApp bold (**text** -> *text*)
  transformedText = transformedText.replace(
    new RegExp(`${boundaryBefore}\\*\\*([^\\s*\\n](?:[^*\\n]*[^\\s*\\n])?)\\*\\*${boundaryAfter}`, 'gm'),
    '*$1*'
  );

  // 8. Double-tilde strikethrough -> single-tilde WhatsApp strikethrough (~~text~~ -> ~text~)
  transformedText = transformedText.replace(
    new RegExp(`${boundaryBefore}~~([^\\s~\\n](?:[^~\\n]*[^\\s~\\n])?)~~${boundaryAfter}`, 'gm'),
    '~$1~'
  );

  return transformedText;
}

export class WhatsAppMessageFormatter implements ChannelMessageFormatter {
  public readonly channelName = 'whatsapp' as const;

  public format(sourceText: string): string {
    return formatWhatsAppMarkdown(sourceText);
  }
}
