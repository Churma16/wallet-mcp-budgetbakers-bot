import { applicationLogger } from '../../utils/logger.js';

/**
 * Extracts the content of the first triple-backtick code fence using linear index scanning
 * (avoids `[\s\S]`-style quantifier backtracking). Returns null when no closing fence exists.
 */
function extractMarkdownCodeFenceContent(rawText: string): string | null {
  const fenceMarker = '```';
  const fenceOpenIndex = rawText.indexOf(fenceMarker);
  if (fenceOpenIndex === -1) {
    return null;
  }

  const contentStartIndex = fenceOpenIndex + fenceMarker.length;
  const fenceCloseIndex = rawText.indexOf(fenceMarker, contentStartIndex);
  if (fenceCloseIndex === -1) {
    return null;
  }

  let extractedContent = rawText.slice(contentStartIndex, fenceCloseIndex).trim();
  const firstLineBreakIndex = extractedContent.indexOf('\n');
  const openingLabelLine = (firstLineBreakIndex === -1
    ? extractedContent
    : extractedContent.slice(0, firstLineBreakIndex)).trim();

  if (/^json$/i.test(openingLabelLine)) {
    extractedContent = firstLineBreakIndex === -1 ? '' : extractedContent.slice(firstLineBreakIndex).trim();
  }

  return extractedContent;
}

/**
 * Robustly extracts and parses a JSON object from arbitrary LLM response text.
 * Strips reasoning tokens (<think>...</think>), markdown code blocks, and extraneous chatter.
 */
export function extractAndParseJsonObject<T>(rawResponseText: string): T {
  let sanitizedText = rawResponseText.trim();

  // Strip DeepSeek / reasoning thoughts block if present: <think>...</think>
  sanitizedText = sanitizedText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // Check if enclosed inside markdown code block
  const extractedFenceContent = extractMarkdownCodeFenceContent(sanitizedText);
  if (extractedFenceContent !== null) {
    sanitizedText = extractedFenceContent;
  }

  // Fast path direct JSON parse
  try {
    return JSON.parse(sanitizedText) as T;
  } catch {
    // Fallback: extract the first contiguous JSON object matching { ... }
    const firstBraceIndex = sanitizedText.indexOf('{');
    const lastBraceIndex = sanitizedText.lastIndexOf('}');

    if (firstBraceIndex !== -1 && lastBraceIndex !== -1 && lastBraceIndex > firstBraceIndex) {
      const extractedJsonSubstring = sanitizedText.substring(firstBraceIndex, lastBraceIndex + 1);
      try {
        return JSON.parse(extractedJsonSubstring) as T;
      } catch (parseError: unknown) {
        const errorMessage = parseError instanceof Error ? parseError.message : String(parseError);
        applicationLogger.fileDetail('error', 'Failed substring JSON parse attempt', {
          errorMessage,
          extractedJsonSubstring,
        });
        throw new Error(`Unable to parse JSON from AI response: ${errorMessage}`);
      }
    }

    throw new Error('No valid JSON object structure found in AI response');
  }
}
