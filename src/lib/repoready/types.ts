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

export type IndexCoverage = {
  truncated: boolean;
  complete: boolean;
  readme: boolean;
  contributing: boolean;
  tests: boolean;
};

export type RepoStats = {
  examined: number;
  indexed: number;
  skipped: number;
  limitations: string[];
  coverage: IndexCoverage;
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

export type CommandStatus =
  | "Documented"
  | "Configured"
  | "Inferred"
  | "Conflicting"
  | "Not Verified"
  | "Executed Successfully"
  | "Execution Failed";

export type SetupCommand = {
  command: string;
  source: string;
  status: CommandStatus;
  prerequisites: string[];
  note?: string;
};

export type ModelHealth = {
  available: boolean;
  model: string;
  baseUrl: string;
  detail: string;
};

export type AnswerOrigin = "model" | "insufficient" | "model-unavailable";

export type GroundedAnswer = {
  origin: AnswerOrigin;
  answer: string;
  chunks: Chunk[];
  warning?: string;
  model?: string;
};

export type PlanResult = {
  origin: "model" | "model-unavailable" | "insufficient";
  markdown: string;
  warning?: string;
  model?: string;
};

export type Gap = {
  severity: "high" | "medium" | "low";
  category: string;
  description: string;
  evidence: string;
};
