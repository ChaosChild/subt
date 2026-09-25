// google – Google AI Pro, best-effort. Credential discovery order:
//   1. Windows Credential Manager generic credential "gemini:antigravity" (agy's OAuth
//      blob, UTF-8 JSON) – read with a FIXED literal PowerShell P/Invoke script, win32 only.
//   2. ~/.gemini/oauth_creds.json (legacy gemini: access_token, refresh_token,
//      expiry_date ms) – expired tokens are refreshed and written back to the same file.
//   3. ~/.gemini/antigravity-cli/antigravity-oauth-token (legacy antigravity).
// The implicit/*.pb files under antigravity-cli are encrypted trajectory data – never read.
// Quota: POST /v1internal:retrieveUserQuotaSummary with an EMPTY {} body (the request
// proto has no other fields; unknown fields 400). No loadCodeAssist step. agy owns
// token refresh: on 401 the credential is re-read once (agy refreshes the keyring blob
// in place while running) and the call retried once – subtrk never refreshes keyring tokens.

import { execFile } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderError, ProviderModule, ProviderResult, Window } from "../core.ts";

const TIMEOUT_MS = 10_000;
const KEYRING_TIMEOUT_MS = 5_000; // Add-Type compile is slow on its first run
const MAX_RESPONSE_CHARS = 1_000_000;
const SKEW_MS = 60_000;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PRIMARY_HOST = "https://cloudcode-pa.googleapis.com";
const FALLBACK_HOST = "https://daily-cloudcode-pa.googleapis.com";
const QUOTA_PATH = "/v1internal:retrieveUserQuotaSummary";

// The OAuth client constants for legacy file-lineage refresh live in ~/.subtrk/env
// (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / ANTIGRAVITY_CLIENT_ID). They are
// PUBLIC installed-app values – `subtrk init` fetches them from upstream sources
// – kept out of this repo so secret scanners stay quiet.
async function envClientValue(name: string): Promise<string | undefined> {
  try {
    const core = (await import("../core.ts")) as { getSecret?: (n: string) => string | undefined };
    return core.getSecret?.(name);
  } catch {
    return undefined;
  }
}

// FIXED literal – nothing is ever interpolated into it. CredReadW (CharSet Unicode)
// reads the generic credential "gemini:antigravity" (type 1); CredFree releases the
// buffer; the CredentialBlob bytes are copied verbatim to stdout (UTF-8 JSON).
const AGY_KEYRING_PS_SCRIPT = `$src = 'using System;using System.Runtime.InteropServices;public static class SubtrkCredRead { [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; } [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode)] public static extern bool CredRead(string target, int type, int flags, out IntPtr credPtr); [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred); }';
Add-Type -TypeDefinition $src;
$p = [IntPtr]::Zero;
if (-not [SubtrkCredRead]::CredRead('gemini:antigravity', 1, 0, [ref]$p)) { exit 1 }
try { $c = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][SubtrkCredRead+CREDENTIAL]); $n = $c.CredentialBlobSize; $b = New-Object byte[] $n; [Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $b, 0, $n); $s = [Console]::OpenStandardOutput(); $s.Write($b, 0, $n); $s.Flush() } finally { [SubtrkCredRead]::CredFree($p) }`;

export interface GoogleCreds {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs?: number;
  lineage: "gemini" | "antigravity" | "agy-keyring";
  raw?: Record<string, unknown>; // original JSON object, for gemini-lineage write-back
}

export interface AgyKeyringToken {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs?: number;
}

// Pure: agy keyring blob { token: { access_token, refresh_token?, expiry? (RFC3339) } }.
export function parseAgyKeyringBlob(obj: unknown): AgyKeyringToken | null {
  if (typeof obj !== "object" || obj === null) return null;
  const token = (obj as { token?: unknown }).token;
  if (typeof token !== "object" || token === null) return null;
  const t = token as { access_token?: unknown; refresh_token?: unknown; expiry?: unknown };
  if (typeof t.access_token !== "string" || t.access_token === "") return null;
  const out: AgyKeyringToken = { accessToken: t.access_token };
  if (typeof t.refresh_token === "string" && t.refresh_token !== "") out.refreshToken = t.refresh_token;
  if (typeof t.expiry === "string") {
    const ms = Date.parse(t.expiry);
    if (Number.isFinite(ms)) out.expiresAtMs = ms;
  }
  return out;
}

