// opencode – Zen pay-as-you-go, presence check only (D1): no usage/balance API exists.
// Key from env OPENCODE_API_KEY (core merges ~/.subtrk/env) or ~/.local/share/opencode/auth.json.
// ttlMs 0 – bypasses the cache entirely.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderModule, ProviderResult } from "../core.ts";

export const OPENCODE_NOTE = "PAYG – no usage/balance API; inference errors are the only signal";

// Pure: auth.json shape is { opencode: { key: "..." } }.
export function extractOpencodeKey(authObj: unknown): string | null {
  if (typeof authObj !== "object" || authObj === null) return null;
  const key = ((authObj as { opencode?: unknown }).opencode as { key?: unknown } | undefined)?.key;
  return typeof key === "string" && key !== "" ? key : null;
}

async function getSecret(name: string): Promise<string | undefined> {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  try {
    const core = (await import("../core.ts")) as { getSecret?: (n: string) => string | undefined };
    if (typeof core.getSecret === "function") {
      const s = core.getSecret(name);
      if (s) return s;
    }
  } catch {
    // core not present – process.env only
  }
  return undefined;
}

async function registerSecret(secret: string): Promise<void> {
  try {
    const core = (await import("../core.ts")) as { registerSecret?: (s: string) => void };
    if (typeof core.registerSecret === "function") core.registerSecret(secret);
  } catch {
    // core not present – local-variable discipline applies
  }
}

async function probeInner(): Promise<ProviderResult> {
  const fetchedAt = new Date().toISOString();
  let key = await getSecret("OPENCODE_API_KEY");
  if (!key) {
    try {
      key =
        extractOpencodeKey(
          JSON.parse(readFileSync(join(homedir(), ".local", "share", "opencode", "auth.json"), "utf8")),
        ) ?? undefined;
    } catch {
      // absent or unreadable – treated as no key
    }
  }
  if (!key) {
    return {
      id: "opencode",
      ok: false,
      stale: false,
      fetchedAt,
      error: {
        kind: "no-credentials",
        message: "no OPENCODE_API_KEY and no opencode.key in ~/.local/share/opencode/auth.json",
        hint: "run subtrk init or opencode auth login",
        remedy: "subtrk init",
      },
    };
  }
  void registerSecret(key);
  return { id: "opencode", ok: true, stale: false, fetchedAt, plan: "Zen PAYG", note: OPENCODE_NOTE };
}

const provider: ProviderModule = {
  id: "opencode",
  ttlMs: 0,
  probe(): Promise<ProviderResult> {
    return probeInner().catch(
      (e: unknown): ProviderResult => ({
        id: "opencode",
        ok: false,
        stale: false,
        fetchedAt: new Date().toISOString(),
        error: { kind: "http-error", message: `probe failed: ${e instanceof Error ? e.message : "unknown"}` },
      }),
    );
  },
};
export default provider;
