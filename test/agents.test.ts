// agents.test.ts – the `init --agent` machinery: the pure marker upsert, the
// temp+rename file writer, the target table. Tests inject temp dirs and never
// touch real home files.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGENT_SECTION, agentTargets, applyAgentSection, upsertAgentSection } from "../src/agents.ts";

test("upsertAgentSection: null or blank -> the section alone", () => {
  assert.equal(upsertAgentSection(null, "SEC"), "SEC");
  assert.equal(upsertAgentSection("", "SEC"), "SEC");
  assert.equal(upsertAgentSection("   \n", "SEC"), "SEC");
});

test("upsertAgentSection: no markers -> appended with one blank line before", () => {
  assert.equal(upsertAgentSection("mine\n", "SEC"), "mine\n\nSEC");
  assert.equal(upsertAgentSection("mine\n\n\n", "SEC"), "mine\n\nSEC", "trailing whitespace collapses");
});

test("upsertAgentSection: markers -> only the block between them is replaced", () => {
  const existing = "before\n\n<!-- subtrk:begin -->\nold\n<!-- subtrk:end -->\n\nafter\n";
  assert.equal(upsertAgentSection(existing, "SEC"), "before\n\nSEC\n\nafter\n");
});

test("upsertAgentSection: unterminated begin -> replace from begin to EOF", () => {
  assert.equal(upsertAgentSection("head\n\n<!-- subtrk:begin -->\ntruncated", "SEC"), "head\n\nSEC");
});

test("upsertAgentSection: double apply -> the section appears exactly once", () => {
  const once = upsertAgentSection("keep me\n", AGENT_SECTION);
  const twice = upsertAgentSection(once, AGENT_SECTION);
  assert.equal(twice.split("<!-- subtrk:begin -->").length - 1, 1);
  assert.equal(twice.split("## subtrk").length - 1, 1);
  assert.ok(twice.startsWith("keep me\n\n"), "user text preserved");
});

test("applyAgentSection: created when absent, updated when present", () => {
  const dir = mkdtempSync(join(tmpdir(), "subtrk-agents-"));
  try {
    const file = join(dir, ".claude", "CLAUDE.md");
    assert.deepEqual(applyAgentSection(file, AGENT_SECTION), { status: "created" });
    assert.equal(readFileSync(file, "utf8"), `${AGENT_SECTION}\n`, "created file holds only the section");
    assert.deepEqual(applyAgentSection(file, AGENT_SECTION), { status: "updated" });
    const raw = readFileSync(file, "utf8");
    assert.equal(raw.split("<!-- subtrk:begin -->").length - 1, 1, "idempotent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyAgentSection: the user's text outside the markers survives", () => {
  const dir = mkdtempSync(join(tmpdir(), "subtrk-agents-"));
  try {
    const file = join(dir, "AGENTS.md");
    writeFileSync(file, "my rules\n");
    applyAgentSection(file, AGENT_SECTION);
    const raw = readFileSync(file, "utf8");
    assert.ok(raw.startsWith("my rules\n\n<!-- subtrk:begin -->"));
    assert.ok(raw.endsWith("<!-- subtrk:end -->\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agentTargets: five ids in order, base replaces homedir", () => {
  const t = agentTargets(join("base", "x"));
  assert.deepEqual(Object.keys(t), ["claude", "zcode", "codex", "opencode", "agy"]);
  assert.equal(t.claude.file, join("base", "x", ".claude", "CLAUDE.md"));
  assert.equal(t.opencode.file, join("base", "x", ".config", "opencode", "AGENTS.md"));
  assert.equal(t.agy.file, join("base", "x", ".gemini", "AGENTS.md"));
});