// Pure: legacy gemini oauth_creds.json shape.
export function parseGeminiCreds(obj: unknown): GoogleCreds | null {
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as { access_token?: unknown; refresh_token?: unknown; expiry_date?: unknown };
  if (typeof o.access_token !== "string" || o.access_token === "") return null;
  const creds: GoogleCreds = { accessToken: o.access_token, lineage: "gemini", raw: o as Record<string, unknown> };
  if (typeof o.refresh_token === "string" && o.refresh_token !== "") creds.refreshToken = o.refresh_token;
  if (typeof o.expiry_date === "number" && Number.isFinite(o.expiry_date)) creds.expiresAtMs = o.expiry_date;
  return creds;
}

// Pure: antigravity token file – JSON with access_token if it parses as such, else the
// bare token string (no refresh, no known expiry).
export function parseAntigravityTokenFile(text: string): GoogleCreds | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  try {
    const obj: unknown = JSON.parse(trimmed);
    if (
      typeof obj === "object" &&
      obj !== null &&
      typeof (obj as { access_token?: unknown }).access_token === "string"
    ) {
      const creds = parseGeminiCreds(obj);
      return creds ? { ...creds, lineage: "antigravity" } : null;
    }
    return null;
  } catch {
    return { accessToken: trimmed, lineage: "antigravity" };
  }
}

// Pure: past expiry with the 60s clock skew; unknown expiry counts as unexpired.
export function googleExpired(creds: GoogleCreds, nowMs: number): boolean {
  if (creds.expiresAtMs === undefined) return false;
  return nowMs >= creds.expiresAtMs - SKEW_MS;
}

// Shared expired-token wording for the keyring pre-flight and the 401-after-reread
// path – one object, so both triggers give operators identical guidance.
const KEYRING_EXPIRED_ERROR: ProviderError = {
  kind: "expired-token",
  message: "token rejected (401, also after one credential re-read)",
  hint: "launch agy once so it refreshes its token, then re-run",
  remedy: "re-login inside agy",
};

// Pure: probe-path pre-flight – an expired blob cannot survive the quota fetch, so
// report the shared expired-token error up front; null when the fetch is worth trying.
export function googlePreFlight(creds: GoogleCreds, nowMs: number): ProviderError | null {
  if (typeof creds.expiresAtMs !== "number" || !Number.isFinite(creds.expiresAtMs)) return null;
  if (!googleExpired(creds, nowMs)) return null;
  return KEYRING_EXPIRED_ERROR;
}

// Pure: "Gemini Models" -> "gemini-models".
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Pure: "gemini-weekly"-style bucketId -> window kind when the `window` field is absent.
function kindFromBucketId(bucketId: unknown): string | null {
  if (typeof bucketId !== "string" || bucketId === "") return null;
  const lower = bucketId.toLowerCase();
  if (lower.includes("weekly")) return "weekly";
  if (lower.includes("5h")) return "5h";
  return slugify(bucketId) || null;
}

