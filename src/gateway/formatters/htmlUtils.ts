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
