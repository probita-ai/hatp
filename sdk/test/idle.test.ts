import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("idle() keeps a short-lived process alive until the late answer arrives", () => {
  // Its own process, because a test runner keeps the event loop alive and would hide the bug.
  const script = fileURLToPath(new URL("./late-script.ts", import.meta.url));
  const run = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 30_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { state: "NEEDS_ATTENTION", late: true });
});
