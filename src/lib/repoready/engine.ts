import type { Chunk, Gap, RepoSnapshot, SetupCommand } from "./types.ts";

const STOP = new Set([
  "a", "an", "the", "how", "do", "does", "did", "i", "to", "and", "or", "of", "this", "that", "it", "is", "are",
  "what", "where", "when", "why", "can", "for", "my", "me", "in", "on", "with", "be", "from", "about", "please",
  "you", "your", "we", "should", "not", "into", "using", "use", "file", "files", "repo", "repository",
]);

function contentTerms(query: string): string[] {
  return [
    ...new Set(
      (query.toLowerCase().match(/\w+/g) ?? []).filter((term) => term.length > 1 && !STOP.has(term)),
    ),
  ];
}

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
  const terms = contentTerms(query);
  if (terms.length === 0) return [];
  const chunks: Chunk[] = [];
  for (const [path, content] of Object.entries(files)) {
    const lines = content.split("\n");
    const pathBoost = terms.some((term) => path.toLowerCase().includes(term)) ? 2 : 0;
    for (let i = 0; i < lines.length; i += 12) {
      const slice = lines.slice(i, i + 16);
      const text = slice.join("\n").toLowerCase();
      const hits = terms.filter((term) => text.includes(term)).length;
      if (hits === 0 && pathBoost === 0) continue;
      chunks.push({
        path,
        startLine: i + 1,
        endLine: Math.min(i + slice.length, lines.length),
        content: slice.join("\n"),
        score: pathBoost + hits,
      });
    }
  }
  return chunks.sort((a, b) => b.score - a.score).slice(0, topK);
}

export function answerQuestion(files: Record<string, string>, query: string): { answer: string; chunks: Chunk[] } {
  const terms = contentTerms(query);
  const chunks = retrieve(files, query, 4);
  if (terms.length === 0 || chunks.length === 0) {
    return {
      answer: "Insufficient evidence in the indexed files. Ask about a file, command, or topic that appears in the repository.",
      chunks: [],
    };
  }
  const commands = analyzeSetup(files).filter(
    (item) => (item.status === "Documented" || item.status === "Configured") && commandMatches(item.command, terms),
  );
  if (commands.length > 0) {
    const lines = ["From the indexed files:"];
    for (const item of commands.slice(0, 4)) {
      lines.push(`- ${item.command} (${item.source}, ${item.status.toLowerCase()}, not executed)`);
    }
    return { answer: lines.join("\n"), chunks };
  }
  const top = chunks[0];
  if (!top) {
    return { answer: "Insufficient evidence in the indexed files.", chunks: [] };
  }
  const excerpt = top.content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");
  return {
    answer: `No command in the index matches this question. Closest passage is ${top.path}:L${top.startLine}-L${top.endLine}: ${excerpt}`,
    chunks,
  };
}

function commandMatches(command: string, terms: string[]): boolean {
  const lower = command.toLowerCase();
  return terms.some((term) => {
    if (lower.includes(term)) return true;
    if (term.startsWith("test") && /\b(pytest|tox|unittest|npm test|pnpm test)\b/.test(lower)) return true;
    if (term.startsWith("install") && /\b(install|pip|npm|poetry|uv)\b/.test(lower)) return true;
    if ((term === "run" || term === "start" || term === "running") && /\b(python|flask|uvicorn|node|npm start)\b/.test(lower)) {
      return true;
    }
    return false;
  });
}

const COMMAND = /(?:pip3?|python3?|pytest|npm|pnpm|yarn|make|tox|docker|cargo|go|uv)[ \t]+\S[^\n]*/i;
const BARE = /^(pytest|npm test|pnpm test|yarn test|cargo test|go test|tox)$/i;

