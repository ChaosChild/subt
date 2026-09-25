// claude-refresh.test.ts – pure helpers around the claude OAuth self-refresh
// (buildRefreshBody, claudeAuth's expired-but-refreshable tri-state) and init's
// alibaba verification verdict. No network, no subprocesses, no user files.
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyBlVerify } from "../src/init.ts";
import { buildRefreshBody, claudeAuth } from "../src/providers/claude.ts";

test("claude buildRefreshBody: grant_type, refresh_token, Claude Code's public client_id", () => {
  assert.deepEqual(JSON.parse(buildRefreshBody("RT-FIXTURE")), {
    grant_type: "refresh_token",
    refresh_token: "RT-FIXTURE",
    client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  });
});

test("claude buildRefreshBody: deterministic, token embedded verbatim", () => {
  const rt = "eyJ_fake-token.with~every-char-kept";
  const body = buildRefreshBody(rt);
  assert.equal(body, buildRefreshBody(rt));
  assert.ok(body.includes(rt), "refresh token must pass through untouched");
});

test("claudeAuth: expired + live refresh token -> fail carrying refreshToken (self-refreshable)", () => {
  const now = 1_800_000_000_000;
  const auth = claudeAuth(
    {
      claudeAiOauth: {
        accessToken: "tok",
        expiresAt: now - 1000,
        refreshToken: "rt",
        refreshTokenExpiresAt: now + 86_400_000,
      },
    },
    now,
  );
  assert.ok(!auth.ok);
  assert.equal(auth.error.kind, "expired-token");
  assert.equal(auth.refreshToken, "rt");
});

test("claudeAuth: absent refreshTokenExpiresAt still refreshable; dead or absent refresh token is not", () => {
  const now = 1_800_000_000_000;
  const noRte = claudeAuth({ claudeAiOauth: { accessToken: "tok", expiresAt: now + 30_000, refreshToken: "rt" } }, now);
  assert.ok(!noRte.ok);
  assert.equal(noRte.refreshToken, "rt", "within the 60s skew counts as expired but refreshable");

  const deadRte = claudeAuth(
    {
      claudeAiOauth: { accessToken: "tok", expiresAt: now - 1000, refreshToken: "rt", refreshTokenExpiresAt: now - 1 },
    },
    now,
  );
  assert.ok(!deadRte.ok);
  assert.equal(deadRte.refreshToken, undefined);

  const noRt = claudeAuth({ claudeAiOauth: { accessToken: "tok", expiresAt: now - 1000 } }, now);
  assert.ok(!noRt.ok);
  assert.equal(noRt.refreshToken, undefined);
});

test("init classifyBlVerify: exit 0 is ok when plan data is present or stdout is not checked", () => {
  assert.deepEqual(
    classifyBlVerify(0, "warning: whatever", (s) => s, '{"per5HourPercentage":22}'),
    { ok: true },
  );
});

test("init classifyBlVerify: exit 0 with empty plan data is NOT ok", () => {
  const empty = classifyBlVerify(0, "", (s) => s, "{}");
  assert.equal(empty.ok, false);
  assert.match((empty as { message: string }).message, /no plan data/);
  const emptyItems = classifyBlVerify(0, "", (s) => s, '{\n  "generatedAt": 123,\n  "items": []\n}');
  assert.equal(emptyItems.ok, false);
});

test("init classifyBlVerify: non-zero surfaces the scrubbed last stderr line", () => {
  const scrub = (s: string): string => s.split("SECRET").join("***");
  const verdict = classifyBlVerify(2, "  banner line\n access denied for key SECRET \n", scrub);
  assert.ok(!verdict.ok);
  if (!verdict.ok) assert.equal(verdict.message, "access denied for key ***");
});

test("init classifyBlVerify: empty stderr falls back to the exit code, message capped at 200 chars", () => {
  const fallback = classifyBlVerify(7, "", (s) => s);
  assert.ok(!fallback.ok);
  if (!fallback.ok) assert.match(fallback.message, /exited with code 7/);
  const long = classifyBlVerify(3, `x\n${"y".repeat(500)}`, (s) => s);
  assert.ok(!long.ok);
  if (!long.ok) assert.ok(long.message.length <= 200);
});
