import assert from "node:assert/strict";
import test from "node:test";
import { validateCitations } from "./citations.ts";
import { analyzeSetup, documentationGaps, parseGithubUrl, retrieve } from "./engine.ts";
import { answerWithModel } from "./grounded.ts";
import { ingestRepository } from "./ingest.ts";
import { LIMITS, planIndex } from "./indexer.ts";
import { OllamaError, checkModel, generateText, hostedFromEnv, normalizeOllamaBaseUrl, requestTarget } from "./ollama.ts";
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
  assert.equal(plan.coverage.readme, false);
  assert.equal(plan.coverage.tests, false);
  assert.equal(plan.coverage.complete, true);
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
  assert.equal(snapshot.stats.coverage.readme, true);
  assert.equal(snapshot.stats.coverage.tests, false);

  const limited: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/repos/acme/widget")) return new Response("slow", { status: 403 });
    return new Response("no", { status: 500 });
  };
  await assert.rejects(() => ingestRepository("https://github.com/acme/widget", limited), /rate limit/);
});

function widgetFetch(options: {
  tree: Array<{ path: string; type: string; size?: number }>;
  truncated?: boolean;
  bodies?: Record<string, string>;
  fail?: string[];
}): typeof fetch {
  const failed = new Set(options.fail ?? []);
  return async (input) => {
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
      return Response.json({ truncated: Boolean(options.truncated), tree: options.tree });
    }
    if (url.includes("/issues?")) return Response.json([]);
    const marker = "/acme/widget/main/";
    const at = url.indexOf(marker);
    if (at !== -1) {
      const path = decodeURIComponent(url.slice(at + marker.length));
      if (failed.has(path)) return new Response("missing", { status: 404 });
      const body = options.bodies?.[path];
      if (body != null) return new Response(body);
    }
    return new Response("no", { status: 404 });
  };
}

test("coverage stays incomplete when a tree README never lands in the snapshot", async () => {
  const snapshot = await ingestRepository(
    "https://github.com/acme/widget",
    widgetFetch({
      tree: [
        { path: "README.md", type: "blob", size: 40 },
        { path: "src/app.py", type: "blob", size: 20 },
      ],
      bodies: { "src/app.py": "print('ok')\n" },
      fail: ["README.md"],
    }),
  );
  assert.equal(snapshot.files["README.md"], undefined);
  assert.equal(snapshot.files["src/app.py"], "print('ok')\n");
  assert.equal(snapshot.stats.coverage.readme, false);
  assert.equal(snapshot.stats.coverage.complete, false);
  assert.ok(snapshot.stats.limitations.some((item) => item.includes("Could not read README.md")));
  const gaps = documentationGaps(snapshot);
  assert.equal(gaps.some((gap) => gap.category === "Missing documented setup"), false);
  assert.ok(gaps.some((gap) => gap.category === "README not indexed"));
});

test("coverage is incomplete when file text or the character budget is cut short", async () => {
  const truncated = await ingestRepository(
    "https://github.com/acme/widget",
    widgetFetch({
      tree: [{ path: "README.md", type: "blob", size: 40 }],
      bodies: { "README.md": "a".repeat(LIMITS.maxFileChars + 25) },
    }),
  );
  assert.equal(truncated.files["README.md"]?.length, LIMITS.maxFileChars);
  assert.equal(truncated.stats.coverage.readme, true);
  assert.equal(truncated.stats.coverage.complete, false);
  assert.ok(truncated.stats.limitations.some((item) => item.startsWith("Truncated README.md")));

  const names = Array.from({ length: 9 }, (_, index) => `src/f${index}.py`);
  const body = "y".repeat(LIMITS.maxFileChars);
  const budget = await ingestRepository(
    "https://github.com/acme/widget",
    widgetFetch({
      tree: names.map((path) => ({ path, type: "blob", size: body.length })),
      bodies: Object.fromEntries(names.map((path) => [path, body])),
    }),
  );
  assert.equal(budget.stats.indexed, 8);
  assert.equal(budget.files["src/f8.py"], undefined);
  assert.equal(budget.stats.coverage.complete, false);
  assert.ok(budget.stats.limitations.some((item) => item.includes("total context limit")));

  const head = "L1 keep\n";
  const eight = Array.from({ length: 8 }, (_, index) => `src/a${index}.py`);
  const ninth = "src/a8.py";
  const eightBody = "b".repeat(11_250);
  const ninthBody = head + "z".repeat(12_000 - head.length);
  const partial = await ingestRepository(
    "https://github.com/acme/widget",
    widgetFetch({
      tree: [...eight, ninth].map((path) => ({
        path,
        type: "blob",
        size: path === ninth ? ninthBody.length : eightBody.length,
      })),
      bodies: {
        ...Object.fromEntries(eight.map((path) => [path, eightBody])),
        [ninth]: ninthBody,
      },
    }),
  );
  const stored = Object.values(partial.files).reduce((sum, text) => sum + text.length, 0);
  assert.equal(eightBody.length, 11_250);
  assert.equal(ninthBody.length, 12_000);
  assert.ok(stored <= LIMITS.maxTotalChars);
  assert.equal(stored, 96_000);
  assert.equal(partial.files[ninth]?.length, LIMITS.maxTotalChars - 8 * 11_250);
  assert.equal(partial.files[ninth]?.split("\n")[0], "L1 keep");
  assert.equal(partial.files[ninth]?.startsWith(ninthBody.slice(0, partial.files[ninth].length)), true);
  assert.equal(partial.stats.coverage.complete, false);
  assert.ok(partial.stats.limitations.some((item) => item.includes("total context limit")));
});

