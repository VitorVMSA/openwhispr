import logger from "../utils/logger";

// Keeps each recording's chunks in IndexedDB until its result is saved, so the
// audio survives a hung or crashed main process (#2073). The renderer writes
// straight to Chromium's storage backend, which runs off the main process's UI
// thread; a spool routed through IPC waits on that thread instead. Only opening
// the database goes through it, so the dictation window opens it at launch
// (takeInterruptedRecordings), before any recording.
const DB_NAME = "openwhispr-recording-spool";
const STORE = "chunks";
// Never materialize an entire backlog of IndexedDB Blob handles. An abandoned
// overnight recording can contain hundreds of thousands of chunks; getAll()
// then overwhelms Chromium's native Blob IPC even while JavaScript is idle.
const RECOVERY_PAGE_SIZE = 128;
const MAX_RECOVERY_CHUNKS = 16384;
const MAX_RECOVERY_BYTES = 64 * 1024 * 1024;
const MAX_RECOVERY_SESSIONS = 64;

// Every session this page started, finished or not. Anything else in the store
// belongs to a page that closed before its recording was saved.
const pageSessions = new Set();
let dbPromise = null;
let interruptedTaken = false;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(STORE, { keyPath: ["sessionId", "seq"] });
    request.onsuccess = () => {
      // Chromium closes a connection when site data is cleared; reopen on the next write.
      request.result.onclose = () => (dbPromise = null);
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    // Logged once: every later write would hit the same cached failure.
    logger.warn("Recording spool unavailable", { error: error.message }, "audio");
    return null;
  });
  return dbPromise;
}

// Writes run in call order: each one queues its transaction behind the same
// open, and IndexedDB commits overlapping read-write transactions in creation order.
function write(apply) {
  openDb()
    .then((db) => {
      if (!db) return;
      const transaction = db.transaction(STORE, "readwrite");
      // Quota and commit failures abort the transaction without a request error.
      transaction.onabort = () =>
        logger.warn("Recording spool write failed", { error: transaction.error?.message }, "audio");
      apply(transaction.objectStore(STORE));
    })
    .catch((error) =>
      logger.warn("Recording spool write failed", { error: error.message }, "audio")
    );
}

function discardSession(sessionId) {
  write((store) => store.delete(IDBKeyRange.bound([sessionId, 0], [sessionId, Infinity])));
}

export function startRecordingSpool(routeKind = null) {
  const sessionId = crypto.randomUUID();
  const startedAt = Date.now();
  let seq = 0;
  let segments = 0;
  let open = true;
  pageSessions.add(sessionId);

  return {
    // One segment per MediaRecorder: each writes its own WebM stream, and a mic
    // swap mid-recording starts another.
    addSegment(mimeType) {
      const segment = segments++;
      return (chunk) => {
        if (!open) return;
        const record = {
          sessionId,
          seq: seq++,
          segment,
          mimeType,
          routeKind,
          startedAt,
          at: Date.now(),
          chunk,
        };
        write((store) => store.put(record));
      };
    },
    finish() {
      if (!open) return;
      open = false;
      discardSession(sessionId);
    },
  };
}

function readRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function deferRecovery(chunkCount) {
  // Keep the original for explicit recovery; never truncate or delete audio
  // merely because automatic recovery exceeds its resource budget.
  logger.warn("Interrupted recording recovery deferred: resource limit", { chunkCount }, "audio");
}

// Once per page, so a second caller can't save the same recording twice.
export async function takeInterruptedRecordings() {
  if (interruptedTaken) return [];
  interruptedTaken = true;

  const db = await openDb();
  if (!db) return [];
  const store = () => db.transaction(STORE).objectStore(STORE);
  const recordings = [];
  let after = null;
  let bytesRead = 0;
  let chunksRead = 0;
  for (let inspected = 0; inspected < MAX_RECOVERY_SESSIONS; inspected++) {
    // Key-only traversal skips oversized and currently active sessions without
    // asking Chromium to create even one Blob handle for them.
    const cursor = await readRequest(
      store().openKeyCursor(after ? IDBKeyRange.lowerBound(after, true) : null)
    );
    if (!cursor) break;
    const sessionId = cursor.key[0];
    after = [sessionId, Infinity];
    if (pageSessions.has(sessionId)) continue;
    const range = IDBKeyRange.bound([sessionId, 0], after);
    const count = await readRequest(store().count(range));
    if (count > MAX_RECOVERY_CHUNKS - chunksRead) {
      deferRecovery(count);
      continue;
    }

    let lower = [sessionId, 0];
    let exclusive = false;
    let first;
    let lastAt;
    let deferred = false;
    const segments = new Map();
    while (true) {
      const rows = await readRequest(
        store().getAll(IDBKeyRange.bound(lower, after, exclusive), RECOVERY_PAGE_SIZE)
      );
      if (!rows.length) break;
      for (const row of rows) {
        if (bytesRead + row.chunk.size > MAX_RECOVERY_BYTES || chunksRead >= MAX_RECOVERY_CHUNKS) {
          deferred = true;
          break;
        }
        first ??= { startedAt: row.startedAt, routeKind: row.routeKind };
        lastAt = row.at;
        let segment = segments.get(row.segment);
        if (!segment) {
          segment = { mimeType: row.mimeType, chunks: [] };
          segments.set(row.segment, segment);
        }
        bytesRead += row.chunk.size;
        chunksRead++;
        // Own bounded bytes rather than retaining a growing graph of native
        // Blob references (including when the result Blob is assembled).
        segment.chunks.push(await row.chunk.arrayBuffer());
      }
      if (deferred || rows.length < RECOVERY_PAGE_SIZE) break;
      lower = [sessionId, rows[rows.length - 1].seq];
      exclusive = true;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (deferred) {
      deferRecovery(count);
      continue;
    }
    if (first) {
      recordings.push({
        ...first,
        durationMs: lastAt - first.startedAt,
        segments: [...segments.values()].map(
          ({ mimeType, chunks }) => new Blob(chunks, { type: mimeType })
        ),
        discard: () => discardSession(sessionId),
      });
    }
  }
  return recordings;
}
