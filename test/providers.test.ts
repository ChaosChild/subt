// Pure-parser tests for every provider – fixtures only, no network, no real user files.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  deriveCredits,
  extractJson,
  mapRefreshOutcome,
  parseQuotaConfig,
  parseSubscription,
  parseTokenPlanUsage,
  stderrMessage,
} from "../src/providers/alibaba.ts";
import { claudeAuth, parseClaudeUsage } from "../src/providers/claude.ts";
import { glmAuth, parseGlmQuota } from "../src/providers/glm.ts";
import {
  ANTIGRAVITY_CONSTANTS_MISSING,
  buildAntigravityRefreshForm,
  googleExpired,
  mapGrantFailure,
  needsRefresh,
  parseAgyKeyringBlob,
  parseAntigravityTokenFile,
  parseGeminiCreds,
  parseGoogleSummary,
  parseMintResponse,
  slugify,
} from "../src/providers/google.ts";
import { allProviders, refreshableProviders } from "../src/providers/index.ts";
import { extractOpencodeKey } from "../src/providers/opencode.ts";
import { parseOpenrouterCredits, parseOpenrouterKey } from "../src/providers/openrouter.ts";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}

// ---- module contract -------------------------------------------------------

test("allProviders exposes the six modules in spec order with spec TTLs", () => {
  assert.deepEqual(
    allProviders.map((p) => p.id),
    ["claude", "glm", "alibaba", "google", "opencode", "openrouter"],
  );
  const ttls: Record<string, number> = {};
  for (const p of allProviders) {
    assert.equal(typeof p.probe, "function");
    ttls[p.id] = p.ttlMs;
  }
  assert.deepEqual(ttls, {
    claude: 300000,
    glm: 60000,
    alibaba: 300000,
    google: 60000,
    opencode: 0,
    openrouter: 60000,
  });
});

test("refreshableProviders lists exactly the modules with refresh – google self-refreshes read-only", () => {
  assert.deepEqual(refreshableProviders(), ["claude", "alibaba", "google"]);
  for (const id of ["glm", "opencode", "openrouter"]) {
    assert.equal(allProviders.find((p) => p.id === id)?.refresh, undefined);
  }
});

// ---- alibaba refresh -------------------------------------------------------

test("alibaba mapRefreshOutcome maps spawn outcomes to fixed literals – output never surfaces", () => {
  assert.deepEqual(mapRefreshOutcome({ ok: true, toolMissing: false }), {
    ok: true,
    message: "console session re-authorised",
  });
  assert.deepEqual(mapRefreshOutcome({ ok: false, toolMissing: true }), {
    ok: false,
    message: "bl not found – install bailian-cli",
  });
  assert.deepEqual(mapRefreshOutcome({ ok: false, toolMissing: false }), {
    ok: false,
    message: "console login failed – run subtrk init",
  });
});

// ---- claude ----------------------------------------------------------------

test("claude parseClaudeUsage maps the fixture to 5h/7d windows", () => {
  const parsed = parseClaudeUsage(fixture("claude-usage"));
  assert.ok(parsed);
  assert.deepEqual(parsed.windows, [
    { kind: "5h", usedPercent: 13, resetsAt: "2026-09-23T18:04:00.000Z" },
    { kind: "7d", usedPercent: 89, resetsAt: "2026-09-28T00:00:00.000Z" },
  ]);
});

test("claude parseClaudeUsage maps the inactive-session fixture to only the active 7d window", () => {
  const parsed = parseClaudeUsage(fixture("claude-usage-inactive"));
  assert.ok(parsed);
  assert.deepEqual(parsed.windows, [{ kind: "7d", usedPercent: 27, resetsAt: "2026-09-27T00:59:59.801Z" }]);
});

test("claude parseClaudeUsage rejects missing keys and non-objects", () => {
  assert.equal(parseClaudeUsage({}), null);
  assert.equal(parseClaudeUsage({ five_hour: { utilization: 1 } }), null); // resets_at missing
  assert.equal(parseClaudeUsage({ five_hour: { utilization: 1, resets_at: null } }), null); // only window inactive
  assert.equal(parseClaudeUsage({ five_hour: { utilization: 1, resets_at: "nope" } }), null);
  assert.equal(parseClaudeUsage({ five_hour: { utilization: 1, resets_at: 5 } }), null); // number resets_at still fails
  assert.equal(parseClaudeUsage("garbage"), null);
});

