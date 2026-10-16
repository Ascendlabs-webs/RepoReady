# Architecture

```mermaid
flowchart LR
  UI[React UI] --> Ingest[GitHub ingest]
  UI --> Ask[Grounded ask]
  UI --> Plan[Contribution plan]
  Ingest --> Tree[GitHub tree API]
  Ask --> Retrieve[Lexical retrieval]
  Plan --> Retrieve
  Retrieve --> Model[Ollama or hosted model]
  Model --> Check[Citation check]
```

The browser never calls the model directly. Server functions in `src/lib/repoready/model.functions.ts` and `src/lib/repoready/github.functions.ts` perform GitHub and model requests. Local development uses Ollama. When `VERCEL=1` and `XAI_API_KEY` or `MODEL_API_KEY` is set, the same functions call an OpenAI-compatible chat API. The browser cannot choose that URL or supply the key.

Indexing (`src/lib/repoready/indexer.ts` and `ingest.ts`) reads the Git tree, drops secrets, binaries, lockfiles, and dependency directories, then stores at most 24 text files. The stored text never exceeds 96,000 characters: a file that would cross that budget is cut to the remaining prefix, or skipped when no characters remain, and the index is marked incomplete.

Retrieval runs before any model call. If nothing matches, the model is not called. A citation is valid only when its path is in the passages supplied to that call, the line range exists in the source file, and the range sits inside one of those passages without crossing a gap. One retry is allowed. A failed check is shown as a verification warning. Coverage flags are computed from files that were actually stored, after downloads finish. A truncated tree, a skipped candidate, a failed download, or truncated file text marks the index incomplete.

When Ollama is down, timeout, or returns malformed JSON, the same screen shows the evidence draft and states that it is not a model answer.

The host project still contains authentication, database, multiplayer, and PWA files because the application root imports them. RepoReady's onboarding features do not use those services. They were left in place so the existing build and preview keep working.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Local Ollama server |
| `OLLAMA_MODEL` | `qwen3:4b` | Model name |
| `OLLAMA_TIMEOUT_MS` | `45000` | Generate timeout |
| `XAI_API_KEY` or `MODEL_API_KEY` | unset | Hosted model key, used on Vercel |
| `MODEL_NAME` | `grok-4.20-0309-non-reasoning` | Hosted model id |
| `MODEL_BASE_URL` | `https://api.x.ai/v1` | Hosted OpenAI-compatible API |
| `MODEL_PROVIDER` | unset | Set to `hosted` to use the key off Vercel, or `ollama` to force Ollama |
