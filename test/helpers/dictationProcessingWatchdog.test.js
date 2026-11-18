const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DICTATION_PROCESSING_STUCK_MS,
  processingStuckAt,
} = require("../../src/helpers/dictationProcessingWatchdog");

test("processing is stuck only once the ceiling has elapsed", () => {
  const startedAt = 1_000;
  assert.equal(processingStuckAt(startedAt, startedAt + DICTATION_PROCESSING_STUCK_MS - 1), false);
  assert.equal(processingStuckAt(startedAt, startedAt + DICTATION_PROCESSING_STUCK_MS), true);
  assert.equal(processingStuckAt(null, startedAt + DICTATION_PROCESSING_STUCK_MS), false);
});
