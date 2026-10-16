import { useEffect, useMemo, useState } from "react";
import { FileText, Search, ShieldCheck, GitPullRequest, AlertTriangle, Box, GitBranch } from "lucide-react";
import { SAMPLE_REPO } from "@/lib/repoready/sample";
import { analyzeSetup, documentationGaps, gapReport } from "@/lib/repoready/engine";
import { ingestGithubRepo } from "@/lib/repoready/github.functions";
import { askRepository, modelHealth, planRepository } from "@/lib/repoready/model.functions";
import { evidencePlan } from "@/lib/repoready/planner";
import type { Chunk, GroundedAnswer, ModelHealth, RepoSnapshot } from "@/lib/repoready/types";

const TABS = [
  { id: "overview", label: "Overview", icon: Box },
  { id: "ask", label: "Ask", icon: Search },
  { id: "setup", label: "Setup", icon: ShieldCheck },
  { id: "contribute", label: "Contribute", icon: GitPullRequest },
  { id: "gaps", label: "Gaps", icon: AlertTriangle },
] as const;

type TabId = (typeof TABS)[number]["id"];

const ASK_PROMPTS = ["How do I install this and run the tests?", "Where does the app start?", "How are the tests run?"];

export function RepoReady() {
  const [mode, setMode] = useState<"sample" | "live">("sample");
  const [url, setUrl] = useState("");
  const [snapshot, setSnapshot] = useState<RepoSnapshot>(SAMPLE_REPO);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<TabId>("overview");
  const [question, setQuestion] = useState("How do I install this and run the tests?");
  const [asked, setAsked] = useState(false);
  const [issueNumber, setIssueNumber] = useState(SAMPLE_REPO.issues[0]?.number ?? 1);
  const [plan, setPlan] = useState("");
  const [openFile, setOpenFile] = useState<string | null>("README.md");
  const [health, setHealth] = useState<ModelHealth | null>(null);
  const [ollamaUrl, setOllamaUrl] = useState("http://127.0.0.1:11434");
  const [ollamaModel, setOllamaModel] = useState("qwen3:4b");
  const [asking, setAsking] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [grounded, setGrounded] = useState<GroundedAnswer | null>(null);
  const [modelOpen, setModelOpen] = useState(true);

  const commands = useMemo(() => analyzeSetup(snapshot.files), [snapshot]);
  const gaps = useMemo(() => documentationGaps(snapshot), [snapshot]);

  const ollama = { baseUrl: ollamaUrl.trim(), model: ollamaModel.trim() };

  useEffect(() => {
    void refreshHealth(ollama);
  }, []);

  async function refreshHealth(target = ollama) {
    try {
      setHealth(await modelHealth({ data: { ollama: target } }));
    } catch {
      setHealth({
        available: false,
        provider: "ollama",
        model: target.model || "qwen3:4b",
        baseUrl: target.baseUrl,
        detail: "The model health check failed.",
      });
    }
  }

  async function ask() {
    setAsked(true);
    setAsking(true);
    setGrounded(null);
    try {
      setGrounded(await askRepository({ data: { question, files: snapshot.files, ollama } }));
    } catch (cause) {
      setGrounded({
        origin: "model-unavailable",
        answer: "The question could not be sent to the model.",
        chunks: [],
        warning: cause instanceof Error ? cause.message : "The model request failed.",
      });
    } finally {
      setAsking(false);
    }
  }

  async function buildPlan() {
    setPlanning(true);
    try {
      const result = await planRepository({ data: { snapshot, issueNumber, ollama } });
      const warning = result.warning ? `\n\n## Verification\n${result.warning}\n` : "";
      setPlan(`${result.markdown}${warning}`);
    } catch (cause) {
      const fallback = evidencePlan(snapshot, issueNumber);
      setPlan(`${fallback.markdown}\n\n## Verification\n${cause instanceof Error ? cause.message : "The model request failed."}\n`);
    } finally {
      setPlanning(false);
    }
  }

  async function analyze() {
    setError("");
    const trimmed = url.trim();
    const pastedGithub = /github\.com\//i.test(trimmed);
    if (!pastedGithub) {
      if (mode === "live") {
        setError("Paste a public GitHub repository URL, then analyze it.");
        return;
      }
      setSnapshot(SAMPLE_REPO);
      setIssueNumber(SAMPLE_REPO.issues[0]?.number ?? 1);
      setPlan("");
      setAsked(false);
      setGrounded(null);
      setOpenFile("README.md");
      setTab("overview");
      return;
    }
    setMode("live");
    setBusy(true);
    try {
      const next = await ingestGithubRepo({ data: { url: trimmed } });
      setSnapshot(next);
      setIssueNumber(next.issues[0]?.number ?? 0);
      setPlan("");
      setAsked(false);
      setGrounded(null);
      setOpenFile(Object.keys(next.files)[0] ?? null);
      setTab("overview");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The repository could not be loaded.");
    } finally {
      setBusy(false);
    }
  }

  function download(filename: string, text: string) {
    const blob = new Blob([text], { type: "text/markdown" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(href);
  }

  const hosted = health?.provider === "hosted";
  const modelLabel = !health ? "Checking" : health.available ? health.model : hosted ? "Offline" : "Local";

  return (
    <div className="min-h-screen bg-ink pb-24 text-paper">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-card border border-signal text-signal">
              <GitBranch className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="font-mono text-xs tracking-widest text-signal uppercase">Evidence first</p>
              <h1 className="text-xl font-semibold tracking-tight">RepoReady</h1>
            </div>
          </div>
          {hosted ? (
            <span className="inline-flex min-h-11 max-w-40 items-center gap-2 rounded-card border border-line bg-panel px-3 text-sm">
              <Dot on={Boolean(health?.available)} />
              <span className="truncate">{modelLabel}</span>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setModelOpen((open) => !open)}
              aria-expanded={modelOpen}
              className="inline-flex min-h-11 max-w-40 items-center gap-2 rounded-card border border-line bg-panel px-3 text-sm"
            >
              <Dot on={Boolean(health?.available)} />
              <span className="truncate">{modelLabel}</span>
            </button>
          )}
        </div>
        {hosted ? (
          <p className="mx-auto max-w-6xl px-4 pb-4 text-xs text-stone">
            {health?.available
              ? `${health.model} is running on this server.`
              : health?.detail}
          </p>
        ) : null}
        {!hosted && modelOpen ? (
          <form
            className="mx-auto max-w-6xl px-4 pb-4"
            onSubmit={(event) => {
              event.preventDefault();
              void refreshHealth();
            }}
          >
            <p className="mb-2 text-xs tracking-widest text-stone uppercase">Local model</p>
            <div className="grid gap-2 sm:grid-cols-[1fr_8rem_auto]">
              <input
                id="ollama-url"
                aria-label="Ollama URL"
                value={ollamaUrl}
                onChange={(event) => setOllamaUrl(event.target.value)}
                placeholder="http://127.0.0.1:11434"
                spellCheck={false}
                className="min-h-11 rounded-card border border-line bg-ink px-3 text-sm outline-none placeholder:text-stone focus:border-signal"
              />
              <input
                id="ollama-model"
                aria-label="Ollama model"
                value={ollamaModel}
                onChange={(event) => setOllamaModel(event.target.value)}
                placeholder="qwen3:4b"
                spellCheck={false}
                className="min-h-11 rounded-card border border-line bg-ink px-3 text-sm outline-none placeholder:text-stone focus:border-signal"
              />
              <button type="submit" className="min-h-11 rounded-card border border-line px-4 text-sm font-medium">
                Check model
              </button>
            </div>
            <p className="mt-2 text-xs text-stone">
              {health?.detail ?? "Checking the local model."} This run uses the model on this computer.
            </p>
          </form>
        ) : null}
      </header>

      <div className="sticky top-0 z-20 border-b border-line bg-ink">
        <div className="mx-auto max-w-6xl px-4 py-3">
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              void analyze();
            }}
          >
            <label className="sr-only" htmlFor="repo-url">
              GitHub repository URL
            </label>
            <input
              id="repo-url"
              value={url}
              onChange={(event) => {
                const next = event.target.value;
                setUrl(next);
                if (/github\.com\//i.test(next)) setMode("live");
              }}
              disabled={busy}
              placeholder="https://github.com/pallets/flask"
              className="min-h-11 flex-1 rounded-card border border-line bg-panel px-4 text-sm outline-none placeholder:text-stone focus:border-signal disabled:opacity-70"
            />
            <button
              type="submit"
              disabled={busy}
              className="min-h-11 rounded-card bg-signal px-5 text-sm font-medium text-signal-ink disabled:opacity-60"
            >
              {busy ? "Indexing…" : "Analyze"}
            </button>
          </form>
          <div className="mt-2 flex items-center justify-between gap-3">
            <div className="flex rounded-card border border-line bg-panel p-1" role="group" aria-label="Data source">
              <ModeButton active={mode === "sample"} onClick={() => setMode("sample")}>
                Sample
              </ModeButton>
              <ModeButton active={mode === "live"} onClick={() => setMode("live")}>
                Live GitHub
              </ModeButton>
            </div>
            <p className="hidden text-xs text-stone sm:block">Commands in a repository are never executed.</p>
          </div>
        </div>
        <div className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-2" role="tablist">
          {TABS.map((item) => {
            const Icon = item.icon;
            const selected = tab === item.id;
            return (
              <button
                key={item.id}
                role="tab"
                aria-selected={selected}
                onClick={() => setTab(item.id)}
                className={
                  "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-3 text-sm " +
                  (selected ? "bg-raised text-paper" : "text-stone")
                }
              >
                <Icon className="size-4" aria-hidden="true" />
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      <main className="mx-auto max-w-6xl px-4 py-5">
        {snapshot.simulated && mode === "sample" ? (
          <p className="mb-4 rounded-card border border-line bg-panel px-4 py-3 text-sm">
            This is a fictional sample. Paste a public GitHub URL to replace it.
          </p>
        ) : (
          <p className="mb-4 text-sm text-stone">
            {snapshot.simulated
              ? "That URL is read from GitHub when you analyze it."
              : `Indexed from ${snapshot.metadata.fullName}. Nothing in the repository was executed.`}
          </p>
        )}
        {error ? (
          <p className="mb-4 rounded-card border border-signal bg-panel px-4 py-3 text-sm" role="alert">
            {error}
          </p>
        ) : null}

        <section className="grid grid-cols-2 divide-x divide-y divide-line overflow-hidden rounded-card border border-line bg-panel sm:grid-cols-4 sm:divide-y-0">
          <Stat label="Repository" value={snapshot.metadata.fullName} />
          <Stat label="Language" value={snapshot.metadata.language || "Unknown"} />
          <Stat label="Indexed" value={`${snapshot.stats.indexed} files`} />
          <Stat label="Coverage" value={snapshot.stats.coverage.complete ? "Complete" : "Partial"} tone={snapshot.stats.coverage.complete ? "paper" : "signal"} />
        </section>

        <div className="mt-5" role="tabpanel">
          {tab === "overview" ? <Overview snapshot={snapshot} openFile={openFile} onOpen={setOpenFile} /> : null}
          {tab === "ask" ? (
            <Ask
              question={question}
              onQuestion={setQuestion}
              onAsk={() => void ask()}
              answer={grounded?.answer ?? ""}
              evidence={grounded?.chunks ?? []}
              asked={asked}
              asking={asking}
              origin={grounded?.origin ?? null}
              warning={grounded?.warning}
              simulated={snapshot.simulated}
            />
          ) : null}
          {tab === "setup" ? <Setup commands={commands} /> : null}
          {tab === "contribute" ? (
            <Contribute
              snapshot={snapshot}
              issueNumber={issueNumber}
              onIssue={setIssueNumber}
              plan={plan}
              onPlan={() => void buildPlan()}
              planning={planning}
              onDownload={() => download("contribution-plan.md", plan || evidencePlan(snapshot, issueNumber).markdown)}
            />
          ) : null}
          {tab === "gaps" ? <Gaps gaps={gaps} onDownload={() => download("doc-gaps.md", gapReport(snapshot))} /> : null}
        </div>
      </main>
    </div>
  );
}

function Dot({ on }: { on: boolean }) {
  return <span className={"size-2 shrink-0 rounded-full " + (on ? "bg-signal" : "bg-stone")} aria-hidden="true" />;
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "min-h-11 rounded-lg px-3 text-sm " + (active ? "bg-raised text-paper" : "text-stone")
      }
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

function Stat({ label, value, tone = "paper" }: { label: string; value: string; tone?: "paper" | "signal" }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <p className="text-xs tracking-wide text-stone uppercase">{label}</p>
      <p className={"mt-1 truncate text-sm font-medium " + (tone === "signal" ? "text-signal" : "text-paper")}>{value}</p>
    </div>
  );
}

function Overview({
  snapshot,
  openFile,
  onOpen,
}: {
  snapshot: RepoSnapshot;
  openFile: string | null;
  onOpen: (path: string) => void;
}) {
  const files = Object.keys(snapshot.files);
  const coverage = snapshot.stats.coverage;
  return (
    <div className="grid gap-3 lg:grid-cols-[16rem_1fr]">
      <div className="flex gap-2 overflow-x-auto lg:hidden">
        {files.map((path) => (
          <button
            key={path}
            type="button"
            onClick={() => onOpen(path)}
            className={
              "inline-flex min-h-11 max-w-56 shrink-0 items-center rounded-full border px-3 " +
              (openFile === path ? "border-signal bg-raised text-paper" : "border-line text-stone")
            }
          >
            <FileLabel path={path} />
          </button>
        ))}
      </div>
      <div className="hidden max-h-[36rem] overflow-y-auto rounded-card border border-line bg-panel p-2 lg:block">
        <p className="px-2 py-2 text-xs tracking-wide text-stone uppercase">Indexed files</p>
        <ul>
          {files.map((path) => (
            <li key={path}>
              <button
                type="button"
                onClick={() => onOpen(path)}
                className={
                  "flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm " +
                  (openFile === path ? "bg-raised text-paper" : "text-stone")
                }
              >
                <FileText className="size-4 shrink-0" aria-hidden="true" />
                <FileLabel path={path} />
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="min-w-0 rounded-card border border-line bg-panel p-4">
        <p className="text-sm leading-6">{snapshot.metadata.description}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Chip on={coverage.readme}>README</Chip>
          <Chip on={coverage.contributing}>Contributing</Chip>
          <Chip on={coverage.tests}>Tests</Chip>
          <Chip on={Boolean(snapshot.metadata.license)}>{snapshot.metadata.license || "No license"}</Chip>
        </div>
        <p className="mt-3 font-mono text-xs text-stone">
          {snapshot.stats.examined} examined · {snapshot.stats.indexed} indexed · {snapshot.stats.skipped} skipped
        </p>
        {snapshot.stats.limitations.length ? (
          <ul className="mt-3 space-y-1 text-sm text-stone">
            {snapshot.stats.limitations.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : null}
        {openFile && snapshot.files[openFile] ? (
          <CodeBlock path={openFile} content={snapshot.files[openFile]} />
        ) : (
          <p className="mt-4 text-sm text-stone">No file is selected.</p>
        )}
      </div>
    </div>
  );
}

function FileLabel({ path }: { path: string }) {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return <span className="truncate font-mono text-xs">{path}</span>;
  return (
    <span className="truncate font-mono text-xs">
      <span className="text-stone">{path.slice(0, slash + 1)}</span>
      {path.slice(slash + 1)}
    </span>
  );
}

function CodeBlock({ path, content }: { path: string; content: string }) {
  const lines = content.split("\n").slice(0, 80);
  return (
    <div className="mt-4 overflow-hidden rounded-lg bg-ink">
      <p className="border-b border-line px-4 py-2 font-mono text-xs text-stone">{path}</p>
      <div className="max-h-96 overflow-auto">
        <ol>
          {lines.map((line, index) => (
            <li key={`${path}-${index}`} className="flex font-mono text-xs leading-6">
              <span className="w-10 shrink-0 border-r border-line pr-2 text-right text-stone select-none">{index + 1}</span>
              <span className="px-3 whitespace-pre">{line || " "}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
function Chip({ on, children }: { on: boolean; children: string }) {
  return (
    <span
      className={
        "inline-flex min-h-8 items-center rounded-full border px-3 text-xs " +
        (on ? "border-signal text-signal" : "border-line text-stone")
      }
    >
      {children}
    </span>
  );
}

function Ask({
  question,
  onQuestion,
  onAsk,
  answer,
  evidence,
  asked,
  asking,
  origin,
  warning,
  simulated,
}: {
  question: string;
  onQuestion: (value: string) => void;
  onAsk: () => void;
  answer: string;
  evidence: Chunk[];
  asked: boolean;
  asking: boolean;
  origin: GroundedAnswer["origin"] | null;
  warning?: string;
  simulated: boolean;
}) {
  const label =
    origin === "model"
      ? "Model answer. Citations were checked against the index."
      : origin === "insufficient"
        ? "Insufficient evidence. The model was not asked to guess."
        : origin === "model-unavailable"
          ? "Not a model answer."
          : simulated
            ? "The sample is fictional. A connected model can answer from these files."
            : "A connected model answers only from the indexed files.";
  return (
    <div className="rounded-card border border-line bg-panel p-4">
      <p className="text-sm leading-6 text-stone">{label}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {ASK_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => onQuestion(prompt)}
            className={
              "min-h-11 rounded-full border px-3 text-left text-xs " +
              (question === prompt ? "border-signal text-paper" : "border-line text-stone")
            }
          >
            {prompt}
          </button>
        ))}
      </div>
      <form
        className="mt-3 flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          onAsk();
        }}
      >
        <label className="sr-only" htmlFor="question">
          Question
        </label>
        <input
          id="question"
          value={question}
          onChange={(event) => onQuestion(event.target.value)}
          className="min-h-11 flex-1 rounded-card border border-line bg-ink px-4 text-sm outline-none focus:border-signal"
        />
        <button
          type="submit"
          disabled={asking}
          className="min-h-11 rounded-card bg-signal px-5 text-sm font-medium text-signal-ink disabled:opacity-60"
        >
          {asking ? "Asking…" : "Ask"}
        </button>
      </form>
      {!asked ? <p className="mt-4 text-sm text-stone">Ask about install steps, tests, or a file.</p> : null}
      {asked && answer ? (
        <div className="mt-4 rounded-lg bg-ink p-4" role="status">
          <p className="text-xs tracking-wide text-stone uppercase">{origin === "model" ? "Model answer" : "Evidence"}</p>
          <CitedText text={answer} />
          {warning ? <p className="mt-3 text-sm text-signal">{warning}</p> : null}
        </div>
      ) : null}
      {evidence.length ? (
        <ul className="mt-4 space-y-3">
          {evidence.map((chunk) => (
            <li key={`${chunk.path}-${chunk.startLine}`} className="rounded-lg bg-ink p-3">
              <p className="font-mono text-xs text-signal">
                [{chunk.path}:L{chunk.startLine}-L{chunk.endLine}]
              </p>
              <pre className="mt-2 overflow-x-auto font-mono text-xs leading-6 whitespace-pre-wrap">{chunk.content}</pre>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function CitedText({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]+:L\d+-L\d+\])/g);
  return (
    <p className="mt-2 text-sm leading-6 whitespace-pre-wrap">
      {parts.map((part, index) =>
        part.startsWith("[") ? (
          <span key={index} className="font-mono text-signal">
            {part}
          </span>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </p>
  );
}

function Setup({ commands }: { commands: ReturnType<typeof analyzeSetup> }) {
  if (commands.length === 0) {
    return (
      <p className="rounded-card border border-line bg-panel p-4 text-sm text-stone">
        No setup or test command was found in the indexed files.
      </p>
    );
  }
  return (
    <ul className="space-y-3">
      {commands.map((command) => (
        <li key={command.source + command.command} className="rounded-card border border-line bg-panel p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-mono text-sm">{command.command}</p>
            <span
              className={
                "inline-flex min-h-8 items-center rounded-full border px-3 text-xs " +
                (command.status === "Not Verified" || command.status === "Conflicting"
                  ? "border-signal text-signal"
                  : "border-line text-stone")
              }
            >
              {command.status}
            </span>
          </div>
          <p className="mt-3 text-sm text-stone">
            {command.source}
            {command.prerequisites.length ? ` · Needs ${command.prerequisites.join(", ")}` : ""}
          </p>
          {command.note ? <p className="mt-1 text-xs text-stone">{command.note}</p> : null}
        </li>
      ))}
    </ul>
  );
}

function Contribute({
  snapshot,
  issueNumber,
  onIssue,
  plan,
  onPlan,
  planning,
  onDownload,
}: {
  snapshot: RepoSnapshot;
  issueNumber: number;
  onIssue: (value: number) => void;
  plan: string;
  onPlan: () => void;
  planning: boolean;
  onDownload: () => void;
}) {
  const issue = snapshot.issues.find((item) => item.number === issueNumber);
  return (
    <div className="rounded-card border border-line bg-panel p-4">
      {snapshot.issues.length === 0 ? (
        <p className="text-sm text-stone">No open issues were returned.</p>
      ) : (
        <label className="block text-sm text-stone">
          Issue
          <select
            value={issueNumber}
            onChange={(event) => onIssue(Number(event.target.value))}
            className="mt-2 min-h-11 w-full rounded-card border border-line bg-ink px-3 text-paper"
          >
            {snapshot.issues.map((item) => (
              <option key={item.number} value={item.number}>
                #{item.number} {item.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {issue ? (
        <div className="mt-4">
          <p className="font-medium">{issue.title}</p>
          <p className="mt-2 text-sm leading-6 text-stone">{issue.body}</p>
          {issue.labels.length ? <p className="mt-2 font-mono text-xs text-signal">{issue.labels.join(" · ")}</p> : null}
        </div>
      ) : null}
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={onPlan}
          disabled={planning}
          className="min-h-11 rounded-card bg-signal px-5 font-medium text-signal-ink disabled:opacity-60"
        >
          {planning ? "Writing plan…" : "Build plan from evidence"}
        </button>
        <button
          type="button"
          onClick={onDownload}
          className="min-h-11 rounded-card border border-line px-5 text-paper"
        >
          Download Markdown
        </button>
      </div>
      {plan ? (
        <pre className="mt-4 overflow-x-auto rounded-lg bg-ink p-4 text-sm leading-6 whitespace-pre-wrap">
          {plan}
        </pre>
      ) : null}
    </div>
  );
}

function Gaps({
  gaps,
  onDownload,
}: {
  gaps: ReturnType<typeof documentationGaps>;
  onDownload: () => void;
}) {
  return (
    <div className="space-y-3">
      {gaps.length === 0 ? (
        <p className="rounded-card border border-line bg-panel p-4 text-sm">
          No significant onboarding gap in the indexed files.
        </p>
      ) : (
        gaps.map((gap) => (
          <article
            key={gap.category}
            className={
              "rounded-card border bg-panel p-4 " + (gap.severity === "high" ? "border-signal" : "border-line")
            }
          >
            <p className="text-xs tracking-wide text-signal uppercase">{gap.severity}</p>
            <h2 className="mt-1 font-medium">{gap.category}</h2>
            <p className="mt-2 text-sm">{gap.description}</p>
            <p className="mt-2 text-sm text-stone">Evidence: {gap.evidence}</p>
          </article>
        ))
      )}
      <button type="button" onClick={onDownload} className="min-h-11 rounded-card border border-line px-5 text-sm">
        Download gap report
      </button>
    </div>
  );
}