// Pure: groups[].displayName -> scope, buckets[] -> windows. null when groups is absent
// or not an array; empty groups array is a valid (degraded) shape -> [].
export function parseGoogleSummary(body: unknown): Window[] | null {
  if (typeof body !== "object" || body === null) return null;
  const groups = (body as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return null;
  const windows: Window[] = [];
  for (const rawGroup of groups) {
    if (typeof rawGroup !== "object" || rawGroup === null) continue;
    const g = rawGroup as { displayName?: unknown; buckets?: unknown };
    const scope = typeof g.displayName === "string" && g.displayName !== "" ? slugify(g.displayName) : undefined;
    if (!Array.isArray(g.buckets)) continue;
    for (const rawBucket of g.buckets) {
      if (typeof rawBucket !== "object" || rawBucket === null) continue;
      const b = rawBucket as { window?: unknown; bucketId?: unknown; remainingFraction?: unknown; resetTime?: unknown };
      if (typeof b.remainingFraction !== "number" || typeof b.resetTime !== "string") continue;
      const kind = typeof b.window === "string" && b.window !== "" ? b.window : kindFromBucketId(b.bucketId);
      if (kind === null) continue;
      const t = Date.parse(b.resetTime);
      if (!Number.isFinite(t)) continue;
      const w: Window = { kind, resetsAt: new Date(t).toISOString(), remainingFraction: b.remainingFraction };
      if (scope) w.scope = scope;
      windows.push(w);
    }
  }
  return windows;
}

type FetchOutcome =
  | { ok: true; status: number; text: string }
  | { ok: false; status?: number; text?: string; error: ProviderError };

function retryAfterMs(v: string | null): number | undefined {
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

async function fetchText(url: string, init: RequestInit): Promise<FetchOutcome> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const len = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(len) && len > MAX_RESPONSE_CHARS) {
      return { ok: false, status: res.status, error: { kind: "parse-failure", message: "response exceeds 1MB cap" } };
    }
    const text = await res.text();
    if (text.length > MAX_RESPONSE_CHARS) {
      return { ok: false, status: res.status, error: { kind: "parse-failure", message: "response exceeds 1MB cap" } };
    }
    if (res.status === 429) {
      return {
        ok: false,
        status: res.status,
        text,
        error: {
          kind: "rate-limited",
          message: "rate limited (429)",
          retryAfterMs: retryAfterMs(res.headers.get("retry-after")),
        },
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        text,
        error: { kind: "http-error", message: `HTTP ${res.status}`, status: res.status },
      };
    }
    return { ok: true, status: res.status, text };
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      return { ok: false, error: { kind: "timeout", message: `request timed out after ${TIMEOUT_MS / 1000}s` } };
    }
    return {
      ok: false,
      error: { kind: "http-error", message: `network error: ${e instanceof Error ? e.message : "unknown"}` },
    };
  } finally {
    clearTimeout(timer);
  }
}

function postJson(url: string, body: unknown, token: string): Promise<FetchOutcome> {
  return fetchText(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "antigravity" },
    body: JSON.stringify(body),
  });
}

function postForm(url: string, params: URLSearchParams): Promise<FetchOutcome> {
  return fetchText(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
}

async function registerSecret(secret: string): Promise<void> {
  try {
    const core = (await import("../core.ts")) as { registerSecret?: (s: string) => void };
    if (typeof core.registerSecret === "function") core.registerSecret(secret);
  } catch {
    // core not present – local-variable discipline applies
  }
}

async function registerCreds(creds: GoogleCreds): Promise<void> {
  await registerSecret(creds.accessToken);
  if (creds.refreshToken) await registerSecret(creds.refreshToken);
}

function readTextIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// Credential Manager read: fixed-literal script, argument-vector spawn (no shell).
// Any failure – spawn error, non-zero exit, timeout, non-JSON stdout – is simply "no
// keyring credential". Blob text (a secret) never reaches an error message.
function runKeyringScript(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", AGY_KEYRING_PS_SCRIPT],
        { timeout: KEYRING_TIMEOUT_MS, windowsHide: true, maxBuffer: 1_000_000 },
        (err, stdout) => resolve(err ? null : String(stdout ?? "")),
      );
    } catch {
      resolve(null);
    }
  });
}

async function readKeyringCreds(): Promise<GoogleCreds | null> {
  if (process.platform !== "win32") return null;
  const text = await runKeyringScript();
  if (text === null) return null;
  try {
    const blob = parseAgyKeyringBlob(JSON.parse(text));
    return blob ? { ...blob, lineage: "agy-keyring" } : null;
  } catch {
    return null;
  }
}

