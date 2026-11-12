// A dictation that stays in processing past this never hears another hotkey:
// main drops the press, and the pill is not shown again. Cloud transcription
// has the same ceiling, so a hung request fails instead of holding the lock.
const DICTATION_PROCESSING_STUCK_MS = 120_000;

function processingStuckAt(startedAt, now, limitMs = DICTATION_PROCESSING_STUCK_MS) {
  return typeof startedAt === "number" && Number.isFinite(now) && now - startedAt >= limitMs;
}

module.exports = {
  DICTATION_PROCESSING_STUCK_MS,
  processingStuckAt,
};
