const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// A paused requestAnimationFrame must not leave the pill translated. The
// settle used to be checked only inside that frame callback.
test("a resize mask clears without an animation frame", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  const listeners = new Map();
  let onResize;
  installBrowserGlobals(t, {
    window: {
      innerWidth: 208,
      innerHeight: 120,
      screenX: 100,
      screenY: 800,
      addEventListener(type, fn) {
        listeners.set(type, fn);
      },
      removeEventListener(type, fn) {
        if (listeners.get(type) === fn) listeners.delete(type);
      },
      electronAPI: {
        onMainWindowWillResize(callback) {
          onResize = callback;
          return () => {};
        },
        ackMainWindowResizeMask() {},
      },
    },
  });
  const container = installHookDom(t);
  class PillElement {}
  globalThis.HTMLElement = PillElement;
  const vars = {};
  const pill = new PillElement();
  pill.style = { setProperty: (name, value) => (vars[name] = value) };
  globalThis.document.querySelector = () => pill;

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-resize-compensation-",
  });
  const { useWindowResizeCompensation } = await vite.ssrLoadModule(
    "/hooks/useWindowResizeCompensation.js"
  );

  function Harness() {
    useWindowResizeCompensation();
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
    await Promise.resolve();
  });

  t.mock.timers.enable({ apis: ["setTimeout"] });
  await React.act(async () => {
    onResize({
      anchor: "bottom-right",
      bounds: { x: 0, y: 0, width: 466, height: 112 },
      token: 1,
    });
    listeners.get("resize")?.();
  });
  assert.notEqual(vars["--window-resize-compensation-x"], "0px");

  await React.act(async () => {
    t.mock.timers.tick(900);
  });
  assert.equal(vars["--window-resize-compensation-x"], "0px");
  assert.equal(vars["--window-resize-compensation-y"], "0px");
});