export function analyzeSetup(files: Record<string, string>): SetupCommand[] {
  const found: SetupCommand[] = [];
  const seen = new Set<string>();
  const push = (item: SetupCommand) => {
    const key = `${item.status}:${item.command}:${item.source}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(item);
  };

  for (const [path, content] of Object.entries(files)) {
    const lines = content.split("\n");
    const documented = /readme|contributing|docs\//i.test(path);
    lines.forEach((line, index) => {
      const match = line.match(COMMAND) ?? (BARE.test(line.trim()) ? [line.trim()] : null);
      if (!match || !documented) return;
      const command = (match[0] ?? "").trim();
      if (command.length < 4) return;
      push({
        command,
        source: `${path}:L${index + 1}`,
        status: "Documented",
        prerequisites: prerequisites(command),
        note: "Not executed.",
      });
    });
    for (const block of fencedCommands(content)) {
      if (!documented) continue;
      push({
        command: block.command,
        source: `${path}:L${block.line}`,
        status: "Documented",
        prerequisites: prerequisites(block.command),
        note: "Not executed.",
      });
    }
  }

  const packageFile = files["package.json"];
  const scripts = packageFile ? packageScripts(packageFile) : [];
  for (const script of scripts) {
    push({
      command: `npm run ${script.name}`,
      source: "package.json",
      status: "Configured",
      prerequisites: ["Node.js"],
      note: script.command,
    });
  }
  for (const [path, content] of Object.entries(files)) {
    if (path.toLowerCase().endsWith("makefile")) {
      for (const target of makefileTargets(content)) {
        push({
          command: `make ${target.name}`,
          source: `${path}:L${target.line}`,
          status: "Configured",
          prerequisites: [],
          note: "Not executed.",
        });
      }
    }
    if (path.toLowerCase().includes(".github/workflows/") && /\.(yml|yaml)$/i.test(path)) {
      for (const step of workflowRuns(content)) {
        push({
          command: step.command,
          source: `${path}:L${step.line}`,
          status: "Configured",
          prerequisites: prerequisites(step.command),
          note: "CI step. Not executed.",
        });
      }
    }
    if (path.endsWith("pyproject.toml") && /pytest/i.test(content)) {
      push({
        command: "pytest",
        source: path,
        status: "Configured",
        prerequisites: ["Python"],
        note: "pytest is configured. Not executed.",
      });
    }
  }

  const hasPackage = Boolean(packageFile);
  for (const item of found) {
    if (item.status !== "Documented" || !hasPackage) continue;
    const scriptName = npmScriptName(item.command);
    if (scriptName && !scripts.some((script) => script.name === scriptName)) {
      item.status = "Conflicting";
      item.note = `Documented as "${item.command}", but package.json has no "${scriptName}" script. Not executed.`;
    }
  }

  const hasTestCommand = found.some(
    (item) => item.status !== "Conflicting" && /\b(test|pytest|tox)\b/i.test(item.command),
  );
  const testFiles = Object.keys(files).filter((path) => /test|spec/i.test(path));
  if (!hasTestCommand && testFiles.length > 0) {
    const command = inferTestCommand(files);
    push({
      command,
      source: testFiles[0] ?? "tests",
      status: "Inferred",
      prerequisites: prerequisites(command),
      note: "Guessed from test files. It is not written as a command in the indexed files, and it was not executed.",
    });
  }

  for (const [path, content] of Object.entries(files)) {
    if (!/readme/i.test(path)) continue;
    const lines = content.split("\n");
    lines.forEach((line, index) => {
      if (!/^#{1,3}\s+tests?\s*$/i.test(line.trim())) return;
      const window = lines.slice(index + 1, index + 7);
      if (window.some((entry) => COMMAND.test(entry) || BARE.test(entry.trim()))) return;
      push({
        command: "No command under the Tests heading",
        source: `${path}:L${index + 1}`,
        status: "Not Verified",
        prerequisites: [],
        note: "The heading does not give a command. Nothing was executed.",
      });
    });
  }

  return found;
}

function fencedCommands(content: string): Array<{ command: string; line: number }> {
  const lines = content.split("\n");
  const commands: Array<{ command: string; line: number }> = [];
  let open = false;
  lines.forEach((line, index) => {
    if (/^```/.test(line)) {
      open = !open;
      return;
    }
    if (!open) return;
    const match = line.match(COMMAND) ?? (BARE.test(line.trim()) ? [line.trim()] : null);
    if (!match) return;
    commands.push({ command: (match[0] ?? "").trim(), line: index + 1 });
  });
  return commands;
}

function packageScripts(content: string): Array<{ name: string; command: string }> {
  try {
    const parsed = JSON.parse(content) as { scripts?: Record<string, unknown> };
    return Object.entries(parsed.scripts ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([name, command]) => ({ name, command }));
  } catch {
    return [];
  }
}

function makefileTargets(content: string): Array<{ name: string; line: number }> {
  return content
    .split("\n")
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^[A-Za-z0-9_.-]+:/.test(line) && !line.startsWith("."))
    .map(({ line, index }) => ({ name: line.split(":")[0] ?? "", line: index + 1 }))
    .filter((item) => item.name.length > 0);
}

