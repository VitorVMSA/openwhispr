import {
  cloudDelete,
  cloudDeleteForAuthGeneration,
  isAuthContextError,
} from "./cloudApi";
import type { AnalyticsSyncContext } from "../types/electron";

const BATCH_SIZE = 200;
export const ANALYTICS_SUMMARY_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const ANALYTICS_REMOTE_REFRESH_DEBOUNCE_MS = 250;

export function subscribeToAnalyticsRefresh(
  refresh: () => void | Promise<void>,
  cloudInsightsActive: boolean
): () => void {
  let disposed = false;
  let refreshRunning = false;
  let trailingLocalRefreshRequested = false;
  let trailingRemoteRefreshRequested = false;
  const runRefresh = async (remoteOnly = false): Promise<void> => {
    if (disposed || (remoteOnly && window.document.visibilityState !== "visible")) {
      return;
    }
    if (refreshRunning) {
      if (remoteOnly) trailingRemoteRefreshRequested = true;
      else trailingLocalRefreshRequested = true;
      return;
    }

    refreshRunning = true;
    try {
      await refresh();
    } catch (error) {
      console.error("Refreshing analytics failed:", error);
    } finally {
      refreshRunning = false;
      const runLocalRefresh = trailingLocalRefreshRequested;
      const runRemoteRefresh = trailingRemoteRefreshRequested;
      trailingLocalRefreshRequested = false;
      trailingRemoteRefreshRequested = false;
      if (!disposed && runLocalRefresh) {
        void runRefresh();
      } else if (!disposed && runRemoteRefresh && window.document.visibilityState === "visible") {
        void runRefresh(true);
      }
    }
  };
  const requestLocalRefresh = (): void => {
    void runRefresh();
  };
  const requestRemoteRefresh = (): void => {
    void runRefresh(true);
  };

  const disposeLocal = window.electronAPI.onAnalyticsChanged?.(requestLocalRefresh);
  requestLocalRefresh();
  if (!cloudInsightsActive) {
    return () => {
      disposed = true;
      disposeLocal?.();
    };
  }

  let remoteRefreshTimeoutId: number | null = null;
  const refreshRemoteWhenVisible = (): void => {
    if (window.document.visibilityState !== "visible") {
      trailingRemoteRefreshRequested = false;
      if (remoteRefreshTimeoutId !== null) {
        window.clearTimeout(remoteRefreshTimeoutId);
        remoteRefreshTimeoutId = null;
      }
      return;
    }
    if (remoteRefreshTimeoutId !== null) window.clearTimeout(remoteRefreshTimeoutId);
    remoteRefreshTimeoutId = window.setTimeout(() => {
      remoteRefreshTimeoutId = null;
      requestRemoteRefresh();
    }, ANALYTICS_REMOTE_REFRESH_DEBOUNCE_MS);
  };

  window.addEventListener("focus", refreshRemoteWhenVisible);
  window.document.addEventListener("visibilitychange", refreshRemoteWhenVisible);
  const intervalId = window.setInterval(
    refreshRemoteWhenVisible,
    ANALYTICS_SUMMARY_REFRESH_INTERVAL_MS
  );

  return () => {
    disposed = true;
    disposeLocal?.();
    window.removeEventListener("focus", refreshRemoteWhenVisible);
    window.document.removeEventListener("visibilitychange", refreshRemoteWhenVisible);
    window.clearInterval(intervalId);
    if (remoteRefreshTimeoutId !== null) window.clearTimeout(remoteRefreshTimeoutId);
  };
}

async function deleteFromCloud(
  path: string,
  body: unknown,
  context?: AnalyticsSyncContext
): Promise<void> {
  if (context) {
    await cloudDeleteForAuthGeneration(path, body, context.authGeneration);
    return;
  }
  await cloudDelete(path, body);
}

async function pushAnalyticsDeletes(context?: AnalyticsSyncContext): Promise<void> {
  while (true) {
    const pending = await window.electronAPI.getPendingAnalyticsDeletes(BATCH_SIZE, context);
    if (pending.length === 0) return;

    const eventIds = pending.map((row) => row.event_id);
    await deleteFromCloud("/api/analytics/events/delete", { eventIds }, context);
    await window.electronAPI.hardDeleteAnalyticsEvents(eventIds, context);
    if (pending.length < BATCH_SIZE) return;
  }
}

async function pushAnalyticsClear(context?: AnalyticsSyncContext): Promise<void> {
  const pending = await window.electronAPI.getPendingAnalyticsClear(context);
  if (!pending) return;

  await deleteFromCloud(
    "/api/analytics/events/delete",
    {
      deleteAll: true,
      clearedThrough: pending.cleared_through,
    },
    context
  );
  await window.electronAPI.completeAnalyticsClear(pending.cleared_through, context);
}

// Erasures and uploads are independent work that happens to share a pass. A
// clear the server keeps refusing must not stop queued deletes from draining,
// and neither may block an upload - running them in one try block meant a
// single stuck request wedged the whole feature until it cleared. Auth-context
// errors still escape, because SyncService uses them to abandon the pass.
async function runStage(name: string, stage: () => Promise<void>): Promise<void> {
  try {
    await stage();
  } catch (error) {
    if (isAuthContextError(error)) throw error;
    console.error(`Analytics ${name} failed:`, error);
  }
}

// One pass at a time. InsightsView flushes on its own schedule - focus, the
// analytics-changed broadcast, a five-minute timer - while SyncService runs
// passes inside SYNC_ALL_LOCK, and the two share no lock. Overlapping passes
// read the same pending rows and post them twice. Queueing rather than
// coalescing keeps a caller that may upload from joining one that may not.
let passQueue: Promise<unknown> = Promise.resolve();

type AnalyticsUploadGate = boolean | (() => boolean | Promise<boolean>);
interface AnalyticsSyncOptions {
  uploadAllowed?: AnalyticsUploadGate;
  context?: AnalyticsSyncContext;
}

export function syncPendingAnalytics(options: AnalyticsSyncOptions = {}): Promise<number> {
  const pass = passQueue.then(
    () => runAnalyticsPass(options),
    () => runAnalyticsPass(options)
  );
  passQueue = pass.catch(() => {});
  return pass;
}

async function runAnalyticsPass({ context }: AnalyticsSyncOptions = {}): Promise<number> {
  // Erasures still go out, so a clear the user already asked for is not left
  // on the account. New counters are not uploaded.
  await runStage("clear", () => pushAnalyticsClear(context));
  await runStage("deletes", () => pushAnalyticsDeletes(context));
  return 0;
}
