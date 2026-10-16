import { useEffect, useMemo, useState } from "react";
import { FileText, Search, ShieldCheck, GitPullRequest, AlertTriangle, Box } from "lucide-react";
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
  const [asking, setAsking] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [grounded, setGrounded] = useState<GroundedAnswer | null>(null);

  const commands = useMemo(() => analyzeSetup(snapshot.files), [snapshot]);
  const gaps = useMemo(() => documentationGaps(snapshot), [snapshot]);

  useEffect(() => {
    let cancelled = false;
    void modelHealth({ data: {} })
      .then((next) => {
        if (!cancelled) setHealth(next);
      })
      .catch(() => {
        if (!cancelled) {
          setHealth({
            available: false,
            model: "qwen3:4b",
            baseUrl: "http://127.0.0.1:11434",
            detail: "The model health check failed.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function ask() {
    setAsked(true);
    setAsking(true);
    setGrounded(null);
    try {
      setGrounded(await askRepository({ data: { question, files: snapshot.files } }));
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
      const result = await planRepository({ data: { snapshot, issueNumber } });
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

  return (
    <div className="min-h-screen bg-ink text-paper">
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-mono text-xs tracking-widest text-signal uppercase">Open-source onboarding</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">RepoReady</h1>
            <p className="mt-1 max-w-xl text-stone">From an unfamiliar repository to a first contribution.</p>
            <p className="mt-2 text-sm text-stone">
              {health
                ? health.available
                  ? `Model ${health.model} is connected.`
                  : `Model offline. ${health.detail}`
                : "Checking the local model…"}
            </p>
          </div>
          <div className="flex rounded-card border border-line bg-ink p-1" role="group" aria-label="Data source">
            <ModeButton active={mode === "sample"} onClick={() => setMode("sample")}>
              Offline sample
            </ModeButton>
            <ModeButton active={mode === "live"} onClick={() => setMode("live")}>
              Live GitHub
            </ModeButton>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        <form
          className="flex flex-col gap-3 sm:flex-row"
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
            placeholder="Paste a GitHub URL, for example https://github.com/pallets/flask"
            className="min-h-11 flex-1 rounded-card border border-line bg-panel px-4 text-paper outline-none placeholder:text-stone focus:border-signal disabled:opacity-70"
          />
          <button
            type="submit"
            disabled={busy}
            className="min-h-11 rounded-card bg-signal px-5 font-medium text-signal-ink disabled:opacity-60"
          >
            {busy ? "Indexing…" : "Analyze repository"}
          </button>
        </form>

        {snapshot.simulated && mode === "sample" ? (
          <p className="mt-3 rounded-card border border-line bg-raised px-4 py-3 text-sm text-paper">
            Paste any public GitHub URL above to replace this fictional sample. The files below are not from GitHub.
          </p>
        ) : (
          <p className="mt-3 text-sm text-stone">
            {snapshot.simulated
              ? "That URL will be read from GitHub when you analyze it. Commands are never executed."
              : "Indexed from the public repository you pasted. Commands are never executed."}
          </p>
        )}
        {error ? (
          <p className="mt-3 rounded-card border border-signal bg-raised px-4 py-3 text-sm text-paper" role="alert">
            {error}
          </p>
        ) : null}

        <section className="mt-6 grid gap-3 sm:grid-cols-3">
          <Stat label="Repository" value={snapshot.metadata.fullName} />
          <Stat label="Language" value={snapshot.metadata.language} />
          <Stat label="Indexed files" value={String(snapshot.stats.indexed)} />
        </section>

        <div className="mt-6 flex gap-2 overflow-x-auto pb-1" role="tablist">
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
                  "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-card border px-4 text-sm " +
                  (selected
                    ? "border-signal bg-signal text-signal-ink"
                    : "border-line bg-panel text-paper")
                }
              >
                <Icon className="size-4" aria-hidden="true" />
                {item.label}
              </button>
            );
          })}
        </div>

        <div className="mt-4" role="tabpanel">
          {tab === "overview" ? (
            <Overview snapshot={snapshot} openFile={openFile} onOpen={setOpenFile} />
          ) : null}
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
          {tab === "gaps" ? (
            <Gaps
              gaps={gaps}
              onDownload={() => download("doc-gaps.md", gapReport(snapshot))}
            />
          ) : null}
        </div>
      </main>
    </div>
  );
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
        "min-h-11 rounded-lg px-4 text-sm " +
        (active ? "bg-signal text-signal-ink" : "text-stone")
      }
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-line bg-panel px-4 py-3">
      <p className="text-xs tracking-wide text-stone uppercase">{label}</p>
      <p className="mt-1 truncate font-medium">{value}</p>
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
  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
      <div className="rounded-card border border-line bg-panel p-3">
        <p className="px-2 pb-2 text-xs tracking-wide text-stone uppercase">Indexed files</p>
        <ul className="space-y-1">
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
                <span className="truncate font-mono">{path}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="rounded-card border border-line bg-panel p-4">
        <p className="text-sm text-stone">{snapshot.metadata.description}</p>
        <p className="mt-2 font-mono text-xs text-stone">
          {snapshot.stats.examined} examined · {snapshot.stats.indexed} indexed · {snapshot.stats.skipped} skipped
          {snapshot.metadata.license ? ` · ${snapshot.metadata.license}` : ""}
        </p>
        <ul className="mt-3 space-y-1 text-sm text-stone">
          {snapshot.stats.limitations.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        {openFile && snapshot.files[openFile] ? (
          <pre className="mt-4 overflow-x-auto rounded-lg bg-ink p-4 font-mono text-xs leading-6 text-paper">
            {numbered(snapshot.files[openFile])}
          </pre>
        ) : (
          <p className="mt-4 text-sm text-stone">No file is selected.</p>
        )}
      </div>
    </div>
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
      <p className="text-sm text-stone">{label}</p>
      <form
        className="mt-3 flex flex-col gap-3 sm:flex-row"
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
          className="min-h-11 flex-1 rounded-card border border-line bg-ink px-4 outline-none focus:border-signal"
        />
        <button
          type="submit"
          disabled={asking}
          className="min-h-11 rounded-card bg-signal px-5 font-medium text-signal-ink disabled:opacity-60"
        >
          {asking ? "Asking…" : "Ask"}
        </button>
      </form>
      {!asked ? <p className="mt-4 text-sm text-stone">Ask about install steps, tests, or a file.</p> : null}
      {asked && answer ? (
        <div className="mt-4 rounded-lg border border-line bg-ink p-4" role="status">
          <p className="text-xs tracking-wide text-stone uppercase">
            {origin === "model" ? "Model answer" : "Evidence"}
          </p>
          <p className="mt-2 text-sm leading-6 whitespace-pre-wrap">{answer}</p>
          {warning ? <p className="mt-3 text-sm text-signal">{warning}</p> : null}
        </div>
      ) : null}
      <ul className="mt-4 space-y-3">
        {evidence.map((chunk) => (
          <li key={`${chunk.path}-${chunk.startLine}`} className="rounded-lg border border-line bg-ink p-3">
            <p className="font-mono text-xs text-signal">
              [{chunk.path}:L{chunk.startLine}-L{chunk.endLine}]
            </p>
            <pre className="mt-2 overflow-x-auto font-mono text-xs leading-6 whitespace-pre-wrap">{chunk.content}</pre>
          </li>
        ))}
      </ul>
    </div>
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
          <p className="font-mono text-sm">{command.command}</p>
          <p className="mt-2 text-sm text-stone">
            {command.status} · {command.source}
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
          <p className="mt-2 text-sm text-stone">{issue.body}</p>
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
        <pre className="mt-4 overflow-x-auto rounded-lg bg-ink p-4 font-mono text-xs leading-6 whitespace-pre-wrap">
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
          <article key={gap.category} className="rounded-card border border-line bg-panel p-4">
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

function numbered(content: string): string {
  return content
    .split("\n")
    .slice(0, 80)
    .map((line, index) => `${String(index + 1).padStart(3, " ")}  ${line}`)
    .join("\n");
}
