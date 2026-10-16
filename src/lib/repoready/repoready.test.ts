import assert from "node:assert/strict";
import test from "node:test";
import { validateCitations } from "./citations.ts";
import { analyzeSetup, documentationGaps, parseGithubUrl, retrieve } from "./engine.ts";
import { answerWithModel } from "./grounded.ts";
import { ingestRepository } from "./ingest.ts";
import { planIndex } from "./indexer.ts";
import { OllamaError, checkModel, generateText } from "./ollama.ts";
import { evidencePlan, planWithModel } from "./planner.ts";
import { SAMPLE_REPO } from "./sample.ts";
import type { RepoSnapshot } from "./types.ts";

test("parseGithubUrl accepts owner and repo and rejects other hosts", () => {
  assert.deepEqual(parseGithubUrl("https://github.com/pallets/flask.git"), { owner: "pallets", repo: "flask" });
  assert.throws(() => parseGithubUrl("https://gitlab.com/a/b"), /github.com/);
  assert.throws(() => parseGithubUrl("https://github.com/only-owner"), /owner and the repository/);
});

test("planIndex keeps nested source and drops secrets, binaries, and dependencies", () => {
  const plan = planIndex(
    [
      { path: "README.md", type: "blob", size: 20 },
      { path: "src/app.py", type: "blob", size: 20 },
      { path: "tests/test_app.py", type: "blob", size: 20 },
      { path: "node_modules/leftpad/index.js", type: "blob", size: 20 },
      { path: ".env", type: "blob", size: 8 },
      { path: "assets/logo.png", type: "blob", size: 8 },
      { path: "package-lock.json", type: "blob", size: 8 },
      { path: ".github/workflows/ci.yml", type: "blob", size: 20 },
    ],
    false,
  );
  const paths = plan.selected.map((item) => item.path);
  assert.ok(paths.includes("src/app.py"));
  assert.ok(paths.includes("tests/test_app.py"));
  assert.ok(paths.includes(".github/workflows/ci.yml"));
  assert.equal(paths.some((path) => path.includes("node_modules") || path.endsWith(".png") || path === ".env"), false);
  assert.equal(plan.coverage.tests, true);
  assert.equal(plan.coverage.readme, true);
});

test("ingestRepository reads nested files and reports a rate limit", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/repos/acme/widget")) {
      return Response.json({
        name: "widget",
        full_name: "acme/widget",
        description: "demo",
        default_branch: "main",
        language: "Python",
        stargazers_count: 1,
        html_url: "https://github.com/acme/widget",
        license: { spdx_id: "MIT" },
      });
    }
    if (url.includes("/git/trees/")) {
      return Response.json({
        truncated: false,
        tree: [
          { path: "README.md", type: "blob", size: 40 },
          { path: "pkg/main.py", type: "blob", size: 40 },
          { path: "secret.env", type: "blob", size: 4 },
        ],
      });
    }
    if (url.includes("/issues?")) return Response.json([]);
    if (url.includes("raw.githubusercontent.com") && url.endsWith("/README.md")) return new Response("# Widget\npip install -r requirements.txt\n");
    if (url.includes("raw.githubusercontent.com") && url.endsWith("/pkg/main.py")) return new Response("print('ok')\n");
    return new Response("no", { status: 404 });
  };
  const snapshot = await ingestRepository("https://github.com/acme/widget", fetchImpl);
  assert.equal(snapshot.simulated, false);
  assert.equal(snapshot.files["pkg/main.py"], "print('ok')\n");
  assert.equal(snapshot.files["secret.env"], undefined);
  assert.equal(snapshot.stats.coverage.complete, true);

  const limited: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/repos/acme/widget")) return new Response("slow", { status: 403 });
    return new Response("no", { status: 500 });
  };
  await assert.rejects(() => ingestRepository("https://github.com/acme/widget", limited), /rate limit/);
});

test("retrieve keeps line numbers and prefers the matching passage", () => {
  const files = {
    "docs/guide.md": ["# Guide", "intro", "Install the service with cargo build", "tail"].join("\n"),
    "src/lib.rs": "fn main() {}\n",
  };
  const chunks = retrieve(files, "How do I install the service?");
  assert.equal(chunks[0]?.path, "docs/guide.md");
  assert.equal(chunks[0]?.startLine, 1);
  assert.ok(chunks[0]?.content.includes("cargo build"));
  assert.equal(retrieve(files, "kubernetes helm").length, 0);
});

test("validateCitations rejects unknown paths and bad ranges", () => {
  const files = { "README.md": "one\ntwo\nthree\n" };
  assert.equal(validateCitations("See [README.md:L1-L2].", files).valid, true);
  assert.equal(validateCitations("See [README.md:L1-L9].", files).valid, false);
  assert.equal(validateCitations("See [missing.ts:L1-L1].", files).valid, false);
  assert.equal(validateCitations("No cite.", files).invalid[0], "no citations");
});

test("ollama reports unavailable, timeout, and malformed responses", async () => {
  const down: typeof fetch = async () => {
    throw Object.assign(new Error("refused"), { name: "TimeoutError" });
  };
  const health = await checkModel(down);
  assert.equal(health.available, false);
  assert.match(health.detail, /timed out/);

  const missing: typeof fetch = async () => Response.json({ models: [{ name: "llama3:8b" }] });
  assert.match((await checkModel(missing)).detail, /not pulled/);

  const ready: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "qwen3:4b" }] });
    if (init?.method === "POST") return Response.json({});
    return new Response("no", { status: 500 });
  };
  await assert.rejects(() => generateText("hi", ready), (error: unknown) => {
    assert.ok(error instanceof OllamaError);
    assert.equal(error.code, "malformed");
    return true;
  });

  const timeout: typeof fetch = async () => {
    throw Object.assign(new Error("slow"), { name: "TimeoutError" });
  };
  await assert.rejects(() => generateText("hi", timeout), (error: unknown) => error instanceof OllamaError && error.code === "timeout");
});

