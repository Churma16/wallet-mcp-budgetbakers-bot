export const CHAT_MARKUP_BOUNDARY_BEFORE = '(?<=^|[\\s([{<"\'“‘/•—–;\\-])';
export const CHAT_MARKUP_BOUNDARY_AFTER = '(?=$|[\\s)\\]}>"\'”’.,!?:;&/•—–;\\-])';

/**
 * Single-pass HTML entity decoder to eliminate double-unescaping vulnerabilities.
 */
export function decodeHtmlEntities(sourceText: string): string {
  if (!sourceText) {
    return '';
  }

  return sourceText.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => {
    switch (entity) {
      case '&amp;':
        return '&';
      case '&lt;':
        return '<';
      case '&gt;':
        return '>';
      case '&quot;':
        return '"';
      case '&#39;':
        return "'";
      default:
        return entity;
    }
  });
}

/**
 * Iteratively removes HTML tags until a clean fixed point is reached,
 * preventing nested tag bypasses (e.g. <<script>script>).
 */
export function stripHtmlTags(sourceText: string): string {
  if (!sourceText) {
    return '';
  }

  let sanitized = sourceText;
  let previous: string;
  do {
    previous = sanitized;
    sanitized = sanitized.replace(/<[^<>]*>/g, '');
  } while (sanitized !== previous);

  return sanitized;
}

/**
 * Replaces text enclosed by standard chat markup delimiters (*, **, _, ~, ~~)
 * safely checking delimiter boundaries and non-whitespace edges.
 */
export function replaceDelimitedMarkup(
  sourceText: string,
  delimiter: string,
  replacer: (innerContent: string) => string
): string {
  if (!sourceText) {
    return '';
  }

  const escapedDelimiter = delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const innerExcluded = delimiter[0] === '*' ? '*' : delimiter[0] === '_' ? '_' : '~';
  const pattern = new RegExp(
    `${CHAT_MARKUP_BOUNDARY_BEFORE}${escapedDelimiter}([^\\s${innerExcluded}\\n](?:[^${innerExcluded}\\n]*[^\\s${innerExcluded}\\n])?)${escapedDelimiter}${CHAT_MARKUP_BOUNDARY_AFTER}`,
    'gm'
  );

  return sourceText.replace(pattern, (_match, innerContent) => replacer(innerContent));
}
