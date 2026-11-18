// The dictation renderer owns both the pill and the microphone. Releasing the
// lifecycle lock alone after a crash leaves every later hotkey talking to a dead
// page. Recover the document, with a grace period for hangs and a crash-loop cap.
function watchDictationRenderer(win, { isQuitting, release, reload, report, exhausted }) {
  const contents = win.webContents;
  let timer = null;
  let closed = false;
  let attempts = [];
  let notified = false;
  let pendingKind = null;
  const clear = () => {
    clearTimeout(timer);
    timer = null;
    pendingKind = null;
  };
  const recover = (force) => {
    timer = null;
    pendingKind = null;
    if (closed || isQuitting() || win.isDestroyed()) return;
    release();
    const now = Date.now();
    attempts = attempts.filter((time) => now - time < 60000);
    if (attempts.length >= 3) {
      if (!notified) {
        notified = true;
        report("recovery-exhausted");
        exhausted();
      }
      return;
    }
    notified = false;
    try {
      // reload alone cannot interrupt a renderer stuck in JavaScript. Electron
      // requires terminating it first so the reload gets a fresh process.
      if (force) {
        // Wait for render-process-gone before reloading. In Electron/Windows a
        // reload issued before that event can be cancelled by the dying process.
        contents.forcefullyCrashRenderer();
        return;
      }
      attempts.push(now);
      report("renderer-reload");
      Promise.resolve(reload()).catch(() => report("renderer-reload-failed"));
    } catch {
      report("renderer-reload-failed");
    }
  };
  const schedule = (delay, kind) => {
    clear();
    pendingKind = kind;
    timer = setTimeout(() => recover(kind === "hang"), delay);
    timer.unref?.();
  };
  const gone = (_event, details = {}) => {
    if (closed || isQuitting() || details.reason === "clean-exit") return;
    release();
    report("renderer-gone", details);
    schedule(1000, "crash");
  };
  const unresponsive = () => {
    if (closed || isQuitting() || timer) return;
    report("renderer-unresponsive");
    schedule(5000, "hang");
  };
  const responsive = () => {
    if (pendingKind === "hang") clear();
  };
  contents.on("render-process-gone", gone);
  win.on("unresponsive", unresponsive);
  win.on("responsive", responsive);
  win.once("closed", () => {
    closed = true;
    clear();
    contents.removeListener("render-process-gone", gone);
    win.removeListener("unresponsive", unresponsive);
    win.removeListener("responsive", responsive);
  });
}

module.exports = { watchDictationRenderer };