test("claude claudeAuth: valid token passes through, skew window expires, bad shape fails", () => {
  const now = 1_800_000_000_000;
  const ok = claudeAuth({ claudeAiOauth: { accessToken: "tok", expiresAt: now + 120_000 } }, now);
  assert.ok(ok.ok);
  assert.equal(ok.accessToken, "tok");

  const withinSkew = claudeAuth({ claudeAiOauth: { accessToken: "tok", expiresAt: now + 30_000 } }, now);
  assert.ok(!withinSkew.ok);
  assert.equal(withinSkew.error.kind, "expired-token");
  assert.equal(withinSkew.error.hint, "start Claude Code once so it refreshes the token, or run claude /login");

  const past = claudeAuth({ claudeAiOauth: { accessToken: "tok", expiresAt: now - 1000 } }, now);
  assert.ok(!past.ok);
  assert.equal(past.error.kind, "expired-token");
  assert.equal(past.error.hint, "start Claude Code once so it refreshes the token, or run claude /login");

  const noToken = claudeAuth({ claudeAiOauth: {} }, now);
  assert.ok(!noToken.ok);
  assert.equal(noToken.error.kind, "no-credentials");

  const noExpiry = claudeAuth({ claudeAiOauth: { accessToken: "tok" } }, now);
  assert.ok(!noExpiry.ok);
  assert.equal(noExpiry.error.kind, "parse-failure");
});

// ---- glm -------------------------------------------------------------------

test("glm parseGlmQuota: unit 3 -> hours (5h), unit 6 -> 7d, TIME_LIMIT ignored, level -> plan", () => {
  const parsed = parseGlmQuota(fixture("glm-quota"));
  assert.ok(parsed);
  assert.equal(parsed.windows.length, 2, "TIME_LIMIT entry must be ignored");
  assert.deepEqual(parsed.windows, [
    { kind: "5h", usedPercent: 4, resetsAt: new Date(1789549620000).toISOString() },
    { kind: "7d", usedPercent: 61, resetsAt: new Date(1790054400000).toISOString() },
  ]);
  assert.equal(parsed.plan, "GLM Legacy 2 Max");
});

test("glm parseGlmQuota: unit 6 with number 1 is '7d', numeric level is stringified, unknown units skipped", () => {
  const parsed = parseGlmQuota({
    data: {
      level: 4,
      limits: [
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 7, nextResetTime: 1790054400000 },
        { type: "TOKENS_LIMIT", unit: 9, number: 3, percentage: 50, nextResetTime: 1790054400000 },
      ],
    },
  });
  assert.ok(parsed);
  assert.deepEqual(parsed.windows, [{ kind: "7d", usedPercent: 7, resetsAt: new Date(1790054400000).toISOString() }]);
  assert.equal(parsed.plan, "GLM 4");
});

test("glm parseGlmQuota rejects missing data.limits", () => {
  assert.equal(parseGlmQuota({}), null);
  assert.equal(parseGlmQuota({ data: {} }), null);
  assert.equal(parseGlmQuota({ data: { limits: "nope" } }), null);
});

test("glm glmAuth: config key + host origin from baseURL, env fallback, null when neither", () => {
  const fromConfig = glmAuth(
    { provider: { zai: { apiKey: "K", options: { baseURL: "https://open.bigmodel.cn/api/paas/v4" } } } },
    undefined,
  );
  assert.deepEqual(fromConfig, { apiKey: "K", host: "https://open.bigmodel.cn" });

  const defaultHost = glmAuth({ provider: { zai: { apiKey: "K" } } }, undefined);
  assert.deepEqual(defaultHost, { apiKey: "K", host: "https://api.z.ai" });

  const fromEnv = glmAuth({}, "ENVTOKEN");
  assert.deepEqual(fromEnv, { apiKey: "ENVTOKEN", host: "https://api.z.ai" });

  const badBaseUrl = glmAuth({ provider: { zai: { apiKey: "K", options: { baseURL: "::not a url" } } } }, undefined);
  assert.deepEqual(badBaseUrl, { apiKey: "K", host: "https://api.z.ai" });

  assert.equal(glmAuth({}, undefined), null);
  assert.equal(glmAuth(null, ""), null);
});

// ---- alibaba ---------------------------------------------------------------