test("coverage is incomplete when the tree, file count, or a large file is capped", async () => {
  const names = Array.from({ length: 25 }, (_, index) => `src/f${String(index).padStart(2, "0")}.py`);
  const capped = await ingestRepository(
    "https://github.com/acme/widget",
    widgetFetch({
      tree: [
        { path: "README.md", type: "blob", size: 12 },
        ...names.map((path) => ({ path, type: "blob" as const, size: 12 })),
      ],
      bodies: {
        "README.md": "# Widget\n",
        ...Object.fromEntries(names.map((path) => [path, "x\n"])),
      },
    }),
  );
  assert.equal(capped.stats.indexed, LIMITS.maxFiles);
  assert.equal(capped.stats.coverage.complete, false);
  assert.equal(capped.stats.coverage.readme, true);
  assert.ok(capped.stats.limitations.some((item) => item.includes(`Indexed ${LIMITS.maxFiles} of`)));

  const partialTree = await ingestRepository(
    "https://github.com/acme/widget",
    widgetFetch({
      truncated: true,
      tree: [{ path: "README.md", type: "blob", size: 12 }],
      bodies: { "README.md": "# Widget\n" },
    }),
  );
  assert.equal(partialTree.files["README.md"], "# Widget\n");
  assert.equal(partialTree.stats.coverage.readme, true);
  assert.equal(partialTree.stats.coverage.truncated, true);
  assert.equal(partialTree.stats.coverage.complete, false);

  const oversized = await ingestRepository(
    "https://github.com/acme/widget",
    widgetFetch({
      tree: [
        { path: "README.md", type: "blob", size: LIMITS.maxFileBytes + 1 },
        { path: "src/app.py", type: "blob", size: 20 },
      ],
      bodies: { "src/app.py": "print('ok')\n", "README.md": "# should not be fetched\n" },
    }),
  );
  assert.equal(oversized.files["README.md"], undefined);
  assert.equal(oversized.files["src/app.py"], "print('ok')\n");
  assert.equal(oversized.stats.coverage.readme, false);
  assert.equal(oversized.stats.coverage.complete, false);
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
  const evidence = [{ path: "README.md", startLine: 1, endLine: 3 }];
  assert.equal(validateCitations("See [README.md:L1-L2].", files, evidence).valid, true);
  assert.equal(validateCitations("See [README.md:L1-L9].", files, evidence).valid, false);
  assert.equal(validateCitations("See [missing.ts:L1-L1].", files, evidence).valid, false);
  assert.equal(validateCitations("No cite.", files, evidence).invalid[0], "no citations");
});

test("validateCitations accepts only passages supplied to the model", () => {
  const files = {
    "README.md": "one\ntwo\nthree\nfour\nfive\n",
    "src/app.py": "print('indexed but not retrieved')\n",
  };
  const gapped = [
    { path: "README.md", startLine: 1, endLine: 2 },
    { path: "README.md", startLine: 4, endLine: 4 },
  ];
  assert.equal(validateCitations("See [src/app.py:L1-L1].", files, gapped).valid, false);
  assert.equal(validateCitations("See [README.md:L1-L2].", files, gapped).valid, true);
  assert.equal(validateCitations("See [README.md:L4-L4].", files, gapped).valid, true);
  assert.equal(validateCitations("See [README.md:L5-L5].", files, gapped).valid, false);
  assert.equal(validateCitations("See [README.md:L1-L4].", files, gapped).valid, false);
  const adjacent = [
    { path: "README.md", startLine: 1, endLine: 2 },
    { path: "README.md", startLine: 3, endLine: 4 },
  ];
  assert.equal(validateCitations("See [README.md:L1-L4].", files, adjacent).valid, true);
});

