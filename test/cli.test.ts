// cli.test.ts – exit codes, flag validation, rendering, orchestration via the
// main(argv, { providers, dirs }) seam. No network, no real user files.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { main } from "../src/cli.ts";
import type { ProviderModule, ProviderResult } from "../src/core.ts";

interface Captured {
  out: string[];
  err: string[];
  restore: () => void;
}

function captureConsole(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => err.push(a.map(String).join(" "));
  return {
    out,
    err,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

function tempSubtrkDir(): string {
  return mkdtempSync(join(tmpdir(), "subtrk-test-"));
}

function okModule(id: ProviderResult["id"], counter?: { n: number }): ProviderModule {
  return {
    id,
    ttlMs: 300_000,
    probe: async () => {
      if (counter) counter.n += 1;
      return {
        id,
        ok: true,
        stale: false,
        fetchedAt: new Date().toISOString(),
        windows: [
          { kind: "5h", usedPercent: 13, resetsAt: new Date(Date.now() + 5 * 3600_000).toISOString() },
          { kind: "7d", usedPercent: 89, resetsAt: new Date(Date.now() + 5 * 86400_000).toISOString() },
        ],
      };
    },
  };
}

function failingModule(id: ProviderResult["id"]): ProviderModule {
  return {
    id,
    ttlMs: 300_000,
    probe: async () => ({
      id,
      ok: false,
      stale: false,
      fetchedAt: new Date().toISOString(),
      error: { kind: "no-credentials", message: "run agy once to log in", hint: "run agy /usage" },
    }),
  };
}

describe("usage errors (exit 2)", () => {
  it("unknown flag exits 2 with one stderr line", async () => {
    const cap = captureConsole();
    try {
      const code = await main(["status", "--nope"], {
        providers: [okModule("claude")],
        dirs: { subtrk: tempSubtrkDir() },
      });
      assert.equal(code, 2);
      assert.equal(cap.err.length, 1);
      assert.equal(cap.out.length, 0);
    } finally {
      cap.restore();
    }
  });

  it("unknown --provider id exits 2", async () => {
    const cap = captureConsole();
    try {
      const code = await main(["status", "--provider", "kimi"], {
        providers: [okModule("claude")],
        dirs: { subtrk: tempSubtrkDir() },
      });
      assert.equal(code, 2);
      assert.match(cap.err[0], /kimi/);
    } finally {
      cap.restore();
    }
  });

  it("unknown --fields name exits 2", async () => {
    const cap = captureConsole();
    try {
      const code = await main(["status", "--fields", "bogus"], {
        providers: [okModule("claude")],
        dirs: { subtrk: tempSubtrkDir() },
      });
      assert.equal(code, 2);
    } finally {
      cap.restore();
    }
  });

  it("unknown subcommand and extra positional exit 2", async () => {
    const cap = captureConsole();
    try {
      assert.equal(
        await main(["frobnicate"], { providers: [okModule("claude")], dirs: { subtrk: tempSubtrkDir() } }),
        2,
      );
      assert.equal(
        await main(["status", "extra"], { providers: [okModule("claude")], dirs: { subtrk: tempSubtrkDir() } }),
        2,
      );
    } finally {
      cap.restore();
    }
  });
});

describe("help", () => {
  it("--help exits 0 and prints usage to stdout", async () => {
    const cap = captureConsole();
    try {
      assert.equal(await main(["--help"], { providers: [okModule("claude")], dirs: { subtrk: tempSubtrkDir() } }), 0);
      assert.match(cap.out.join("\n"), /usage:/);
      assert.equal(cap.err.length, 0);
    } finally {
      cap.restore();
    }
  });

  it("init --help prints init-specific help", async () => {
    const cap = captureConsole();
    try {
      assert.equal(await main(["init", "--help"], { providers: [], dirs: { subtrk: tempSubtrkDir() } }), 0);
      assert.match(cap.out.join("\n"), /subtrk init/);
    } finally {
      cap.restore();
    }
  });
});

describe("status with a stubbed registry (exit 0)", () => {
  it("renders one line per provider plus the help line", async () => {
    const cap = captureConsole();
    try {
      const code = await main(["status"], {
        providers: [okModule("claude"), failingModule("google")],
        dirs: { subtrk: tempSubtrkDir() },
      });
      assert.equal(code, 0);
      const text = cap.out.join("\n");
      assert.match(text, /^claude\s+5h 13% \(reset \d\d:\d\d\)/m);
      assert.match(text, /^google\s+error: no-credentials – run agy once to log in \(run agy \/usage\)$/m);
      assert.ok(text.includes("help: subtrk status --json | subtrk status --provider <id> | subtrk init"));
      assert.ok(text.includes("next: claude 5h at"));
    } finally {
      cap.restore();
    }
  });

  it("--fields errors,hints keeps failures and appends hints", async () => {
    const cap = captureConsole();
    try {
      const code = await main(["status", "--fields", "errors,hints"], {
        providers: [okModule("claude"), failingModule("google")],
        dirs: { subtrk: tempSubtrkDir() },
      });
      assert.equal(code, 0);
      const text = cap.out.join("\n");
      assert.ok(!/5h 13%/.test(text), "windows filtered out");
      assert.match(text, /error: no-credentials – run agy once to log in \(run agy \/usage\) – hint: run agy \/usage/);
    } finally {
      cap.restore();
    }
  });

  it("--json emits schemaVersion 1 with recheckAfter and providers", async () => {
    const cap = captureConsole();
    try {
      const code = await main(["status", "--json"], {
        providers: [okModule("claude")],
        dirs: { subtrk: tempSubtrkDir() },
      });
      assert.equal(code, 0);
      const parsed = JSON.parse(cap.out[0]);
      assert.equal(parsed.schemaVersion, 1);
      assert.match(parsed.checkedAt, /Z$/);
      assert.match(parsed.recheckAfter, /Z$/);
      assert.equal(parsed.providers.length, 1);
      assert.equal(parsed.providers[0].id, "claude");
      assert.ok(parsed.nextEvent && parsed.nextEvent.atMs > 0);
    } finally {
      cap.restore();
    }
  });

  it("--strict exits 3 when a provider failed, 0 otherwise", async () => {
    const dirs = { subtrk: tempSubtrkDir() };
    const cap = captureConsole();
    try {
      assert.equal(await main(["status", "--strict"], { providers: [okModule("claude")], dirs }), 0);
      assert.equal(await main(["status", "--strict"], { providers: [failingModule("google")], dirs }), 3);
    } finally {
      cap.restore();
    }
  });
});

describe("config interaction", () => {
  it("unreadable config exits 1", async () => {
    const dir = tempSubtrkDir();
    writeFileSync(join(dir, "config.json"), "{broken");
    const cap = captureConsole();
    try {
      assert.equal(await main(["status"], { providers: [okModule("claude")], dirs: { subtrk: dir } }), 1);
    } finally {
      cap.restore();
    }
  });

  it("enabled config filters the registry; empty intersection exits 1", async () => {
    const dir = tempSubtrkDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: ["glm"] }));
    const cap = captureConsole();
    try {
      const code = await main(["status"], {
        providers: [okModule("claude"), okModule("glm")],
        dirs: { subtrk: dir },
      });
      assert.equal(code, 0);
      const ids = cap.out.filter((l) => !l.startsWith("next:") && !l.startsWith("help:")).map((l) => l.split(/\s+/)[0]);
      assert.deepEqual(ids, ["glm"]);
      writeFileSync(join(dir, "config.json"), JSON.stringify({ enabled: ["google"] }));
      assert.equal(await main(["status"], { providers: [okModule("claude")], dirs: { subtrk: dir } }), 1);
    } finally {
      cap.restore();
    }
  });
});

