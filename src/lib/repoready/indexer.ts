import type { IndexCoverage } from "./types.ts";

export const LIMITS = {
  maxFiles: 24,
  maxFileBytes: 80_000,
  maxFileChars: 12_000,
  maxTotalChars: 96_000,
};

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  "vendor",
  "venv",
  ".venv",
  "__pycache__",
  ".next",
  "out",
  "target",
  "bin",
  "obj",
  ".idea",
  ".vscode",
  "site-packages",
]);

const BINARY_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "pdf",
  "zip",
  "gz",
  "tgz",
  "woff",
  "woff2",
  "mp4",
  "mp3",
  "wasm",
  "exe",
  "dll",
  "so",
  "dylib",
  "class",
  "jar",
  "lock",
]);

const SOURCE_EXT = new Set([
  "py",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "go",
  "rs",
  "java",
  "rb",
  "php",
  "c",
  "h",
  "cc",
  "cpp",
  "cs",
  "swift",
  "kt",
  "scala",
  "lua",
  "sh",
]);

const DOC_EXT = new Set(["md", "rst", "txt", "adoc"]);

export type TreeEntry = { path: string; type: string; size?: number };

export type IndexChoice = {
  path: string;
  score: number;
  size: number;
};

export type IndexPlan = {
  selected: IndexChoice[];
  skipped: number;
  limitations: string[];
  coverage: IndexCoverage;
  examined: number;
  fileCountCapped: boolean;
  oversizedSkipped: boolean;
};

function baseName(path: string): string {
  return path.split("/").pop()?.toLowerCase() ?? path.toLowerCase();
}

function extension(path: string): string {
  const base = baseName(path);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1);
}

export function isSkippedPath(path: string): string | null {
  const lower = path.toLowerCase();
  const parts = lower.split("/");
  if (parts.some((part) => SKIP_DIRS.has(part))) return "ignored directory";
  const base = baseName(lower);
  if (base.endsWith(".min.js") || base.endsWith(".map") || base.endsWith(".lock")) return "generated file";
  if (base === "package-lock.json" || base === "yarn.lock" || base === "pnpm-lock.yaml") return "lockfile";
  if (/(^|\/)\.env($|\.)/.test(lower) || /(^|\/)(id_rsa|id_ed25519|credentials\.json)$/.test(lower)) {
    return "credential";
  }
  if (/\.(pem|key|p12|pfx)$/.test(lower)) return "credential";
  if (BINARY_EXT.has(extension(lower))) return "binary";
  return null;
}

export function pathPriority(path: string): number | null {
  if (isSkippedPath(path)) return null;
  const lower = path.toLowerCase();
  const base = baseName(lower);
  if (base === "readme" || base.startsWith("readme.")) return 100;
  if (base.startsWith("contributing")) return 96;
  if (base === "license" || base.startsWith("license.") || base === "copying") return 90;
  if (
    [
      "package.json",
      "pyproject.toml",
      "requirements.txt",
      "cargo.toml",
      "go.mod",
      "gemfile",
      "composer.json",
      "pom.xml",
      "build.gradle",
      "setup.py",
      "setup.cfg",
    ].includes(base)
  ) {
    return 88;
  }
  if (base === "makefile" || base === "dockerfile" || base === "justfile" || base === "taskfile.yml") return 84;
  if (lower.includes(".github/workflows/") && (lower.endsWith(".yml") || lower.endsWith(".yaml"))) return 80;
  if (lower.includes("/test/") || lower.includes("/tests/") || lower.startsWith("test") || base.includes("test") || base.includes("spec")) {
    return 72;
  }
  const ext = extension(lower);
  if (SOURCE_EXT.has(ext)) return 55;
  if (DOC_EXT.has(ext)) return 40;
  if (["toml", "yml", "yaml", "ini", "cfg", "json"].includes(ext)) return 36;
  return null;
}

export function isTestPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.includes("/test/") || lower.includes("/tests/") || baseName(lower).includes("test") || baseName(lower).includes("spec");
}

export function coverageFromIndexed(input: {
  indexedPaths: string[];
  treeTruncated: boolean;
  fileCountCapped: boolean;
  characterBudgetHit: boolean;
  downloadFailed: boolean;
  contentTruncated: boolean;
  stoppedEarly: boolean;
  oversizedSkipped: boolean;
}): IndexCoverage {
  const incomplete =
    input.treeTruncated ||
    input.fileCountCapped ||
    input.characterBudgetHit ||
    input.downloadFailed ||
    input.contentTruncated ||
    input.stoppedEarly ||
    input.oversizedSkipped;
  return {
    truncated: input.treeTruncated,
    complete: !incomplete,
    readme: input.indexedPaths.some((path) => baseName(path).startsWith("readme")),
    contributing: input.indexedPaths.some((path) => baseName(path).startsWith("contributing")),
    tests: input.indexedPaths.some((path) => isTestPath(path)),
  };
}

export function planIndex(entries: TreeEntry[], truncated: boolean): IndexPlan {
  const blobs = entries.filter((entry) => entry.type === "blob" && entry.path);
  const limitations: string[] = [];
  if (truncated) limitations.push("GitHub truncated the repository tree, so some paths were never seen.");
  let skipped = 0;
  const ranked: IndexChoice[] = [];
  for (const entry of blobs) {
    const reason = isSkippedPath(entry.path);
    const score = pathPriority(entry.path);
    if (reason || score == null) {
      skipped += 1;
      continue;
    }
    if ((entry.size ?? 0) > LIMITS.maxFileBytes) {
      skipped += 1;
      if (limitations.filter((item) => item.startsWith("Skipped large file")).length < 5) {
        limitations.push(`Skipped large file: ${entry.path}`);
      }
      continue;
    }
    ranked.push({ path: entry.path, score, size: entry.size ?? 0 });
  }
  ranked.sort((a, b) => b.score - a.score || a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));
  const selected = ranked.slice(0, LIMITS.maxFiles);
  if (ranked.length > selected.length) {
    skipped += ranked.length - selected.length;
    limitations.push(`Indexed ${selected.length} of ${ranked.length} candidate files.`);
  }
  const fileCountCapped = ranked.length > selected.length;
  const oversizedSkipped = limitations.some((item) => item.startsWith("Skipped large file"));
  return {
    selected,
    skipped,
    limitations,
    examined: blobs.length,
    fileCountCapped,
    oversizedSkipped,
    coverage: coverageFromIndexed({
      indexedPaths: [],
      treeTruncated: truncated,
      fileCountCapped,
      characterBudgetHit: false,
      downloadFailed: false,
      contentTruncated: false,
      stoppedEarly: false,
      oversizedSkipped,
    }),
  };
}