test("alibaba extractJson survives banner text around the JSON", () => {
  assert.deepEqual(extractJson('banner line\n{"a": 1}\ntrailer line'), { a: 1 });
  assert.deepEqual(
    extractJson('pre {"a": {"b": 2}} post'),
    { a: { b: 2 } },
    "nested braces survive first-{..last-} slicing",
  );
  assert.equal(extractJson('{"a": 1} {"b": 2}'), null, "two top-level objects slice to invalid JSON -> null");
  assert.equal(extractJson("no json here"), null);
  assert.equal(extractJson("{not json}"), null);
});

test("alibaba parseTokenPlanUsage: monthly ratio -> 30d window percent (real wire shape)", () => {
  const windows = parseTokenPlanUsage(fixture("token-plan-usage"));
  assert.equal(windows.length, 1);
  assert.equal(windows[0].kind, "30d");
  assert.ok(Math.abs((windows[0].usedPercent ?? 0) - 10.14004779733) < 1e-9); // ratio of monthly credits
  assert.equal(windows[0].resetsAt, new Date(1792684800000).toISOString());
});

test("alibaba parseTokenPlanUsage: legacy 5h/week percent families still map", () => {
  assert.deepEqual(parseTokenPlanUsage(fixture("token-plan-usage-legacy")), [
    { kind: "5h", usedPercent: 22, resetsAt: new Date(1780577831989).toISOString() },
    { kind: "7d", usedPercent: 47, resetsAt: new Date(1780651431995).toISOString() },
  ]);
});

test("alibaba parseTokenPlanUsage: empty/absent data means no windows, not an error", () => {
  assert.deepEqual(parseTokenPlanUsage({ code: "SUCCESS", data: {} }), []);
  assert.deepEqual(parseTokenPlanUsage({}), []);
  assert.deepEqual(parseTokenPlanUsage("nope"), []);
  assert.deepEqual(parseTokenPlanUsage({ data: { per1MonthPercentage: 0.5 } }), [], "reset time missing -> skip");
});

test("alibaba parseSubscription extracts spec/renewal/status", () => {
  assert.deepEqual(parseSubscription(fixture("token-plan-subscription")), {
    specCode: "standard",
    remainingDays: 345,
    status: "VALID",
  });
  assert.deepEqual(parseSubscription({}), {});
});

test("alibaba parseQuotaConfig maps every spec monthly total", () => {
  const quotas = parseQuotaConfig(fixture("token-plan-quota-config"));
  assert.equal(quotas.standard, 45000);
  assert.equal(quotas.lite, 11500);
  assert.equal(quotas.pro, 180000);
  assert.equal("addon_quota" in quotas, false, "addon bucket is not a spec");
});

test("alibaba deriveCredits joins monthly window with spec total", () => {
  const monthly = parseTokenPlanUsage(fixture("token-plan-usage"))[0];
  assert.deepEqual(deriveCredits(monthly, 45000), {
    total: 45000,
    remaining: 40437, // 45000 - 10.140047797% of 45000 (4563.02)
    unit: "credits",
    cycleEndsAt: new Date(1792684800000).toISOString(),
    source: "derived",
  });
  assert.equal(deriveCredits(undefined, 45000), null);
  assert.equal(deriveCredits(monthly, undefined), null);
});

test("alibaba stderrMessage: withheld without redact, scrubbed and tail-truncated with it", () => {
  const noisy = `${"x".repeat(500)} trace=${"TOKEN"}tail`;
  assert.equal(stderrMessage(noisy), "bl exited non-zero (stderr withheld)");
  const redacted = stderrMessage(noisy, (s) => s.split("TOKEN").join("***"));
  assert.ok(!redacted.includes("TOKEN"));
  assert.ok(redacted.includes("***"));
  // last-200-chars semantics: a secret at the head falls off the front of the tail
  const tail = stderrMessage(`HEAD ${"TOKEN"} ${"y".repeat(500)}`, (s) => s);
  assert.ok(!tail.includes("TOKEN"));
  assert.ok(tail.length <= "bl exited non-zero: ".length + 200);
});

// ---- google ----------------------------------------------------------------

test("google slugify", () => {
  assert.equal(slugify("Gemini Models"), "gemini-models");
  assert.equal(slugify("  Pro -- Tier!! "), "pro-tier");
});

test("google parseGoogleSummary maps groups/buckets to scoped fraction windows (live shape)", () => {
  assert.deepEqual(parseGoogleSummary(fixture("google-summary")), [
    { kind: "5h", scope: "gemini-models", remainingFraction: 0.38, resetsAt: "2026-09-23T18:00:00.000Z" },
    { kind: "weekly", scope: "gemini-models", remainingFraction: 0.81, resetsAt: "2026-09-28T00:00:00.000Z" },
    { kind: "weekly", scope: "antigravity", remainingFraction: 0.64, resetsAt: "2026-09-28T00:00:00.000Z" },
  ]);
});

