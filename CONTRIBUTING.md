# Contributing to RepoReady

1. Fork the repository and create a branch.
2. Keep model answers and retrieved evidence visually distinct. Do not label lexical output as AI.
3. Add or update a test in `src/lib/repoready/repoready.test.ts` when you change indexing, citations, setup classification, or model failure behavior.
4. Run `npm test` and `npm run typecheck`.
5. Do not commit secrets, GitHub tokens, or downloaded models.
6. Open a pull request that describes what you verified.
