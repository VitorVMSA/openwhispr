const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/xaiStreaming.js");

test("xAI note recording opens the documented speech websocket", async () => {
  const { buildXaiSttWebSocketUrl, resolveXaiStreamQuery } = await load();
  const english = await resolveXaiStreamQuery({
    model: "grok-voice-transcribe-2.0",
    language: "en-US",
    sampleRate: 24000,
  });
  assert.equal(english.model, "grok-voice-transcribe-2.0");
  assert.equal(english.language, "en");
  assert.equal(english.format, true);
  assert.equal(english.sampleRate, 24000);
  assert.equal(
    buildXaiSttWebSocketUrl(english),
    "wss://api.x.ai/v1/stt?sample_rate=24000&encoding=pcm&interim_results=true&model=grok-voice-transcribe-2.0&language=en&format=true"
  );

  const retired = await resolveXaiStreamQuery({ model: "grok-stt", language: "mk" });
  assert.equal(retired.model, "grok-voice-transcribe-2.0");
  assert.equal(retired.language, "mk");
  assert.equal(retired.format, false);

  const undetected = await resolveXaiStreamQuery({ language: "auto" });
  assert.equal(undetected.language, undefined);
  assert.equal(undetected.format, false);
});

test("xAI transcript events become interim text or one committed chunk", async () => {
  const { classifyXaiSttMessage } = await load();
  assert.deepEqual(classifyXaiSttMessage({ type: "transcript.created" }), { kind: "ready" });
  assert.deepEqual(
    classifyXaiSttMessage({ type: "transcript.partial", text: "hello", is_final: false }),
    { kind: "partial", text: "hello" }
  );
  assert.deepEqual(
    classifyXaiSttMessage({
      type: "transcript.partial",
      text: "hello there",
      is_final: true,
      speech_final: true,
    }),
    { kind: "final", text: "hello there" }
  );
  assert.equal(classifyXaiSttMessage({ type: "transcript.done", transcript: "hello there" }).kind, "done");
  assert.equal(classifyXaiSttMessage({ type: "error", error: "does not exist" }).kind, "error");
});