test("checkModel uses the typed local Ollama URL and refuses a public one", async () => {
  let seen = "";
  const fetchImpl: typeof fetch = async (input) => {
    seen = String(input);
    return Response.json({ models: [{ name: "qwen3:4b" }] });
  };
  assert.equal(normalizeOllamaBaseUrl("http://127.0.0.1:11434/"), "http://127.0.0.1:11434");
  assert.equal(normalizeOllamaBaseUrl("http://192.168.1.20:11434"), "http://192.168.1.20:11434");
  assert.throws(() => normalizeOllamaBaseUrl("https://example.com"), /local network/);
  assert.throws(() => normalizeOllamaBaseUrl("http://169.254.169.254"), /local network/);
  const health = await checkModel(fetchImpl, { baseUrl: "http://127.0.0.1:11435", model: "qwen3:4b" });
  assert.equal(health.available, true);
  assert.equal(seen, "http://127.0.0.1:11435/api/tags");
  const blocked = await checkModel(async () => {
    throw new Error("should not fetch");
  }, { baseUrl: "http://example.com" });
  assert.equal(blocked.available, false);
  assert.match(blocked.detail, /local network/);
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

test("Vercel uses a hosted model and ignores the browser Ollama URL", async () => {
  const secret = "test-key-not-real";
  const vercel = { VERCEL: "1", XAI_API_KEY: secret, MODEL_NAME: "grok-4.20-0309-non-reasoning" };
  const target = requestTarget({ baseUrl: "http://127.0.0.1:11434", model: "qwen3:4b" }, vercel);
  assert.equal(target.hosted?.baseUrl, "https://api.x.ai/v1");
  assert.equal(target.hosted?.model, "grok-4.20-0309-non-reasoning");
  assert.equal(target.baseUrl, undefined);
  assert.equal(requestTarget({ baseUrl: "http://127.0.0.1:11434" }, { XAI_API_KEY: secret }).baseUrl, "http://127.0.0.1:11434");
  assert.equal(requestTarget({ baseUrl: "http://127.0.0.1:11434" }, { VERCEL: "1" }).deployment, "vercel");
  assert.throws(() => hostedFromEnv({ VERCEL: "1", XAI_API_KEY: secret, MODEL_BASE_URL: "http://127.0.0.1:11434" }), /https/);
  assert.throws(() => hostedFromEnv({ VERCEL: "1", XAI_API_KEY: secret, MODEL_BASE_URL: "https://10.0.0.5" }), /public model API/);

  let auth = "";
  let seen = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    seen = String(input);
    auth = new Headers(init?.headers).get("authorization") ?? "";
    if (seen.endsWith("/models")) return Response.json({ data: [{ id: "grok-4.20-0309-non-reasoning" }] });
    return Response.json({ choices: [{ message: { content: "See [README.md:L1-L1]." } }] });
  };
  const health = await checkModel(fetchImpl, target);
  assert.equal(health.available, true);
  assert.equal(health.provider, "hosted");
  assert.equal(seen, "https://api.x.ai/v1/models");
  assert.equal(auth, `Bearer ${secret}`);
  assert.equal(JSON.stringify(health).includes(secret), false);
  const offline = await checkModel(async () => Response.json({}), { deployment: "vercel" });
  assert.match(offline.detail, /not available/);
  assert.equal(await generateText("question", fetchImpl, target), "See [README.md:L1-L1].");
  assert.equal(seen, "https://api.x.ai/v1/chat/completions");
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

test("answerWithModel rejects a citation to an indexed file that was not supplied", async () => {
  const files = {
    "README.md": "# App\n\n## Installation\npip install -r requirements.txt\n",
    "src/unused.py": "print('not retrieved')\n",
  };
  let posts = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith("/api/tags")) return Response.json({ models: [{ name: "qwen3:4b" }] });
    posts += 1;
    return Response.json({ response: "See [src/unused.py:L1-L1]." });
  };
  const answer = await answerWithModel(files, "How do I install this?", fetchImpl);
  assert.equal(posts, 2);
  assert.equal(answer.origin, "model");
  assert.match(answer.warning ?? "", /Verification warning/);
  assert.match(answer.warning ?? "", /src\/unused\.py/);
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
