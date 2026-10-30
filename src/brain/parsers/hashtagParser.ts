/**
 * Utility for parsing and normalizing explicit hashtag tokens (#tag)
 * from user input and transaction notes.
 */

// Unified token pattern matching explicit hashtags preceded by boundary, followed by optional punctuation then whitespace/end
const HASHTAG_TOKEN_REGEX = /(^|[\s([{\<])#([a-zA-Z0-9_\-]+)([.,!?;:)\]}>]*)(?=\s|$)/g;

/**
 * Normalizes a single tag name by stripping leading '#' and trimming whitespace.
 */
export function normalizeTagName(tag: string): string {
  return tag.replace(/^#+/, '').trim();
}

/**
 * Case-insensitively deduplicates tag names while preserving the casing of the first occurrence.
 */
export function deduplicateTags(tags: string[]): string[] {
  const seenLowercase = new Set<string>();
  const uniqueTagList: string[] = [];

  for (const rawTag of tags) {
    const cleanedTag = normalizeTagName(rawTag);
    if (!cleanedTag) {
      continue;
    }

    const lowercaseKey = cleanedTag.toLowerCase();
    if (!seenLowercase.has(lowercaseKey)) {
      seenLowercase.add(lowercaseKey);
      uniqueTagList.push(cleanedTag);
    }
  }

  return uniqueTagList;
}

export interface ExtractedHashtagsResult {
  tags: string[];
  cleanedText: string;
}

/**
 * Extracts explicit hashtag tokens from text and returns both the normalized unique tags
 * and the cleaned text with hashtag tokens stripped.
 * Note text is removed if and only if the exact token was recognized as a hashtag.
 */
export function extractHashtags(sourceText: string): ExtractedHashtagsResult {
  if (!sourceText || typeof sourceText !== 'string') {
    return { tags: [], cleanedText: '' };
  }

  const rawExtractedTags: string[] = [];

  // Single-pass replacement: tokens are removed if and only if they are recognized as hashtags
  const cleanedWithSpaces = sourceText.replace(
    HASHTAG_TOKEN_REGEX,
    (_fullMatch, prefix, tagName) => {
      rawExtractedTags.push(tagName);
      return prefix ? ' ' : '';
    }
  );

  const uniqueTags = deduplicateTags(rawExtractedTags);

  // Clean the text by tidying residual empty brackets, whitespace, and punctuation
  const collapsedText = cleanedWithSpaces
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/ ([,.:;?!])/g, '$1');

  // Strip leading and trailing punctuation and whitespace safely without regex backtracking
  const punctuationCharSet = new Set([',', ';', ':', '—', '-']);
  let startIdx = 0;
  let endIdx = collapsedText.length;

  while (
    startIdx < endIdx &&
    (collapsedText.charCodeAt(startIdx) <= 32 || punctuationCharSet.has(collapsedText[startIdx]))
  ) {
    startIdx++;
  }

  while (
    endIdx > startIdx &&
    (collapsedText.charCodeAt(endIdx - 1) <= 32 || punctuationCharSet.has(collapsedText[endIdx - 1]))
  ) {
    endIdx--;
  }

  const cleanedText = collapsedText.slice(startIdx, endIdx);

  return {
    tags: uniqueTags,
    cleanedText,
  };
}
