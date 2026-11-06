const test = require("node:test");
const assert = require("node:assert/strict");
const { MetaActivation } = require("../../src/helpers/metaActivation");
const { loadAudioManager } = require("./harness/audioManager");

function memoryDb() {
  const streams = [];
  return {
    open: true,
    exec() {},
    prepare(sql) {
      return {
        run(id, accountId) {
          if (sql.startsWith("INSERT INTO streams")) streams.push({ id, account_id: accountId });
          if (sql.startsWith("DELETE FROM streams")) {
            for (let index = streams.length - 1; index >= 0; index -= 1) {
              if (streams[index].account_id === id) streams.splice(index, 1);
            }
          }
        },
        get() {
          return { n: streams.length };
        },
      };
    },
    close() {
      this.open = false;
    },
  };
}

test("activation does not register a device or post word counts", async () => {
  const db = memoryDb();
  const calls = [];
  const manager = new MetaActivation({
    db,
    getScope: () => ({ accountId: "a", authGeneration: 1 }),
    request: async (req) => {
      calls.push(req);
      return { success: true, data: {} };
    },
  });
  manager.start();
  assert.equal(manager.begin(), null);
  manager.finish("id", 12);
  manager.stopCapture("id");
  manager.cancel("id");
  await manager.flush();
  await manager.resync();
  await manager.close();
  await manager.shutdown();
  assert.deepEqual(calls, []);
  db.prepare("INSERT INTO streams(id, account_id) VALUES(?, ?)").run("stream", "a");
  manager.purge("a");
  assert.equal(db.prepare("SELECT count(*) n FROM streams").get().n, 0);
  manager.dispose();
  assert.equal(db.open, false);
});

test("live capture counts original speech with history off, excluding assistant/output-only text", async (t) => {
  const { window, createManager } = await loadAudioManager(t, {
    cachePrefix: "activation-raw-",
    settingsKey: "__activationSettings",
    settings: { dataRetentionEnabled: false },
  });
  const counts = [];
  window.electronAPI.finishActivationCapture = async (id, words) => counts.push({ id, words });
  const manager = createManager();
  await manager._completeActivationCapture("local", {
    success: true,
    rawText: "one",
    text: "expanded ".repeat(300),
  });
  await manager._completeActivationCapture("cloud", {
    success: true,
    rawText: "one two",
    text: "expanded ".repeat(300),
  });
  await manager._completeActivationCapture("assistant", {
    success: true,
    rawText: "one two",
    assistantConversation: {},
  });
  await manager._completeActivationCapture("output-only", {
    success: true,
    text: "expanded ".repeat(300),
  });
  assert.deepEqual(counts, [
    { id: "local", words: 1 },
    { id: "cloud", words: 2 },
    { id: "assistant", words: 0 },
    { id: "output-only", words: 0 },
  ]);
});

test("cancellation during activation IPC cannot restart streaming or retain its late capture", async (t) => {
  const { window, createManager } = await loadAudioManager(t, {
    cachePrefix: "activation-cancel-",
    settingsKey: "__activationCancel",
    settings: {},
  });
  let resolveBegin;
  const cancelled = [];
  window.electronAPI.beginActivationCapture = () =>
    new Promise((resolve) => (resolveBegin = resolve));
  window.electronAPI.cancelActivationCapture = async (id) => cancelled.push(id);
  const manager = createManager({
    micRecovery: { stop() {} },
    cleanupStreamingAudio() {},
    cleanupStreamingListeners() {},
    cleanupPreview: async () => {},
    getStreamingProvider: () => ({ stop: async () => {} }),
    _streamingCancellationGeneration: 0,
    _streamingStartSettlementWaiters: [],
  });
  manager.isRecordingAllowedByPolicy = () => true;
  const starting = manager.startStreamingRecording();
  await Promise.resolve();
  const cancelling = manager.cancelStreamingRecording();
  resolveBegin("late-capture");
  assert.equal(await starting, false);
  await cancelling;
  assert.deepEqual(cancelled, ["late-capture"]);
  assert.equal(manager._activationCapture ?? null, null);
  assert.equal(manager.streamingStartInProgress, false);
});

test("excluded assistant capture still honors immediate startup cancellation", async (t) => {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "activation-assistant-cancel-",
    settingsKey: "__activationAssistantCancel",
    settings: {},
  });
  const states = [];
  const manager = createManager({
    voiceAgentRequested: true,
    micRecovery: { stop() {} },
    cleanupStreamingAudio() {},
    cleanupStreamingListeners() {},
    cleanupPreview: async () => {},
    getStreamingProvider: () => ({ stop: async () => {} }),
    _streamingCancellationGeneration: 0,
    _streamingStartSettlementWaiters: [],
    isRecordingAllowedByPolicy: () => true,
    onStateChange: (state) => states.push(state),
  });
  const start = manager.startStreamingRecording();
  const cancel = manager.cancelStreamingRecording();
  assert.deepEqual(await Promise.all([start, cancel]), [false, true]);
  assert.equal(
    states.some((state) => state.isRecording),
    false
  );
});