test("google parseGoogleSummary: missing groups -> null, empty groups -> empty array", () => {
  assert.equal(parseGoogleSummary({}), null);
  assert.equal(parseGoogleSummary({ groups: "nope" }), null);
  assert.deepEqual(parseGoogleSummary({ groups: [] }), []);
});

test("google parseGoogleSummary: bucketId-only bucket derives its kind, kindless bucket is skipped", () => {
  const bucketOnly = {
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [{ bucketId: "gemini-5h", remainingFraction: 0.1, resetTime: "2026-09-25T18:00:00Z" }],
      },
    ],
  };
  assert.deepEqual(parseGoogleSummary(bucketOnly), [
    { kind: "5h", scope: "gemini-models", remainingFraction: 0.1, resetsAt: "2026-09-25T18:00:00.000Z" },
  ]);
  assert.deepEqual(
    parseGoogleSummary({ groups: [{ buckets: [{ remainingFraction: 0.5, resetTime: "2026-09-25T18:00:00Z" }] }] }),
    [],
    "no window and no bucketId -> no kind -> bucket skipped",
  );
});

test("google parseAgyKeyringBlob extracts tokens and converts the RFC3339 expiry", () => {
  assert.deepEqual(parseAgyKeyringBlob(fixture("agy-keyring")), {
    accessToken: "ya29.example-access-token",
    refreshToken: "1//example-refresh-token",
    expiresAtMs: Date.parse("2026-09-25T12:00:00.000Z"),
  });
});

test("google parseAgyKeyringBlob rejects wrong shapes, tolerates missing or invalid expiry", () => {
  assert.equal(parseAgyKeyringBlob(null), null);
  assert.equal(parseAgyKeyringBlob({}), null);
  assert.equal(parseAgyKeyringBlob({ token: "nope" }), null);
  assert.equal(parseAgyKeyringBlob({ token: { access_token: "" } }), null);
  assert.deepEqual(parseAgyKeyringBlob({ token: { access_token: "AT" } }), { accessToken: "AT" });
  assert.deepEqual(parseAgyKeyringBlob({ token: { access_token: "AT", expiry: "not-a-date" } }), { accessToken: "AT" });
});

test("google credential parsers: gemini json, antigravity json, bare token", () => {
  const gemini = parseGeminiCreds({ access_token: "AT", refresh_token: "RT", expiry_date: 123 });
  assert.deepEqual(gemini, {
    accessToken: "AT",
    refreshToken: "RT",
    expiresAtMs: 123,
    lineage: "gemini",
    raw: { access_token: "AT", refresh_token: "RT", expiry_date: 123 },
  });
  assert.equal(parseGeminiCreds({}), null);

  const antiJson = parseAntigravityTokenFile('{"access_token":"A2","refresh_token":"R2"}');
  assert.ok(antiJson);
  assert.equal(antiJson.lineage, "antigravity");
  assert.equal(antiJson.refreshToken, "R2");

  const bare = parseAntigravityTokenFile("  raw-opaque-token\n");
  assert.deepEqual(bare, { accessToken: "raw-opaque-token", lineage: "antigravity" });

  assert.equal(parseAntigravityTokenFile(""), null);
  assert.equal(parseAntigravityTokenFile('{"other": 1}'), null);
});

test("google googleExpired honours the 60s skew and unknown expiry", () => {
  const now = 1_800_000_000_000;
  assert.equal(googleExpired({ accessToken: "t", lineage: "gemini", expiresAtMs: now + 120_000 }, now), false);
  assert.equal(googleExpired({ accessToken: "t", lineage: "gemini", expiresAtMs: now + 30_000 }, now), true);
  assert.equal(googleExpired({ accessToken: "t", lineage: "gemini" }, now), false);
});

