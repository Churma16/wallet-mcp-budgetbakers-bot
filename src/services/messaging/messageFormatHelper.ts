/**
 * Helper to escape HTML reserved characters to prevent parsing errors in Telegram HTML parse mode.
 */
function escapeHtmlEntities(rawText: string): string {
  return rawText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Converts WhatsApp-style markdown formatted text (*bold*, _italic_, ~strike~, `code`)
 * into valid, safe Telegram HTML formatted string.
 */
export function convertWhatsAppMarkupToTelegramHtml(sourceText: string): string {
  if (!sourceText) {
    return '';
  }

  // 1. First escape HTML special entities
  let transformedText = escapeHtmlEntities(sourceText);

  // 2. Multi-line code block: ```code``` -> <pre>code</pre>
  transformedText = transformedText.replace(/```([\s\S]*?)```/g, '<pre>$1</pre>');

  // 3. Single-line inline code: `code` -> <code>code</code>
  transformedText = transformedText.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // 4. Bold: *text* -> <b>text</b> (ensures not matching across lines unnecessarily)
  // Matches *word* where asterisk is not preceded or followed by space
  transformedText = transformedText.replace(/(?<=^|[\s(])\*([^*\n]+)\*(?=$|[\s),.!?])/gm, '<b>$1</b>');

  // 5. Italic: _text_ -> <i>text</i>
  transformedText = transformedText.replace(/(?<=^|[\s(])_([^_\n]+)_(?=$|[\s),.!?])/gm, '<i>$1</i>');

  // 6. Strikethrough: ~text~ -> <s>text</s>
  transformedText = transformedText.replace(/(?<=^|[\s(])~([^~\n]+)~(?=$|[\s),.!?])/gm, '<s>$1</s>');

  return transformedText;
}
