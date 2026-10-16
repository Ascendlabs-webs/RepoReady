# Security notes

Repository files, issue text, and questions are untrusted data. Prompts tell the model to ignore instructions embedded in that text. This is not a guarantee that a model will obey.

- Setup commands are classified and displayed. They are not executed. Statuses `Executed Successfully` and `Execution Failed` are reserved for a recorded run and are not set by analysis.
- Paths that look like credentials (`.env`, private keys, `credentials.json`) are not fetched.
- File count, file size, and total character limits bound how much untrusted text reaches the model.
- GitHub access uses unauthenticated public API requests. A rate limit is reported instead of retrying forever.
- No model weights are downloaded by this repository. Ollama keeps them outside the app.
- Do not commit `.env` files, tokens, or model blobs. `.gitignore` excludes `.env`, `models/`, and `*.gguf`.
