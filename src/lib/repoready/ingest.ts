import { parseGithubUrl } from "./engine.ts";
import { LIMITS, coverageFromIndexed, planIndex, type TreeEntry } from "./indexer.ts";
import type { IssueItem, RepoSnapshot } from "./types.ts";

type GithubRepo = {
  name?: string;
  full_name?: string;
  description?: string | null;
  default_branch?: string;
  language?: string | null;
  stargazers_count?: number;
  html_url?: string;
  license?: { spdx_id?: string | null } | null;
};

export async function ingestRepository(url: string, fetchImpl: typeof fetch = fetch): Promise<RepoSnapshot> {
  const { owner, repo } = parseGithubUrl(url);
  const repoJson = (await github(fetchImpl, `/repos/${owner}/${repo}`)) as GithubRepo;
  const branch = repoJson.default_branch || "main";
  const treeJson = (await github(
    fetchImpl,
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  )) as { tree?: TreeEntry[]; truncated?: boolean };
  const plan = planIndex(treeJson.tree ?? [], Boolean(treeJson.truncated));
  const files: Record<string, string> = {};
  const limitations = [...plan.limitations];
  let total = 0;
  let skipped = plan.skipped;
  let downloadFailed = false;
  let contentTruncated = false;
  let characterBudgetHit = false;
  let processed = 0;
  for (const choice of plan.selected) {
    const remaining = LIMITS.maxTotalChars - total;
    if (remaining <= 0) {
      characterBudgetHit = true;
      skipped += plan.selected.length - processed;
      limitations.push("Stopped indexing because the total context limit was reached.");
      break;
    }
    processed += 1;
    try {
      const text = await readRaw(fetchImpl, owner, repo, branch, choice.path);
      const fileCap = Math.min(LIMITS.maxFileChars, remaining);
      const slice = text.slice(0, fileCap);
      if (slice.length < text.length) {
        contentTruncated = true;
        if (fileCap < LIMITS.maxFileChars) {
          characterBudgetHit = true;
          limitations.push(
            `Truncated ${choice.path} to ${slice.length} characters to stay within the total context limit.`,
          );
        } else {
          limitations.push(`Truncated ${choice.path} to ${LIMITS.maxFileChars} characters.`);
        }
      }
      files[choice.path] = slice;
      total += slice.length;
      if (characterBudgetHit) {
        const rest = plan.selected.length - processed;
        if (rest > 0) {
          skipped += rest;
          limitations.push("Stopped indexing because the total context limit was reached.");
        }
        break;
      }
    } catch {
      downloadFailed = true;
      skipped += 1;
      limitations.push(`Could not read ${choice.path}.`);
    }
  }
  const stoppedEarly = processed < plan.selected.length;

  let issues: IssueItem[] = [];
  try {
    const issueJson = (await github(
      fetchImpl,
      `/repos/${owner}/${repo}/issues?state=open&per_page=8&sort=updated`,
    )) as Array<Record<string, unknown>>;
    issues = (Array.isArray(issueJson) ? issueJson : [])
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

  return {
    simulated: false,
    metadata: {
      name: String(repoJson.name ?? repo),
      fullName: String(repoJson.full_name ?? `${owner}/${repo}`),
      description: String(repoJson.description ?? "No description."),
      defaultBranch: branch,
      language: String(repoJson.language ?? "Unknown"),
      stars: typeof repoJson.stargazers_count === "number" ? repoJson.stargazers_count : null,
      license: repoJson.license?.spdx_id ?? "None",
      htmlUrl: String(repoJson.html_url ?? `https://github.com/${owner}/${repo}`),
    },
    files,
    issues,
    stats: {
      examined: plan.examined,
      indexed: Object.keys(files).length,
      skipped,
      limitations,
      coverage: coverageFromIndexed({
        indexedPaths: Object.keys(files),
        treeTruncated: plan.coverage.truncated,
        fileCountCapped: plan.fileCountCapped,
        characterBudgetHit,
        downloadFailed,
        contentTruncated,
        stoppedEarly,
        oversizedSkipped: plan.oversizedSkipped,
      }),
    },
  };
}

async function github(fetchImpl: typeof fetch, path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "RepoReady",
      },
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new Error("GitHub did not respond in time.");
  }
  if (response.status === 404) throw new Error("That repository was not found, or it is private.");
  if (response.status === 403 || response.status === 429) {
    throw new Error("GitHub rate limit reached. Try the offline sample, or wait and analyze again.");
  }
  if (!response.ok) throw new Error(`GitHub returned ${response.status}.`);
  return response.json();
}

async function readRaw(fetchImpl: typeof fetch, owner: string, repo: string, branch: string, path: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "RepoReady" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Could not read ${path}.`);
  return response.text();
}
