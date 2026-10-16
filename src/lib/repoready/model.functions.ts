import { createServerFn } from "@tanstack/react-start";
import { answerWithModel } from "./grounded.ts";
import { checkModel } from "./ollama.ts";
import { planWithModel } from "./planner.ts";
import type { RepoSnapshot } from "./types.ts";

const MAX_FILES = 40;
const MAX_FILE_CHARS = 20_000;
const MAX_TOTAL_CHARS = 120_000;

function readFiles(input: unknown): Record<string, string> {
  if (typeof input !== "object" || !input || !("files" in input)) throw new Error("Missing indexed files.");
  const files = (input as { files: unknown }).files;
  if (typeof files !== "object" || !files) throw new Error("Missing indexed files.");
  const entries = Object.entries(files);
  if (entries.length > MAX_FILES) throw new Error("Too many files were sent.");
  let total = 0;
  const clean: Record<string, string> = {};
  for (const [path, content] of entries) {
    if (typeof content !== "string") throw new Error("A file was not text.");
    if (content.length > MAX_FILE_CHARS) throw new Error(`Refusing oversized file: ${path}`);
    total += content.length;
    if (total > MAX_TOTAL_CHARS) throw new Error("The indexed context is too large.");
    clean[path] = content;
  }
  return clean;
}

export const modelHealth = createServerFn({ method: "POST" })
  .validator((input: unknown) => input ?? {})
  .handler(async () => checkModel());

export const askRepository = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const question =
      typeof input === "object" && input && "question" in input ? String((input as { question: unknown }).question) : "";
    if (!question.trim() || question.length > 2_000) throw new Error("Enter a shorter question.");
    return { question: question.trim(), files: readFiles(input) };
  })
  .handler(async ({ data }) => answerWithModel(data.files, data.question));

export const planRepository = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    if (typeof input !== "object" || !input) throw new Error("Missing plan request.");
    const issueNumber = Number((input as { issueNumber?: unknown }).issueNumber);
    if (!Number.isInteger(issueNumber)) throw new Error("Choose an issue.");
    const snapshot = (input as { snapshot?: RepoSnapshot }).snapshot;
    if (!snapshot || typeof snapshot !== "object" || !snapshot.files || !Array.isArray(snapshot.issues)) {
      throw new Error("Missing repository snapshot.");
    }
    return {
      issueNumber,
      snapshot: { ...snapshot, files: readFiles({ files: snapshot.files }) },
    };
  })
  .handler(async ({ data }) => planWithModel(data.snapshot, data.issueNumber));
