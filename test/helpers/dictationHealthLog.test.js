const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHealthLog } = require("../../src/helpers/dictationHealthLog");

test("health logs persist failure codes without audio, transcript or arbitrary error text", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dictation-health-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = createHealthLog(
    () => dir,
    () => "test"
  );
  log("renderer-gone", { reason: "crashed", exitCode: 1, message: "SECRET", transcript: "SECRET" });
  log("renderer-gone", { reason: "SECRET" });
  log("spool-recovery-deferred", { chunkCount: 204681, sessionId: "SECRET" });
  const output = fs.readFileSync(path.join(dir, "dictation-health.log"), "utf8");
  assert.ok(output.includes('"reason":"crashed"'));
  assert.ok(!output.includes("SECRET"));
  assert.ok(output.includes('"event":"spool-recovery-deferred"'));
  assert.ok(output.includes('"chunkCount":204681'));
  fs.writeFileSync(path.join(dir, "dictation-health.log"), "x".repeat(256 * 1024));
  log("startup");
  assert.ok(fs.existsSync(path.join(dir, "dictation-health.log.1")));
  assert.ok(fs.statSync(path.join(dir, "dictation-health.log")).size < 1024);
});
