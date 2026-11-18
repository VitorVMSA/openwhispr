// Run with: electron scripts/test-dictation-recovery.cjs
// Isolated Electron smoke test: no user profile, microphone, provider or network.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { watchDictationRenderer } = require("../src/helpers/dictationRendererRecovery");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ow-recovery-smoke-"));
app.setPath("userData", profile);
let quitting = false;
let timer;
app.on("window-all-closed", () => {});
app
  .whenReady()
  .then(async () => {
    timer = setTimeout(() => {
      console.error("FAIL: recovery timed out");
      app.exit(1);
    }, 20000);
    const win = new BrowserWindow({
      width: 208,
      height: 120,
      show: false,
      transparent: true,
      frame: false,
      webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
    });
    let releases = 0;
    let reloads = 0;
    watchDictationRenderer(win, {
      isQuitting: () => quitting,
      release: () => releases++,
      reload: () => {
        reloads++;
        win.webContents.reload();
      },
      report: (event) => console.log(event),
      exhausted: () => {
        throw new Error("unexpected crash loop");
      },
    });
    await win.loadURL(
      "data:text/html,<body style='background:rgb(0,120,255)'>dictation ready</body>"
    );
    for (let i = 0; i < 25; i++) {
      win.setSize(466, 168);
      win.setSize(208, 120);
    }
    const reloaded = once(win.webContents, "did-finish-load");
    win.webContents.forcefullyCrashRenderer();
    await reloaded;
    assert.equal(reloads, 1);
    assert.ok(releases >= 1);
    assert.equal(
      await win.webContents.executeJavaScript("document.body.textContent"),
      "dictation ready"
    );
    const frame = await win.webContents.capturePage();
    assert.ok(!frame.isEmpty());
    assert.ok(
      frame.toBitmap().some((value) => value !== 0),
      "recovered frame is not blank"
    );
    console.log("PASS: 25 resize cycles, real renderer crash, automatic reload and rendered frame");
    const recoveredHang = once(win.webContents, "did-finish-load");
    void win.webContents.executeJavaScript("while (true) {}").catch(() => {});
    win.emit("unresponsive");
    await recoveredHang;
    assert.equal(
      await win.webContents.executeJavaScript("document.body.textContent"),
      "dictation ready"
    );
    console.log("PASS: a renderer stuck in an infinite loop recovers");
    quitting = true;
    clearTimeout(timer);
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    clearTimeout(timer);
    app.exit(1);
  });