test("google needsRefresh: absent token, past expiry and the 5-minute window all mint; fresh does not", () => {
  const now = 1_800_000_000_000;
  assert.equal(needsRefresh({ lineage: "agy-keyring", refreshToken: "RT" }, now), true, "no access token -> mint");
  assert.equal(
    needsRefresh({ lineage: "agy-keyring", refreshToken: "RT", accessToken: "AT", expiresAtMs: now - 1000 }, now),
    true,
    "expired -> mint",
  );
  assert.equal(
    needsRefresh({ lineage: "agy-keyring", refreshToken: "RT", accessToken: "AT", expiresAtMs: now + 100_000 }, now),
    true,
    "inside the 5-minute safety window -> mint",
  );
  assert.equal(
    needsRefresh({ lineage: "agy-keyring", refreshToken: "RT", accessToken: "AT", expiresAtMs: now + 400_000 }, now),
    false,
    "fresh beyond the window -> use the stored token",
  );
  assert.equal(
    needsRefresh({ lineage: "agy-keyring", accessToken: "AT" }, now),
    false,
    "unknown expiry counts as fresh",
  );
});

test("google ANTIGRAVITY_CONSTANTS_MISSING fails fast with the init remedy", () => {
  assert.deepEqual(ANTIGRAVITY_CONSTANTS_MISSING, {
    kind: "no-credentials",
    message: "antigravity client constants missing",
    hint: "run subtrk init (fetches the public values)",
    remedy: "subtrk init",
  });
});

test("google mapGrantFailure: 400/401 and invalid_grant mean re-login, other outcomes pass through", () => {
  for (const [status, code] of [
    [400, ""],
    [401, ""],
    [400, "invalid_grant"],
    [undefined, "invalid_grant"],
  ] as const) {
    const err = mapGrantFailure(status, code);
    assert.equal(err.kind, "expired-token");
    assert.equal(err.message, "refresh token rejected by Google");
    assert.equal(err.hint, "the stored login was revoked – re-login once");
    assert.equal(err.remedy, "re-login inside agy");
  }
  assert.equal(mapGrantFailure(503, "").kind, "http-error");
  assert.equal(mapGrantFailure(undefined, "").kind, "http-error");
  assert.equal(mapGrantFailure(503, "").message, "HTTP 503");
});

test("google buildAntigravityRefreshForm: confidential grant carrying both client constants", () => {
  assert.deepEqual(Object.fromEntries(new URLSearchParams(buildAntigravityRefreshForm("RT", "ID", "SEC"))), {
    grant_type: "refresh_token",
    refresh_token: "RT",
    client_id: "ID",
    client_secret: "SEC",
  });
});

test("google parseMintResponse: access token + expires_in -> mint window; junk is a parse failure", () => {
  const now = 1_800_000_000_000;
  assert.deepEqual(parseMintResponse('{"access_token":"AT2","expires_in":3599}', now), {
    ok: true,
    accessToken: "AT2",
    expiresAtMs: now + 3_599_000,
  });
  assert.equal(parseMintResponse("not json", now).ok, false);
  assert.equal(parseMintResponse('{"expires_in":3599}', now).ok, false);
  assert.equal(parseMintResponse('{"access_token":"","expires_in":3599}', now).ok, false);
  assert.equal(parseMintResponse('{"access_token":"AT"}', now).ok, false);
  assert.equal(parseMintResponse('{"access_token":"AT","expires_in":"3600"}', now).ok, false);
});

// ---- opencode --------------------------------------------------------------

test("opencode extractOpencodeKey reads { opencode: { key } }", () => {
  assert.equal(extractOpencodeKey({ opencode: { type: "api", key: "sk-zen" } }), "sk-zen");
  assert.equal(extractOpencodeKey({ opencode: {} }), null);
  assert.equal(extractOpencodeKey({}), null);
  assert.equal(extractOpencodeKey(null), null);
});

// ---- openrouter ------------------------------------------------------------

test("openrouter parseOpenrouterKey surfaces usage_daily as the note line", () => {
  const parsed = parseOpenrouterKey(fixture("openrouter-key"));
  assert.deepEqual(parsed, { note: "key today $1.20" });
  assert.deepEqual(parseOpenrouterKey({ data: {} }), {});
  assert.equal(parseOpenrouterKey({}), null);
  assert.equal(parseOpenrouterKey({ data: { usage_daily: "1.20" } }), null);
});

test("openrouter parseOpenrouterCredits: remaining = total_credits - total_usage", () => {
  assert.deepEqual(parseOpenrouterCredits(fixture("openrouter-credits")), {
    remaining: 74.75,
    unit: "usd",
    source: "api",
  });
  assert.equal(parseOpenrouterCredits({}), null);
  assert.equal(parseOpenrouterCredits({ data: { total_credits: 1 } }), null);
});
