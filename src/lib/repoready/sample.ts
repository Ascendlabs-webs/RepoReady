import type { RepoSnapshot } from "./types.ts";

export const SAMPLE_REPO: RepoSnapshot = {
  simulated: true,
  metadata: {
    name: "sample-flask-app",
    fullName: "demo/sample-flask-app",
    description: "A minimal Flask application used to demonstrate RepoReady. This repository is fictional.",
    defaultBranch: "main",
    language: "Python",
    stars: 42,
    license: "MIT",
    htmlUrl: "https://github.com/demo/sample-flask-app",
  },
  files: {
    "README.md": `# Sample Flask App (FICTIONAL)

## Installation
pip install -r requirements.txt

## Running
python app.py

## Tests
pytest
`,
    "requirements.txt": "flask==3.0.0\npytest==8.0.0\n",
    "app.py": `from flask import Flask
app = Flask(__name__)

@app.route("/")
def hello():
    return "Hello, RepoReady!"

if __name__ == "__main__":
    app.run(debug=True)
`,
    "tests/test_app.py": `def test_hello():
    from app import app
    client = app.test_client()
    resp = client.get("/")
    assert resp.data == b"Hello, RepoReady!"
`,
    "CONTRIBUTING.md": `# Contributing
1. Fork the repo
2. Create a feature branch
3. Add tests
4. Open a pull request
`,
  },
  issues: [
    {
      number: 1,
      title: "Add a health check endpoint",
      body: "Please add a /health endpoint that returns 200 OK. This is a fictional issue for the offline demo. Do not treat it as a real GitHub issue.",
      url: "https://github.com/demo/sample-flask-app/issues/1",
      labels: ["good first issue", "sample"],
    },
  ],
  stats: {
    examined: 5,
    indexed: 5,
    skipped: 0,
    limitations: ["Offline sample. Only the five demo files are indexed. Nothing here was fetched from GitHub."],
    coverage: {
      truncated: false,
      complete: true,
      readme: true,
      contributing: true,
      tests: true,
    },
  },
};
