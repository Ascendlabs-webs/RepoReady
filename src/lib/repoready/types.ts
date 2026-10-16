export type RepoMetadata = {
  name: string;
  fullName: string;
  description: string;
  defaultBranch: string;
  language: string;
  stars: number | null;
  license: string;
  htmlUrl: string;
};

export type IssueItem = {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
};

export type RepoStats = {
  examined: number;
  indexed: number;
  skipped: number;
  limitations: string[];
};

export type RepoSnapshot = {
  simulated: boolean;
  metadata: RepoMetadata;
  files: Record<string, string>;
  issues: IssueItem[];
  stats: RepoStats;
};

export type Chunk = {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
};

export type SetupCommand = {
  command: string;
  source: string;
  status: "Documented" | "Configured";
  prerequisites: string[];
};

export type Gap = {
  severity: "high" | "medium" | "low";
  category: string;
  description: string;
  evidence: string;
};
