import type { ChannelMessageFormatter } from './types.js';

/**
 * Normalizes messages for interactive terminal / console output:
 * 1. Strips HTML tags and decodes entities.
 * 2. Unwraps formatting markers (*bold*, _italic_, ~strike~) into plain legible terminal text.
 */
export function formatConsolePlainText(sourceText: string): string {
  if (!sourceText) {
    return '';
  }

  let transformedText = sourceText;

  // 1. Strip HTML tags
  transformedText = transformedText.replace(/<[^>]+>/g, '');

  // 2. Decode HTML entities
  transformedText = transformedText
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  // Delimiter boundaries
  const boundaryBefore = '(?<=^|[\\s([{<"\'“‘/•—–;\\-])';
  const boundaryAfter = '(?=$|[\\s)\\]}>"\'”’.,!?:;&/•—–;\\-])';

  // 3. Unwrap double-asterisk and single-asterisk bold
  transformedText = transformedText.replace(
    new RegExp(`${boundaryBefore}\\*\\*([^\\s*\\n](?:[^*\\n]*[^\\s*\\n])?)\\*\\*${boundaryAfter}`, 'gm'),
    '$1'
  );
  transformedText = transformedText.replace(
    new RegExp(`${boundaryBefore}\\*([^\\s*\\n](?:[^*\\n]*[^\\s*\\n])?)\\*${boundaryAfter}`, 'gm'),
    '$1'
  );

  // 4. Unwrap italic
  transformedText = transformedText.replace(
    new RegExp(`${boundaryBefore}_([^\\s_\\n](?:[^_\\n]*[^\\s_\\n])?)_${boundaryAfter}`, 'gm'),
    '$1'
  );

  // 5. Unwrap strikethrough
  transformedText = transformedText.replace(
    new RegExp(`${boundaryBefore}~~([^\\s~\\n](?:[^~\\n]*[^\\s~\\n])?)~~${boundaryAfter}`, 'gm'),
    '$1'
  );
  transformedText = transformedText.replace(
    new RegExp(`${boundaryBefore}~([^\\s~\\n](?:[^~\\n]*[^\\s~\\n])?)~${boundaryAfter}`, 'gm'),
    '$1'
  );

  return transformedText;
}

export class ConsoleMessageFormatter implements ChannelMessageFormatter {
  public readonly channelName = 'console' as const;

  public format(sourceText: string): string {
    return formatConsolePlainText(sourceText);
  }
}
