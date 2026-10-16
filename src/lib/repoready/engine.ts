import type { Chunk, Gap, RepoSnapshot, SetupCommand } from "./types";

const COMMAND = /(?:pip3?|python3?|pytest|npm|yarn|pnpm|make|tox|docker)\s+[^\n]+/gi;

export function parseGithubUrl(raw: string): { owner: string; repo: string } {
  const trimmed = raw.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("That is not a valid URL.");
  }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    throw new Error("Only github.com repository URLs are supported.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("Include both the owner and the repository name.");
  const owner = parts[0] ?? "";
  const repo = parts[1] ?? "";
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
    throw new Error("The owner or repository name is not valid.");
  }
  return { owner, repo };
}

export function retrieve(files: Record<string, string>, query: string, topK = 6): Chunk[] {
  const terms = new Set(query.toLowerCase().match(/\w+/g) ?? []);
  if (terms.size === 0) return [];
  const chunks: Chunk[] = [];
  for (const [path, content] of Object.entries(files)) {
    const lines = content.split("\n");
    const pathBoost = [...terms].some((term) => path.toLowerCase().includes(term)) ? 4 : 0;
    for (let i = 0; i < lines.length; i += 12) {
      const slice = lines.slice(i, i + 16);
      const text = slice.join("\n").toLowerCase();
      const score = pathBoost + [...terms].filter((term) => text.includes(term)).length;
      if (score > 0) {
        chunks.push({
          path,
          startLine: i + 1,
          endLine: Math.min(i + slice.length, lines.length),
          content: slice.join("\n"),
          score,
        });
      }
    }
  }
  return chunks.sort((a, b) => b.score - a.score).slice(0, topK);
}

export function setupCommands(files: Record<string, string>): SetupCommand[] {
  const found: SetupCommand[] = [];
  const seen = new Set<string>();
  for (const [path, content] of Object.entries(files)) {
    const lines = content.split("\n");
    lines.forEach((line, index) => {
      const match = line.match(COMMAND);
      if (!match) return;
      for (const raw of match) {
        const command = raw.trim();
        if (command.length < 4 || seen.has(command)) continue;
        seen.add(command);
        const documented = /readme|contributing/i.test(path);
        found.push({
          command,
          source: `${path}:L${index + 1}`,
          status: documented ? "Documented" : "Configured",
          prerequisites: prerequisites(command),
        });
      }
    });
  }
  return found;
}

function prerequisites(command: string): string[] {
  const lower = command.toLowerCase();
  const list: string[] = [];
  if (lower.includes("pip") || lower.startsWith("python") || lower.includes("pytest")) list.push("Python");
  if (/\b(npm|yarn|pnpm)\b/.test(lower)) list.push("Node.js");
  if (lower.includes("docker")) list.push("Docker");
  return list;
}

export function documentationGaps(snapshot: RepoSnapshot): Gap[] {
  const paths = Object.keys(snapshot.files);
  const gaps: Gap[] = [];
  const hasReadme = paths.some((path) => /readme/i.test(path));
  const hasContributing = paths.some((path) => /contributing/i.test(path));
  const hasTests = paths.some((path) => /test/i.test(path));
  if (!hasReadme) {
    gaps.push({
      severity: "high",
      category: "Missing documented setup",
      description: "No README was present in the indexed files.",
      evidence: paths.slice(0, 6).join(", ") || "No files indexed",
    });
  }
  if (!hasContributing) {
    gaps.push({
      severity: "medium",
      category: "Missing contributor guidance",
      description: "No CONTRIBUTING file was indexed.",
      evidence: "Searched indexed paths for CONTRIBUTING.",
    });
  }
  if (!hasTests) {
    gaps.push({
      severity: "medium",
      category: "Missing test instructions",
      description: "No test file or pytest mention was indexed.",
      evidence: "Searched indexed paths for test files.",
    });
  }
  if (snapshot.stats.limitations.length > 0 && !snapshot.simulated) {
    gaps.push({
      severity: "low",
      category: "Partial index",
      description: "Some files were not indexed. A missing document may still exist in the repository.",
      evidence: snapshot.stats.limitations[0] ?? "Index was limited.",
    });
  }
  return gaps;
}

export function contributionPlan(snapshot: RepoSnapshot, issueNumber: number): string {
  const issue = snapshot.issues.find((item) => item.number === issueNumber);
  if (!issue) return "That issue is not in the loaded list.";
  const chunks = retrieve(snapshot.files, `${issue.title} ${issue.body}`, 4);
  const files = [...new Set(chunks.map((chunk) => chunk.path))];
  const cites = chunks
    .map((chunk) => `- [${chunk.path}:L${chunk.startLine}-L${chunk.endLine}] score ${chunk.score}`)
    .join("\n");
  const label = snapshot.simulated ? "Sample plan. Not generated by a model." : "Evidence plan. Local model generation is not connected in this preview.";
  return `# Contribution plan for #${issue.number}

${label}

## Problem summary
${issue.title}

## Explicitly stated
${issue.body || "The issue has no description."}

## Relevant files
${files.length ? files.map((path) => `- ${path}`).join("\n") : "- No file in the index clearly matches this issue."}

## Evidence
${cites || "- Insufficient indexed evidence to name a file."}

## Likely checks
- Reproduce the behavior described in the issue before editing code.
- ${files.includes("tests/test_app.py") ? "Extend tests/test_app.py with a request to the new route." : "Add or update a test that covers the reported behavior."}

## Suggested sequence
1. Read the cited files.
2. Confirm the current routes or entry points.
3. Make the smallest change that matches the issue text.
4. Run the documented test command. Do not treat a documented command as already executed.

## Risks
- A new route can collide with an existing path.
- Debug mode in app.py is not a production setting.

## Definition of done
- The behavior named in the issue is covered by a test.
- Existing tests still describe the current routes.

## Questions for maintainers
- Should the response body be plain text or JSON?
- Is there an existing convention for health routes that was not indexed?
`;
}

export function gapReport(snapshot: RepoSnapshot): string {
  const gaps = documentationGaps(snapshot);
  const header = snapshot.simulated
    ? "# Documentation gap report\n\nSample repository. Findings apply only to the fictional index.\n"
    : "# Documentation gap report\n\nFindings apply only to files that were indexed.\n";
  if (gaps.length === 0) return `${header}\nNo significant onboarding gaps in the indexed files.\n`;
  return (
    header +
    gaps
      .map(
        (gap) =>
          `## ${gap.category} (${gap.severity})\n${gap.description}\n\nEvidence: ${gap.evidence}\n`,
      )
      .join("\n")
  );
}
