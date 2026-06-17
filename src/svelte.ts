import { OffsetRange } from './types';

export interface SvelteVirtualScript {
  text: string;
  scriptRanges: OffsetRange[];
  markupExpressionRanges: OffsetRange[];
}

const scriptTagPattern = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;

export function createSvelteVirtualScript(source: string): SvelteVirtualScript {
  const scriptRanges: OffsetRange[] = [];
  const markupExpressionRanges: OffsetRange[] = [];
  const virtualChars: string[] = Array.from(source, (char) => (char === '\n' || char === '\r' ? char : ' '));

  for (const match of source.matchAll(scriptTagPattern)) {
    const scriptStart = (match.index ?? 0) + match[0].indexOf(match[2]);
    const scriptEnd = scriptStart + match[2].length;
    scriptRanges.push({ start: scriptStart, end: scriptEnd });

    for (let offset = scriptStart; offset < scriptEnd; offset += 1) {
      virtualChars[offset] = source[offset] ?? ' ';
    }
  }

  collectMarkupExpressions(source, scriptRanges, markupExpressionRanges);

  return {
    text: virtualChars.join(''),
    scriptRanges,
    markupExpressionRanges
  };
}

function collectMarkupExpressions(
  source: string,
  scriptRanges: OffsetRange[],
  markupExpressionRanges: OffsetRange[]
) {
  let index = 0;

  while (index < source.length) {
    if (isInsideRange(index, scriptRanges)) {
      index = scriptRanges.find((range) => index >= range.start && index < range.end)?.end ?? index + 1;
      continue;
    }

    if (source[index] !== '{') {
      index += 1;
      continue;
    }

    const expressionStart = index + 1;
    const end = findMatchingBrace(source, index);
    if (end === -1) {
      index += 1;
      continue;
    }

    markupExpressionRanges.push({ start: expressionStart, end });
    index = end + 1;
  }
}

function findMatchingBrace(source: string, openBrace: number): number {
  let depth = 0;
  let quote: string | undefined;

  for (let index = openBrace; index < source.length; index += 1) {
    const char = source[index];
    const previous = source[index - 1];

    if (quote) {
      if (char === quote && previous !== '\\') {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function isInsideRange(offset: number, ranges: OffsetRange[]) {
  return ranges.some((range) => offset >= range.start && offset < range.end);
}