async function discoverCreds(): Promise<{ creds: GoogleCreds; path?: string } | null> {
  const keyring = await readKeyringCreds();
  if (keyring) return { creds: keyring };
  const geminiPath = join(homedir(), ".gemini", "oauth_creds.json");
  const geminiText = readTextIfExists(geminiPath);
  if (geminiText !== null) {
    try {
      const creds = parseGeminiCreds(JSON.parse(geminiText));
      if (creds) return { creds, path: geminiPath };
    } catch {
      // fall through to the antigravity lineage
    }
  }
  const antiPath = join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
  const antiText = readTextIfExists(antiPath);
  if (antiText !== null) {
    const creds = parseAntigravityTokenFile(antiText);
    if (creds) return { creds, path: antiPath };
  }
  return null;
}

// Best-effort write-back of the refreshed token to the SAME gemini file (temp+rename);
// gemini-cli rewrites it too – tolerate races, swallow all errors.
function writeBackCreds(path: string, raw: Record<string, unknown>, accessToken: string, expiresAtMs: number): void {
  try {
    raw.access_token = accessToken;
    raw.expiry_date = expiresAtMs;
    const tmp = `${path}.subtrk-tmp`;
    writeFileSync(tmp, JSON.stringify(raw), "utf8");
    renameSync(tmp, path);
  } catch {
    // best-effort only
  }
}

type RefreshOutcome = { ok: true; accessToken: string; expiresAtMs: number } | { ok: false; error: ProviderError };

async function refreshAccessToken(creds: GoogleCreds): Promise<RefreshOutcome> {
  const missing = (what: string): RefreshOutcome => ({
    ok: false,
    error: {
      kind: "no-credentials",
      message: `${what} not configured`,
      hint: "run subtrk init (fetches the public values) or set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in ~/.subtrk/env",
    },
  });
  const clientId = await envClientValue(creds.lineage === "gemini" ? "GOOGLE_CLIENT_ID" : "ANTIGRAVITY_CLIENT_ID");
  if (!clientId) return missing(creds.lineage === "gemini" ? "GOOGLE_CLIENT_ID" : "ANTIGRAVITY_CLIENT_ID");
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: creds.refreshToken ?? "",
    client_id: clientId,
  });
  if (creds.lineage === "gemini") {
    const clientSecret = await envClientValue("GOOGLE_CLIENT_SECRET");
    if (!clientSecret) return missing("GOOGLE_CLIENT_SECRET");
    params.set("client_secret", clientSecret);
  }
  const out = await postForm(TOKEN_URL, params);
  if (!out.ok) {
    let code = "";
    if (typeof out.text === "string") {
      try {
        code = String((JSON.parse(out.text) as { error?: unknown }).error ?? "");
      } catch {
        // body not JSON – no error code available
      }
    }
    if (code === "invalid_client") {
      return {
        ok: false,
        error: {
          kind: "expired-token",
          message: "token refresh rejected (invalid_client)",
          hint: "log in again with agy",
          remedy: "re-login inside agy",
        },
      };
    }
    return { ok: false, error: out.error };
  }
  let body: unknown;
  try {
    body = JSON.parse(out.text);
  } catch {
    return { ok: false, error: { kind: "parse-failure", message: "refresh response was not JSON" } };
  }
  const accessToken = (body as { access_token?: unknown }).access_token;
  const expiresIn = (body as { expires_in?: unknown }).expires_in;
  if (
    typeof accessToken !== "string" ||
    accessToken === "" ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn)
  ) {
    return { ok: false, error: { kind: "parse-failure", message: "refresh response missing access_token/expires_in" } };
  }
  return { ok: true, accessToken, expiresAtMs: Date.now() + expiresIn * 1000 };
}

function fail(error: ProviderError, fetchedAt: string): ProviderResult {
  return { id: "google", ok: false, stale: false, fetchedAt, error };
}

