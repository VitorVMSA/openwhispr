const fs = require("fs");
const path = require("path");

const EVENTS = new Set([
  "startup",
  "gpu-gone",
  "renderer-gone",
  "renderer-unresponsive",
  "renderer-reload",
  "renderer-reload-failed",
  "recovery-exhausted",
  "processing-timeout",
  "spool-recovery-deferred",
]);
const REASONS = new Set([
  "clean-exit",
  "abnormal-exit",
  "killed",
  "crashed",
  "oom",
  "launch-failed",
  "integrity-failure",
  "memory-eviction",
]);

function createHealthLog(getDirectory, getVersion) {
  return (event, details = {}) => {
    if (!EVENTS.has(event)) return;
    try {
      const directory = getDirectory();
      fs.mkdirSync(directory, { recursive: true });
      const filename = path.join(directory, "dictation-health.log");
      // Keep two bounded files across launches; never record free-form errors,
      // request bodies, credentials, audio or dictated text.
      if (fs.existsSync(filename) && fs.statSync(filename).size >= 256 * 1024) {
        fs.renameSync(filename, `${filename}.1`);
      }
      const entry = {
        time: new Date().toISOString(),
        version: getVersion(),
        pid: process.pid,
        event,
        ...(REASONS.has(details.reason) ? { reason: details.reason } : {}),
        ...(Number.isInteger(details.exitCode) ? { exitCode: details.exitCode } : {}),
        ...(Number.isSafeInteger(details.chunkCount) && details.chunkCount >= 0
          ? { chunkCount: details.chunkCount }
          : {}),
      };
      fs.appendFileSync(filename, `${JSON.stringify(entry)}\n`);
    } catch {
      // Diagnostics must never prevent recovery (read-only/full disk, etc.).
    }
  };
}

const logDictationHealth = createHealthLog(
  () => path.join(require("electron").app.getPath("userData"), "logs"),
  () => require("electron").app.getVersion()
);

module.exports = { createHealthLog, logDictationHealth };
