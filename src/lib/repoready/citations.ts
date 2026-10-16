const CITE = /\[([^\]\n:]+):L(\d+)(?:-L(\d+))?\]/g;

export type Citation = { path: string; startLine: number; endLine: number; raw: string };

export function extractCitations(text: string): Citation[] {
  const found: Citation[] = [];
  for (const match of text.matchAll(CITE)) {
    const path = match[1]?.trim() ?? "";
    const startLine = Number(match[2]);
    const endLine = match[3] ? Number(match[3]) : startLine;
    found.push({ path, startLine, endLine, raw: match[0] });
  }
  return found;
}

export function lineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.split("\n").length;
}

export function validateCitations(
  text: string,
  files: Record<string, string>,
): { valid: boolean; invalid: string[] } {
  const citations = extractCitations(text);
  if (citations.length === 0) return { valid: false, invalid: ["no citations"] };
  const invalid: string[] = [];
  for (const cite of citations) {
    const content = files[cite.path];
    if (content == null) {
      invalid.push(cite.raw);
      continue;
    }
    const lines = lineCount(content);
    if (
      !Number.isInteger(cite.startLine) ||
      !Number.isInteger(cite.endLine) ||
      cite.startLine < 1 ||
      cite.endLine < cite.startLine ||
      cite.endLine > lines
    ) {
      invalid.push(cite.raw);
    }
  }
  return { valid: invalid.length === 0, invalid };
}

export function unknownRecommendedPaths(markdown: string, files: Record<string, string>): string[] {
  const known = new Set(Object.keys(files));
  const unknown = new Set<string>();
  const ticks = markdown.matchAll(/`([^`\n]+)`/g);
  for (const match of ticks) {
    const token = match[1]?.trim() ?? "";
    if (!token || token.startsWith("http") || token.includes(" ")) continue;
    if (/^(npm|pnpm|yarn|pip|pytest|python|cargo|go|make|docker)\b/.test(token)) continue;
    const looksLikePath = token.includes("/") || /\.[a-z0-9]{1,5}$/i.test(token);
    if (looksLikePath && !known.has(token)) unknown.add(token);
  }
  return [...unknown];
}
