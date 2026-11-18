const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { watchDictationRenderer } = require("../../src/helpers/dictationRendererRecovery");

function setup(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const win = new EventEmitter();
  win.webContents = new EventEmitter();
  win.isDestroyed = () => false;
  let quitting = false;
  const events = [];
  win.webContents.forcefullyCrashRenderer = () => {
    events.push("terminated");
    win.webContents.emit("render-process-gone", {}, { reason: "killed" });
  };
  watchDictationRenderer(win, {
    isQuitting: () => quitting,
    release: () => events.push("released"),
    reload: () => events.push("reloaded"),
    report: (event) => events.push(event),
    exhausted: () => events.push("notified"),
  });
  return { win, events, quit: () => (quitting = true) };
}

test("a crashed dictation renderer releases the lock and reloads without waiting for a hotkey", (t) => {
  const { win, events } = setup(t);
  win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
  assert.ok(events.includes("released"));
  t.mock.timers.tick(1000);
  assert.ok(events.includes("reloaded"));
});

test("brief unresponsiveness does not abort a working dictation", (t) => {
  const { win, events } = setup(t);
  win.emit("unresponsive");
  t.mock.timers.tick(1000);
  win.emit("responsive");
  t.mock.timers.tick(10000);
  assert.ok(!events.includes("reloaded"));
  assert.ok(!events.includes("released"));
});

test("a persistent renderer hang is recovered", (t) => {
  const { win, events } = setup(t);
  win.emit("unresponsive");
  t.mock.timers.tick(5000);
  assert.ok(events.includes("released"));
  assert.ok(events.includes("terminated"));
  t.mock.timers.tick(1000);
  assert.ok(events.includes("reloaded"));
  assert.equal(events.filter((event) => event === "reloaded").length, 1);
});

test("repeated crashes are bounded and leave a visible failure instead of a reload loop", (t) => {
  const { win, events } = setup(t);
  for (let i = 0; i < 6; i++) {
    win.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    t.mock.timers.tick(1000);
  }
  assert.equal(events.filter((event) => event === "reloaded").length, 3);
  assert.equal(events.filter((event) => event === "notified").length, 1);
});

for (const ending of ["closed", "quit"]) {
  test(`pending recovery does not reopen a window after ${ending}`, (t) => {
    const { win, events, quit } = setup(t);
    win.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    if (ending === "closed") win.emit("closed");
    else quit();
    t.mock.timers.tick(10000);
    assert.ok(!events.includes("reloaded"));
  });
}
