/**
 * These checks pin the Grok app-builder brand skill to the scripts it calls.
 * `.grok/skills/og/` is part of that workspace, not of a RepoReady clone, so
 * `npm test` does not run this file. `npm run test:host` does, and it fails
 * if the skill tree is absent. Assertions are unchanged from the product suite.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { OG_PENDING_MAX_AGE_MS, OG_PENDING_REL_PATH, parseBrandCheckArgs } from "../brand-check.mjs";
import { parseWriteAtomicArgs, stagingError } from "../write-atomic.mjs";

const TEMPLATE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const readDoc = (rel) => readFileSync(join(TEMPLATE_ROOT, rel), "utf8");

test("SKILL.md and AGENTS.md name the marker path and bound this script uses", () => {
  // Prose wraps, so the minute count may straddle a line break.
  const bound = new RegExp(`${OG_PENDING_MAX_AGE_MS / 60_000}\\s+minutes`);
  for (const rel of [".grok/skills/og/SKILL.md", "AGENTS.md"]) {
    const doc = readDoc(rel);
    assert.ok(doc.includes(`/workspace/${OG_PENDING_REL_PATH}`), `${rel}: marker path`);
    assert.ok(bound.test(doc), `${rel}: staleness bound`);
  }
});

// The two places that own "never wait on the brand task". Scanning the whole
// of AGENTS.md instead would make every unrelated `wait_tasks` mention a future
// feature adds to it this test's business.
const PROHIBITION_SECTIONS = [
  {
    rel: ".grok/skills/og/SKILL.md",
    label: '§ "Brand-asset pass"',
    from: "## Brand-asset pass:",
    until: /\n## /,
  },
  {
    rel: "AGENTS.md",
    label: "execution loop step 6",
    from: "6. **Brand-asset pass",
    until: /\n7\. /,
  },
];

function prohibitionSection({ rel, label, from, until }) {
  const doc = readDoc(rel);
  const start = doc.indexOf(from);
  assert.notEqual(start, -1, `${rel}: ${label} moved — no "${from.trim()}"`);
  const rest = doc.slice(start + from.length);
  const end = rest.search(until);
  // Markdown emphasis and prose wrapping both sit between the two words.
  return (from + (end === -1 ? rest : rest.slice(0, end))).replace(/[`*]/g, "").replace(/\s+/g, " ");
}

test("the sections that own the brand-task prohibition never affirm a wait", () => {
  // Pinned on the shape of the prohibition, not on a negation being somewhere
  // nearby: "So: wait_tasks before the final verify, but never get_task_output"
  // keeps a negation in the sentence while instructing exactly the wait.
  const connectors = /(?:\s|[/,;]|\band\b|\bor\b|\bwait_tasks\b|\bget_task_output\b)+$/i;
  const negation = /\b(?:no|never|not|don['’]t)$/i;
  for (const section of PROHIBITION_SECTIONS) {
    const where = `${section.rel} ${section.label}`;
    const prose = prohibitionSection(section);
    const mentions = [...prose.matchAll(/wait_tasks|get_task_output/g)];
    assert.ok(mentions.length >= 2, `${where}: the prohibition itself went missing`);
    for (const match of mentions) {
      const before = prose.slice(0, match.index).replace(connectors, "");
      const context = prose.slice(Math.max(0, match.index - 60), match.index + 20);
      assert.ok(negation.test(before), `${where}: not a prohibition: …${context}…`);
    }
  }
});

test("SKILL.md tells the pass to self-check with the flag this CLI accepts", () => {
  const skill = readDoc(".grok/skills/og/SKILL.md");
  const invocations = skill.match(/node scripts\/brand-check\.mjs[^\n`]*/g) ?? [];
  assert.ok(invocations.length > 0);
  for (const line of invocations) {
    const argv = line.replace("node scripts/brand-check.mjs", "").trim().split(/\s+/);
    assert.equal(parseBrandCheckArgs(argv.filter(Boolean)).error, undefined, line);
  }
});

test("every hand-over the og skill prints is one this script accepts", () => {
  // The card and banner recipes live in the skill's references/, not SKILL.md.
  const skillDir = join(TEMPLATE_ROOT, ".grok/skills/og");
  const docs = [
    join(skillDir, "SKILL.md"),
    ...readdirSync(join(skillDir, "references")).map((f) => join(skillDir, "references", f)),
  ];
  const invocations = docs.flatMap(
    (path) => readFileSync(path, "utf8").match(/node scripts\/write-atomic\.mjs[^\n`]*/g) ?? [],
  );
  assert.ok(invocations.length >= 3, "og.jpg, x-banner.jpg and site.json each hand over");
  for (const line of invocations) {
    const argv = line.replace("node scripts/write-atomic.mjs", "").trim().split(/\s+/);
    const args = parseWriteAtomicArgs(argv);
    assert.equal(args.error, undefined, line);
    assert.equal(
      stagingError({ staged: args.staged, target: args.target, publicDir: "/workspace/public" }),
      null,
      line,
    );
  }
});