test("answerWithModel does not call the model without evidence and labels outages", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return Response.json({ models: [{ name: "qwen3:4b" }] });
  };
  const empty = await answerWithModel({ "README.md": "# Nothing relevant\n" }, "kubernetes operators", fetchImpl);
  assert.equal(empty.origin, "insufficient");
  assert.equal(calls, 0);

  const offline: typeof fetch = async () => {
    throw Object.assign(new Error("down"), { name: "Error" });
  };
  const files = { "README.md": "# App\n\n## Installation\npip install -r requirements.txt\n" };
  const answer = await answerWithModel(files, "How do I install this?", offline);
  assert.equal(answer.origin, "model-unavailable");
  assert.match(answer.warning ?? "", /not a model answer/);
  assert.match(answer.answer, /pip install -r requirements.txt/);
});

test("answerWithModel retries one invalid citation", async () => {
  const files = { "README.md": "# App\n\n## Installation\npip install -r requirements.txt\n" };
  let posts = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/api/tags")) return Response.json({ models: [{ name: "qwen3:4b" }] });
    posts += 1;
    if (posts === 1) return Response.json({ response: "Use magic [nope.py:L1-L1]." });
    return Response.json({ response: "Install with pip [README.md:L4-L4]." });
  };
  const answer = await answerWithModel(files, "How do I install this?", fetchImpl);
  assert.equal(posts, 2);
  assert.equal(answer.origin, "model");
  assert.equal(answer.warning, undefined);
  assert.match(answer.answer, /\[README.md:L4-L4\]/);
});

test("setup commands are classified and never marked executed", () => {
  const files = {
    "README.md": "# App\n\n## Tests\n\nRun the suite.\n",
    "package.json": JSON.stringify({ scripts: { lint: "eslint ." } }),
    "src/main.ts": "export const ready = true;\n",
    "tests/main.test.ts": "test('ready', () => {});\n",
    "Makefile": "lint:\n\teslint .\n",
  };
  const commands = analyzeSetup(files);
  assert.equal(commands.some((item) => item.status === "Executed Successfully" || item.status === "Execution Failed"), false);
  assert.ok(commands.some((item) => item.command === "npm run lint" && item.status === "Configured"));
  assert.ok(commands.some((item) => item.command === "make lint" && item.status === "Configured"));
  assert.ok(commands.some((item) => item.status === "Inferred"));
  assert.ok(commands.some((item) => item.status === "Not Verified"));

  const conflict = analyzeSetup({
    "README.md": "npm test\n",
    "package.json": JSON.stringify({ scripts: { build: "tsc" } }),
  });
  assert.ok(conflict.some((item) => item.status === "Conflicting" && item.command.includes("npm")));
});

test("evidence plans stay repository-specific and do not invent a stack", () => {
  const snapshot: RepoSnapshot = {
    simulated: false,
    metadata: { ...SAMPLE_REPO.metadata, fullName: "acme/widget", language: "Go" },
    files: { "cmd/widget/main.go": "package main\n// version flag is not implemented\nfunc main() {}\n" },
    issues: [{ number: 7, title: "Add a version flag", body: "Print the version when --version is passed.", url: "", labels: [] }],
    stats: {
      examined: 1,
      indexed: 1,
      skipped: 0,
      limitations: [],
      coverage: { truncated: false, complete: true, readme: false, contributing: false, tests: false },
    },
  };
  const plan = evidencePlan(snapshot, 7).markdown;
  assert.match(plan, /Not generated by a model/);
  assert.match(plan, /cmd\/widget\/main.go/);
  assert.equal(plan.includes("app.py"), false);
  assert.equal(plan.includes("Flask"), false);
  assert.equal(plan.includes("plain text or JSON"), false);
});

test("documentation gaps do not claim a file is missing when the tree was truncated", () => {
  const snapshot: RepoSnapshot = {
    ...SAMPLE_REPO,
    simulated: false,
    files: { "src/main.py": "print('hi')\n" },
    stats: {
      examined: 3,
      indexed: 1,
      skipped: 2,
      limitations: ["GitHub truncated the repository tree, so some paths were never seen."],
      coverage: { truncated: true, complete: false, readme: false, contributing: false, tests: false },
    },
  };
  const gaps = documentationGaps(snapshot);
  assert.equal(gaps.some((gap) => /no README path was present/i.test(gap.description)), false);
  assert.ok(gaps.some((gap) => gap.category === "Partial index"));
});

test("offline sample is labeled fictional and is not described as model output", () => {
  assert.equal(SAMPLE_REPO.simulated, true);
  const plan = evidencePlan(SAMPLE_REPO, 1);
  assert.match(plan.markdown, /Not generated by a model/);
  assert.equal(plan.markdown.includes("Debug mode"), false);
  const gaps = documentationGaps(SAMPLE_REPO);
  assert.equal(gaps.some((gap) => /fetched from GitHub/i.test(gap.description)), false);
});

test("planWithModel keeps a verification warning when citations stay invalid", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/api/tags")) return Response.json({ models: [{ name: "qwen3:4b" }] });
    if (init?.method === "POST") return Response.json({ response: "Change `missing.go` [missing.go:L1-L9]." });
    return new Response("no", { status: 404 });
  };
  const result = await planWithModel(SAMPLE_REPO, 1, fetchImpl);
  assert.equal(result.origin, "model");
  assert.match(result.warning ?? "", /Verification warning/);
});