function workflowRuns(content: string): Array<{ command: string; line: number }> {
  const found: Array<{ command: string; line: number }> = [];
  const lines = content.split("\n");
  lines.forEach((line, index) => {
    const match = line.match(/^\s*(?:-\s*)?run:\s*(.+)$/);
    const command = match?.[1]?.trim().replace(/^['"]|['"]$/g, "");
    if (!command || command === "|" || command === ">") return;
    found.push({ command, line: index + 1 });
  });
  return found;
}

function npmScriptName(command: string): string | null {
  const test = command.trim().match(/^npm(?:\s+run)?\s+test\b/);
  if (test) return "test";
  const run = command.trim().match(/^npm\s+run\s+([A-Za-z0-9:_-]+)/);
  return run?.[1] ?? null;
}

function inferTestCommand(files: Record<string, string>): string {
  const paths = Object.keys(files);
  if (paths.some((path) => path.endsWith(".py") || path.endsWith("requirements.txt") || path.endsWith("pyproject.toml"))) {
    return "pytest";
  }
  if (paths.some((path) => path.endsWith("Cargo.toml"))) return "cargo test";
  if (paths.some((path) => path.endsWith("go.mod"))) return "go test ./...";
  if (paths.includes("package.json")) return "npm test";
  return "the project's test command";
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
  const coverage = snapshot.stats.coverage;
  const gaps: Gap[] = [];
  const indexedReadme = paths.some((path) => /readme/i.test(path.split("/").pop() ?? path));
  const indexedTests = paths.some((path) => /test|spec/i.test(path));
  const commands = analyzeSetup(snapshot.files);
  const hasSetupCommand = commands.some(
    (item) => item.status === "Documented" || item.status === "Configured",
  );

  if (coverage) {
    if (!coverage.readme) {
      gaps.push(
        coverage.complete && !coverage.truncated
          ? {
              severity: "high",
              category: "Missing documented setup",
              description: "No README was indexed, and every selected file was indexed.",
              evidence: "The indexed snapshot contains no README.",
            }
          : {
              severity: "medium",
              category: "README not indexed",
              description: "No README contents were indexed. The index is incomplete, so the repository may still have one.",
              evidence: snapshot.stats.limitations[0] ?? "Index was incomplete.",
            },
      );
    }
    if (!coverage.contributing) {
      gaps.push(
        coverage.complete && !coverage.truncated
          ? {
              severity: "medium",
              category: "Missing contributor guidance",
              description: "No CONTRIBUTING file was indexed, and every selected file was indexed.",
              evidence: "The indexed snapshot contains no CONTRIBUTING file.",
            }
          : {
              severity: "low",
              category: "Contributor guidance not proven",
              description: "No CONTRIBUTING file was indexed. The index is incomplete, so the file may still exist.",
              evidence: snapshot.stats.limitations[0] ?? "Index was incomplete.",
            },
      );
    }
    if (!coverage.tests && !indexedTests) {
      gaps.push(
        coverage.complete && !coverage.truncated
          ? {
              severity: "medium",
              category: "Missing test instructions",
              description: "No test file was indexed, and every selected file was indexed.",
              evidence: "The indexed snapshot contains no test or spec file.",
            }
          : {
              severity: "low",
              category: "Tests not proven",
              description: "No test file was indexed. The index is incomplete, so tests may still exist.",
              evidence: snapshot.stats.limitations[0] ?? "Index was incomplete.",
            },
      );
    }
  } else if (!indexedReadme) {
    gaps.push({
      severity: "high",
      category: "Missing documented setup",
      description: "No README was present in the indexed files. This does not prove the repository has none.",
      evidence: paths.slice(0, 6).join(", ") || "No files indexed",
    });
  }

  if (indexedReadme && !hasSetupCommand) {
    gaps.push({
      severity: "medium",
      category: "No setup command indexed",
      description: "The indexed files do not contain a documented or configured setup command.",
      evidence: "Searched README, manifests, task runners, and indexed CI files.",
    });
  }
  if (!coverage?.complete || coverage.truncated) {
    gaps.push({
      severity: "low",
      category: "Partial index",
      description: "Findings apply only to the retrieved tree and indexed files. A missing document may still exist outside that view.",
      evidence: snapshot.stats.limitations[0] ?? "Index was limited.",
    });
  }
  return gaps;
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
