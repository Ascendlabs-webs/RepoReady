# RepoReady

From an unfamiliar repository to a first contribution.

RepoReady reads a public GitHub repository, shows the files it actually indexed, and answers questions with citations back to those files. Setup commands are extracted from the repository and labeled as documented or configured. They are never executed. A fictional sample repository is included so the interface still works with no network.

## What you can do

- Paste a public GitHub URL and index high-value root files (README, manifests, contributing guide).
- Ask a question and see the matching passages with line ranges.
- Review setup commands without running them.
- Turn an open issue into an evidence-based contribution plan and download it as Markdown.
- Export a documentation-gap report limited to the files that were indexed.

## Run locally

```bash
npm install
npm run dev
```

The app listens on port 8080.

## License

MIT
