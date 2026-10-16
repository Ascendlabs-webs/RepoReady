# RepoReady

From an unfamiliar repository to a first contribution.

RepoReady is an evidence-grounded onboarding app for public GitHub repositories. It indexes a bounded set of documentation, source, tests, manifests, and CI files, then asks a local open-weight model to answer questions and draft a contribution plan. Every model claim is checked against those files. Commands found in a repository are never executed.

If Ollama is not running, the app still shows retrieved evidence and says that the text is not a model answer.

## Requirements

- Node.js 22 or newer
- A public GitHub repository for live indexing. Unauthenticated requests are rate limited.
- Optional: [Ollama](https://ollama.com) with `qwen3:4b` for model answers

## Install and run

Linux and macOS:

```bash
npm install
ollama pull qwen3:4b
export OLLAMA_BASE_URL=http://127.0.0.1:11434
export OLLAMA_MODEL=qwen3:4b
npm run dev
```

Windows PowerShell:

```powershell
npm install
ollama pull qwen3:4b
$env:OLLAMA_BASE_URL = "http://127.0.0.1:11434"
$env:OLLAMA_MODEL = "qwen3:4b"
npm run dev
```

The development server binds to `127.0.0.1:8080` so other devices on the network cannot call its local-model functions. Open [http://127.0.0.1:8080](http://127.0.0.1:8080). The header shows whether `qwen3:4b` is reachable. `OLLAMA_TIMEOUT_MS` defaults to 45000.

To expose the dev server on your LAN on purpose, use `npm run dev:lan`. That binds `0.0.0.0:8080`. Do this only on a network you trust.

## Checks

```bash
npm test
npm run typecheck
```

## What the app will not do

- It does not run repository commands.
- It does not call a paid cloud model.
- It does not treat lexical search as a model answer.
- It does not index `.env` files, private keys, binaries, lockfiles, or dependency directories.

See [ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [DEMO_SCRIPT.md](DEMO_SCRIPT.md).

## License

MIT
