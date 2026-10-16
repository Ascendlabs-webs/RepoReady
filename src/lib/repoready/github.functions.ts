import { createServerFn } from "@tanstack/react-start";
import { parseGithubUrl } from "./engine";
import type { IssueItem, RepoSnapshot } from "./types";

const KEEP = [
  "readme.md",
  "readme",
  "contributing.md",
  "license",
  "pyproject.toml",
  "requirements.txt",
  "package.json",
  "makefile",
  "cargo.toml",
  "go.mod",
  "dockerfile",
];

type ContentItem = {
  type: string;
  name: string;
  path: string;
  size?: number;
  download_url?: string | null;
};

export const ingestGithubRepo = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const url = typeof input === "object" && input && "url" in input ? String((input as { url: unknown }).url) : "";
    if (!url || url.length > 300) throw new Error("Enter a GitHub repository URL.");
    return { url };
  })
  .handler(async ({ data }): Promise<RepoSnapshot> => {
    const { owner, repo } = parseGithubUrl(data.url);
    const repoJson = (await github(`/repos/${owner}/${repo}`)) as Record<string, unknown>;
    const branch = String(repoJson.default_branch ?? "main");
    const listingRaw = await github(`/repos/${owner}/${repo}/contents/?ref=${encodeURIComponent(branch)}`);
    const listing = Array.isArray(listingRaw) ? (listingRaw as ContentItem[]) : [];
    const chosen = listing
      .filter((item) => item.type === "file")
      .filter((item) => KEEP.includes(item.name.toLowerCase()) || item.name.toLowerCase().startsWith("readme"))
      .slice(0, 8);

    const files: Record<string, string> = {};
    let skipped = 0;
    const limitations: string[] = [
      "Only high-value files at the repository root were indexed. This is not a complete tree.",
    ];
    for (const item of chosen) {
      if ((item.size ?? 0) > 80_000) {
        skipped += 1;
        limitations.push(`Skipped large file: ${item.path}`);
        continue;
      }
      const text = item.download_url ? await readText(item.download_url) : null;
      if (text == null) {
        skipped += 1;
        continue;
      }
      files[item.path] = text.slice(0, 12_000);
    }

    let issues: IssueItem[] = [];
    try {
      const issueJson = (await github(
        `/repos/${owner}/${repo}/issues?state=open&per_page=8&sort=updated`,
      )) as Array<Record<string, unknown>>;
      issues = issueJson
        .filter((item) => !("pull_request" in item))
        .map((item) => ({
          number: Number(item.number),
          title: String(item.title ?? ""),
          body: String(item.body ?? "").slice(0, 1500),
          url: String(item.html_url ?? ""),
          labels: Array.isArray(item.labels)
            ? item.labels.map((label) =>
                typeof label === "object" && label && "name" in label
                  ? String((label as { name: unknown }).name)
                  : String(label),
              )
            : [],
        }));
    } catch {
      limitations.push("Open issues could not be loaded.");
    }

    const license = repoJson.license as { spdx_id?: string } | null;
    return {
      simulated: false,
      metadata: {
        name: String(repoJson.name ?? repo),
        fullName: String(repoJson.full_name ?? `${owner}/${repo}`),
        description: String(repoJson.description ?? "No description."),
        defaultBranch: branch,
        language: String(repoJson.language ?? "Unknown"),
        stars: typeof repoJson.stargazers_count === "number" ? repoJson.stargazers_count : null,
        license: license?.spdx_id ?? "None",
        htmlUrl: String(repoJson.html_url ?? `https://github.com/${owner}/${repo}`),
      },
      files,
      issues,
      stats: {
        examined: chosen.length,
        indexed: Object.keys(files).length,
        skipped,
        limitations,
      },
    };
  });

async function github(path: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "RepoReady",
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (response.status === 404) throw new Error("That repository was not found, or it is private.");
  if (response.status === 403) {
    throw new Error("GitHub rate limit reached. Try the offline sample, or wait and analyze again.");
  }
  if (!response.ok) throw new Error(`GitHub returned ${response.status}.`);
  return response.json();
}

async function readText(url: string): Promise<string | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) return null;
  return response.text();
}