async function probeInner(): Promise<ProviderResult> {
  const fetchedAt = new Date().toISOString();
  const found = await discoverCreds();
  if (!found) {
    return fail(
      {
        kind: "no-credentials",
        message: "no Gemini/Antigravity credential found (keyring and file lineages)",
        hint: "install agy (irm https://antigravity.google/cli/install.ps1 | iex) and log in once",
      },
      fetchedAt,
    );
  }
  await registerCreds(found.creds);

  let token = found.creds.accessToken;
  // Keyring tokens are refreshed in place by agy – no local refresh; the pre-flight
  // below fails an already-expired blob fast and the 401 path re-reads the blob once
  // for the rest. File lineages keep the expiry check + refresh (write-back for the
  // gemini lineage only).
  if (found.creds.lineage === "agy-keyring") {
    // Expired per blob -> skip the doomed fetch; avoids the timeout masking the real error.
    const pre = googlePreFlight(found.creds, Date.now());
    if (pre) return fail(pre, fetchedAt);
  } else if (googleExpired(found.creds, Date.now())) {
    if (!found.creds.refreshToken) {
      return fail(
        {
          kind: "expired-token",
          message: "access token expired and no refresh_token in the credential file",
          hint: "log in again with agy",
          remedy: "re-login inside agy",
        },
        fetchedAt,
      );
    }
    const refreshed = await refreshAccessToken(found.creds);
    if (!refreshed.ok) return fail(refreshed.error, fetchedAt);
    token = refreshed.accessToken;
    if (found.creds.lineage === "gemini" && found.creds.raw && found.path) {
      writeBackCreds(found.path, found.creds.raw, refreshed.accessToken, refreshed.expiresAtMs);
    }
  }

  let out = await postJson(`${PRIMARY_HOST}${QUOTA_PATH}`, {}, token);
  if (!out.ok && out.status === 401) {
    // agy may have refreshed its keyring blob in place – re-read once, retry once.
    const reread = await discoverCreds();
    if (reread) {
      await registerCreds(reread.creds);
      token = reread.creds.accessToken;
    }
    out = await postJson(`${PRIMARY_HOST}${QUOTA_PATH}`, {}, token);
    if (!out.ok && out.status === 401) {
      return fail(KEYRING_EXPIRED_ERROR, fetchedAt);
    }
  }
  if (!out.ok && (out.status === 403 || out.status === 404)) {
    const retry = await postJson(`${FALLBACK_HOST}${QUOTA_PATH}`, {}, token);
    if (!retry.ok) {
      return fail(
        {
          kind: "not-readable-remotely",
          message: `quota summary failed on both hosts (HTTP ${out.status} then ${retry.status ?? retry.error.kind})`,
          hint: "run agy /usage",
        },
        fetchedAt,
      );
    }
    out = retry;
  }
  if (!out.ok) return fail(out.error, fetchedAt);

  let summary: unknown;
  try {
    summary = JSON.parse(out.text);
  } catch {
    return fail({ kind: "parse-failure", message: "quota summary was not JSON" }, fetchedAt);
  }
  const windows = parseGoogleSummary(summary);
  if (windows === null) return fail({ kind: "parse-failure", message: "quota summary shape unrecognized" }, fetchedAt);
  if (windows.length === 0) {
    return fail(
      { kind: "not-readable-remotely", message: "quota groups empty or free-tier shaped", hint: "run agy /usage" },
      fetchedAt,
    );
  }
  return { id: "google", ok: true, stale: false, fetchedAt, windows };
}

const provider: ProviderModule = {
  id: "google",
  ttlMs: 60_000,
  probe(): Promise<ProviderResult> {
    return probeInner().catch(
      (e: unknown): ProviderResult =>
        fail(
          { kind: "http-error", message: `probe failed: ${e instanceof Error ? e.message : "unknown"}` },
          new Date().toISOString(),
        ),
    );
  },
};
export default provider;
