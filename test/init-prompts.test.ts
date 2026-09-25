// Regression: askHidden must leave stdin usable by later prompts. A for-await
// loop over stdin destroys the stream on break, so the question right after
// a hidden prompt resolved immediately and init exited.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import test from "node:test";
import { askHidden, blHasPlanKey } from "../src/init.ts";

function fakeTty(): PassThrough & { isTTY: boolean; setRawMode: (m: boolean) => void } {
  const s = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (m: boolean) => void };
  s.isTTY = true;
  s.setRawMode = () => {};
  return s;
}

test("askHidden leaves stdin usable for the next prompt", async () => {
  const stdin = fakeTty();
  const hidden = askHidden("key: ", stdin);
  stdin.write("sk-sp-test\r");
  assert.equal(await hidden, "sk-sp-test");

  const rl = createInterface({ input: stdin as never, output: new PassThrough() });
  const q = rl.question("site? ");
  stdin.write("1\n");
  assert.equal((await q).trim(), "1");
  rl.close();
});

test("askHidden handles backspace and ctrl-d", async () => {
  const stdin = fakeTty();
  const hidden = askHidden("key: ", stdin);
  stdin.write("abc\u007f\r");
  assert.equal(await hidden, "ab");
  const again = askHidden("key2: ", stdin);
  stdin.write("xy\u0004");
  assert.equal(await again, "xy");
});

// init skips the alibaba api-key prompt when bl's own config already stores the
// plan key – blHasPlanKey is that skip condition.
test("blHasPlanKey: prepared bl config with token-plan.api_key means the prompt is skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "subtrk-init-"));
  try {
    const cfg = join(dir, "config.json");
    writeFileSync(cfg, JSON.stringify({ "token-plan": { api_key: "sk-sp-stored" } }));
    const parsed = JSON.parse(readFileSync(cfg, "utf8"));
    assert.equal(blHasPlanKey(parsed), true, "stored key -> prompt skipped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(blHasPlanKey({ "token-plan": { api_key: "" } }), false, "empty key still prompts");
  assert.equal(blHasPlanKey({ "token-plan": {} }), false);
  assert.equal(blHasPlanKey({}), false);
  assert.equal(blHasPlanKey(null), false);
  assert.equal(blHasPlanKey({ "token-plan": { api_key: 123 } }), false);
});