describe("--fresh and the claude 300s floor", () => {
  it("claude serves fresh cache under --fresh and warns; other providers re-probe", async () => {
    const dir = tempSubtrkDir();
    const now = Date.now();
    writeFileSync(
      join(dir, "cache.json"),
      JSON.stringify({
        schemaVersion: 1,
        claude: {
          data: {
            id: "claude",
            ok: true,
            stale: false,
            fetchedAt: new Date(now - 10_000).toISOString(),
            windows: [{ kind: "5h", usedPercent: 5, resetsAt: new Date(now + 3600_000).toISOString() }],
          },
          fetchedAt: now - 10_000,
          ttlMs: 300_000,
        },
        glm: {
          data: {
            id: "glm",
            ok: true,
            stale: false,
            fetchedAt: new Date(now - 10_000).toISOString(),
            windows: [{ kind: "5h", usedPercent: 5, resetsAt: new Date(now + 3600_000).toISOString() }],
          },
          fetchedAt: now - 10_000,
          ttlMs: 60_000,
        },
      }),
    );
    const claudeCounter = { n: 0 };
    const glmCounter = { n: 0 };
    const cap = captureConsole();
    try {
      const code = await main(["status", "--fresh"], {
        providers: [okModule("claude", claudeCounter), okModule("glm", glmCounter)],
        dirs: { subtrk: dir },
      });
      assert.equal(code, 0);
      assert.equal(claudeCounter.n, 0, "claude keeps its floor: fresh cache still served");
      assert.equal(glmCounter.n, 1, "other providers bypass the TTL once");
      assert.ok(cap.err.some((l) => l.includes("claude keeps its 300s floor")));
    } finally {
      cap.restore();
    }
  });
});

describe("scrub reaches rendered output", () => {
  it("registered secrets cannot appear in text or JSON lines", async () => {
    const { registerSecret, clearSecrets } = await import("../src/core.ts");
    clearSecrets();
    registerSecret("sek-live-abc123");
    const cap = captureConsole();
    try {
      const crashing: ProviderModule = {
        id: "openrouter",
        ttlMs: 60_000,
        probe: async () => {
          throw new Error("leak sek-live-abc123 via message");
        },
      };
      const code = await main(["status", "--json"], { providers: [crashing], dirs: { subtrk: tempSubtrkDir() } });
      const text = cap.out.join("\n");
      assert.equal(code, 0);
      assert.ok(!text.includes("sek-live-abc123"), "secret must be scrubbed from JSON output");
      JSON.parse(text); // output stays valid JSON after scrubbing
    } finally {
      cap.restore();
      clearSecrets();
    }
  });
});
