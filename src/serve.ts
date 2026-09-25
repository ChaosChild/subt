// serve.ts — `subt serve` (M2): the localhost web console backend.
// Loopback-only HTTP: the browser shell (src/console.html) is the one static
// route; /api/status replays `subt status --json` behind a per-run Bearer
// token. No CORS headers, ever — same-origin plus the custom Authorization
// header (preflight) is the cross-site defense. Probe work inherits core's
// 10s per-provider budget, so every request is bounded.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collectStatus, errorMessage, scrubValue, type ProviderModule } from "./core.ts";

export interface ServeDeps {
  providers?: ProviderModule[]; // stub registry (tests)
  subtDir?: string; // override ~/.subt (tests)
  consoleHtmlPath?: string; // shell served at / (default: src/console.html next to this module)
  port?: number; // default 0 — random ephemeral port
}

export interface ServeHandle {
  port: number;
  token: string;
  close(): Promise<void>; // resolves once the socket is down
  closed: Promise<void>;
}

const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";

function respond(
  res: ServerResponse,
  code: number,
  body: string | Uint8Array,
  type = "application/json",
  extra: Record<string, string> = {},
): void {
  try {
    res.writeHead(code, { "content-type": `${type}; charset=utf-8`, ...extra });
    res.end(body);
  } catch {
    /* client went away mid-response */
  }
}

// Only 127.0.0.1[:port] / localhost[:port] are ours; anything else stops here,
// before routing (DNS-rebinding and cross-host surfing die on this header).
function hostAllowed(header: string | undefined): boolean {
  const host = (header ?? "").toLowerCase();
  const colon = host.lastIndexOf(":");
  const name = colon > 0 ? host.slice(0, colon) : host;
  const port = colon > 0 ? host.slice(colon + 1) : "";
  return (name === "127.0.0.1" || name === "localhost") && (port === "" || /^\d+$/.test(port));
}

// Length guard first, then a constant-time compare on the utf8 buffers.
function tokenOk(header: string | undefined, token: string): boolean {
  const match = /^Bearer ([^\s]+)$/i.exec(header ?? "");
  const expected = Buffer.from(token, "utf8");
  const given = match ? Buffer.from(match[1], "utf8") : Buffer.alloc(0);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function startConsole(deps: ServeDeps = {}): Promise<ServeHandle> {
  const token = randomBytes(32).toString("hex"); // per run, memory only
  let shell: Buffer | null = null;
  try {
    shell = readFileSync(
      deps.consoleHtmlPath ?? fileURLToPath(new URL("./console.html", import.meta.url)),
    );
  } catch {
    shell = null; // / answers 404 text until the shell file exists
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      if (!hostAllowed(req.headers.host)) {
        respond(res, 403, JSON.stringify({ error: "forbidden host" }));
        return;
      }
      if (req.method !== "GET") {
        respond(res, 405, JSON.stringify({ error: "method not allowed" }));
        return;
      }
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (path === "/") {
        if (shell === null) {
          respond(res, 404, "console shell missing", "text/plain");
          return;
        }
        respond(res, 200, shell, "text/html", { "content-security-policy": CSP });
        return;
      }
      if (path === "/api/status") {
        if (!tokenOk(req.headers.authorization, token)) {
          respond(res, 401, JSON.stringify({ error: "unauthorized" }));
          return;
        }
        void collectStatus({ subtDir: deps.subtDir, providers: deps.providers }).then(
          (c) => respond(res, 200, JSON.stringify(scrubValue(c.out))),
          (err: unknown) => {
            console.error(`subt: ${errorMessage(err)}`);
            respond(res, 500, JSON.stringify({ error: "status unavailable" }));
          },
        );
        return;
      }
      respond(res, 404, JSON.stringify({ error: "not found" }));
    } catch (err: unknown) {
      console.error(`subt: ${errorMessage(err)}`);
      respond(res, 500, JSON.stringify({ error: "internal error" }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.port ?? 0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  const port = addr !== null && typeof addr === "object" ? addr.port : (deps.port ?? 0);
  const closed = new Promise<void>((resolve) => server.once("close", resolve));
  return {
    port,
    token,
    closed,
    close: async () => {
      try {
        server.close();
      } catch {
        /* already closed */
      }
      await closed;
    },
  };
}

// CLI entry: listen, print the one URL — the token rides the fragment and is
// never written anywhere else — then sit quiet until SIGINT/SIGTERM (exit 0).
export async function runServe(deps: ServeDeps = {}): Promise<void> {
  const h = await startConsole(deps);
  console.log(`http://127.0.0.1:${h.port}/#${h.token}`);
  console.log("token auth required — API calls need Authorization: Bearer <token>");
  const stop = (): void => {
    const force = setTimeout(() => process.exit(0), 1000);
    void h.close().finally(() => {
      clearTimeout(force);
      process.exit(0);
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await h.closed;
}
