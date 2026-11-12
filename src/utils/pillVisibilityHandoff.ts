import { waitForVisualFrames } from "./visualFrame";

interface PillVisibilityHandoffOptions {
  onSuppressedChange: (suppressed: boolean) => void;
  shouldAutoHide?: () => boolean;
  hideWindow?: () => Promise<unknown> | undefined;
  waitForFrames?: () => Promise<void>;
  // A resize that never answers must not leave the pill at opacity 0. The
  // native window stays visible, so the corner looks empty.
  settleTimeoutMs?: number;
}

/**
 * Hide the persistent pill root across a risky native resize, independently of
 * React renders. Two callers own one each: the dictation-error return and the
 * panel return (useMainWindowSizeOwner). A fresh suppress invalidates every
 * pending release, while a successful release waits for native geometry and
 * compositor frames before exposing the pill again.
 */
export function createPillVisibilityHandoff({
  onSuppressedChange,
  shouldAutoHide = () => false,
  hideWindow = () => undefined,
  waitForFrames = waitForVisualFrames,
  settleTimeoutMs = 2000,
}: PillVisibilityHandoffOptions) {
  let generation = 0;
  let suppressed = false;
  let disposed = false;

  const publish = (next: boolean) => {
    if (suppressed === next) return;
    suppressed = next;
    onSuppressedChange(next);
  };

  return {
    suppress() {
      generation += 1;
      publish(true);
    },

    async releaseAfter(settleBounds: () => Promise<unknown>) {
      const releaseGeneration = ++generation;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      const settleTimeout = new Promise((_, reject) => {
        settleTimer = setTimeout(
          () => reject(new Error("pill-handoff-timeout")),
          settleTimeoutMs
        );
      });
      // Keep a late rejection off the unhandled path once the timeout won.
      const boundsPromise = Promise.resolve().then(() => settleBounds());
      boundsPromise.catch(() => {});
      try {
        await Promise.race([boundsPromise, settleTimeout]);
        if (disposed || releaseGeneration !== generation) {
          return { released: false, superseded: true };
        }

        if (shouldAutoHide()) {
          await hideWindow();
        } else {
          await waitForFrames();
        }
      } catch {
        // A destroyed native window, or a resize that never answers, must not
        // strand the next renderer mount in a permanently suppressed state.
      } finally {
        clearTimeout(settleTimer);
      }

      if (disposed || releaseGeneration !== generation) {
        return { released: false, superseded: true };
      }
      publish(false);
      return { released: true, superseded: false };
    },

    cancel() {
      generation += 1;
    },

    dispose() {
      disposed = true;
      generation += 1;
    },
  };
}
