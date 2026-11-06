const test = require("node:test");
const assert = require("node:assert/strict");

const modelData = require("../../src/models/modelRegistryData.json");

const CHAT_MODELS = [
  "grok-4.7",
  "grok-4.6",
  "grok-4.5",
  "grok-4.3",
  "grok-4.20-0309-reasoning",
  "grok-4.20-0309-non-reasoning",
  "grok-build-0.1",
  "grok-4.20-multi-agent-0309",
];

test("the assistant registry offers xAI's documented chat models and not image, video, or speech", () => {
  const provider = modelData.cloudProviders.find((entry) => entry.id === "xai");
  assert.ok(provider, "xai cloud provider missing");
  assert.equal(provider.defaultModel, "grok-4.7");
  assert.deepEqual(
    provider.models.map((model) => model.id),
    CHAT_MODELS
  );
  for (const model of provider.models) {
    assert.equal(model.supportsVision, true, model.id);
    assert.equal(model.supportsTemperature, false, model.id);
    assert.equal(/imagine|voice|transcribe/i.test(model.id), false, model.id);
  }

  const speech = modelData.transcriptionProviders.find((entry) => entry.id === "xai");
  assert.deepEqual(
    speech.models.map((model) => model.id),
    ["grok-voice-transcribe-2.0"]
  );
  assert.equal(speech.models[0].streaming, true);
});
