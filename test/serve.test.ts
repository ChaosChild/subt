// serve.test.ts — `subt serve` (M2): auth, host allowlist, routing, CORS
// absence. Every request targets our own listening socket on 127.0.0.1 — no
// other network. Stub providers ride the same deps seam as the CLI tests.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type IncomingHttpHeaders } from "node:http";
import { describe, it } from "node:test";
import { startConsole, type ServeHandle } from "../src/serve.ts";
import type { ProviderModule } from "../src/core.ts";

interface Resp {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function get(
  port: number,
  path: string,
  opts: { headers?: Record<string, string>; method?: string } = {},
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function noCors(h: IncomingHttpHeaders): void {
  for (const key of Object.keys(h)) {
    assert.ok(!key.toLowerCase().startsWith("access-control-"), `unexpected CORS header ${key}`);
  }
}

function okModule(id: ProviderModule["id"]): ProviderModule {
  return {
    id,
    ttlMs: 300_000,
    probe: async () => ({
      id,
      ok: true,
      stale: false,
      fetchedAt: new Date().toISOString(),
      windows: [{ kind: "5h", usedPercent: 13, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }],
    }),
  };
}

function failingModule(id: ProviderModule["id"]): ProviderModule {
  return {
    id,
    ttlMs: 300_000,
    probe: async () => ({
      id,
      ok: false,
      stale: false,
      fetchedAt: new Date().toISOString(),
      error: { kind: "no-credentials", message: "no credential file found", hint: "run subt init" },
    }),
  };
}

async function withServer(
  deps: Parameters<typeof startConsole>[0],
  fn: (h: ServeHandle) => Promise<void>,
): Promise<void> {
  const h = await startConsole(deps);
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

describe("subt serve", () => {
  it("401 without a token", async () => {
    const subtDir = mkdtempSync(join(tmpdir(), "subt-serve-"));
    await withServer({ providers: [okModule("claude")], subtDir }, async (h) => {
      const r = await get(h.port, "/api/status");
      assert.equal(r.status, 401);
      assert.deepEqual(JSON.parse(r.body), { error: "unauthorized" });
      noCors(r.headers);
    });
  });

  it("200 with the correct Bearer token — full StatusOutput shape, erroring provider degrades", async () => {
    const subtDir = mkdtempSync(join(tmpdir(), "subt-serve-"));
    await withServer(
      { providers: [okModule("claude"), failingModule("google")], subtDir },
      async (h) => {
        const r = await get(h.port, "/api/status", {
          headers: { authorization: `Bearer ${h.token}` },
        });
        assert.equal(r.status, 200);
        assert.match(r.headers["content-type"] ?? "", /^application\/json/);
        const out = JSON.parse(r.body);
        assert.equal(out.schemaVersion, 1);
        assert.match(out.checkedAt, /Z$/);
        assert.match(out.recheckAfter, /Z$/);
        assert.equal(out.providers.length, 2);
        assert.equal(out.providers[0].id, "claude");
        assert.equal(out.providers[0].ok, true);
        assert.equal(out.providers[0].windows[0].kind, "5h");
        assert.equal(out.providers[1].id, "google");
        assert.equal(out.providers[1].ok, false);
        assert.equal(out.providers[1].error.kind, "no-credentials");
        assert.ok(out.nextEvent, "nextEvent present for the ok provider");
        assert.equal(out.nextEvent.providerId, "claude");
        assert.ok(out.nextEvent.atMs > 0);
        assert.match(out.nextEvent.at, /Z$/);
        noCors(r.headers);
      },
    );
  });

  it("timing-safe compare survives short/long/malformed tokens — all 401", async () => {
    const subtDir = mkdtempSync(join(tmpdir(), "subt-serve-"));
    await withServer({ providers: [okModule("claude")], subtDir }, async (h) => {
      for (const bad of ["abc", `${h.token}ff`, "0".repeat(64), ` ${h.token}`]) {
        const r = await get(h.port, "/api/status", {
          headers: { authorization: `Bearer ${bad}` },
        });
        assert.equal(r.status, 401);
      }
      for (const broken of ["Bearer", `basic ${h.token}`, ""]) {
        const r = await get(h.port, "/api/status", { headers: { authorization: broken } });
        assert.equal(r.status, 401);
      }
      const alive = await get(h.port, "/api/status", {
        headers: { authorization: `Bearer ${h.token}` },
      });
      assert.equal(alive.status, 200, "server still healthy after malformed attempts");
    });
  });

  it("host header allowlist: evil.example → 403, 127.0.0.1:<port> and localhost:<port> pass", async () => {
    const subtDir = mkdtempSync(join(tmpdir(), "subt-serve-"));
    await withServer({ providers: [okModule("claude")], subtDir }, async (h) => {
      const evil = await get(h.port, "/api/status", { headers: { host: "evil.example" } });
      assert.equal(evil.status, 403);
      assert.deepEqual(JSON.parse(evil.body), { error: "forbidden host" });
      const loopback = await get(h.port, "/api/status", {
        headers: { host: `127.0.0.1:${h.port}` },
      });
      assert.equal(loopback.status, 401, "host passed; auth still applies");
      const localhost = await get(h.port, "/api/status", {
        headers: { host: `localhost:${h.port}`, authorization: `Bearer ${h.token}` },
      });
      assert.equal(localhost.status, 200);
      noCors(evil.headers);
    });
  });

  it("/ serves the shell when the file exists; 404 text when missing", async () => {
    const subtDir = mkdtempSync(join(tmpdir(), "subt-serve-"));
    const shellPath = join(subtDir, "console.html");
    writeFileSync(shellPath, "<!doctype html><title>subt</title>");
    await withServer(
      { providers: [okModule("claude")], subtDir, consoleHtmlPath: shellPath },
      async (h) => {
        const r = await get(h.port, "/");
        assert.equal(r.status, 200);
        assert.equal(r.headers["content-type"], "text/html; charset=utf-8");
        assert.equal(
          r.headers["content-security-policy"],
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
        );
        assert.equal(r.body, "<!doctype html><title>subt</title>");
        noCors(r.headers);
      },
    );
    await withServer(
      { providers: [okModule("claude")], subtDir, consoleHtmlPath: join(subtDir, "absent.html") },
      async (h) => {
        const r = await get(h.port, "/");
        assert.equal(r.status, 404);
        assert.match(r.headers["content-type"] ?? "", /^text\/plain/);
      },
    );
  });

  it("unknown routes → 404 JSON; non-GET → 405 JSON; no CORS headers anywhere", async () => {
    const subtDir = mkdtempSync(join(tmpdir(), "subt-serve-"));
    await withServer({ providers: [okModule("claude")], subtDir }, async (h) => {
      const miss = await get(h.port, "/nope", { headers: { authorization: `Bearer ${h.token}` } });
      assert.equal(miss.status, 404);
      assert.deepEqual(JSON.parse(miss.body), { error: "not found" });
      const post = await get(h.port, "/api/status", { method: "POST" });
      assert.equal(post.status, 405);
      assert.deepEqual(JSON.parse(post.body), { error: "method not allowed" });
      const del = await get(h.port, "/", { method: "DELETE" });
      assert.equal(del.status, 405);
      for (const r of [miss, post, del]) noCors(r.headers);
    });
  });
});
