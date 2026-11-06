// Marketing activation used to register this device and post word-count batches
// to /api/activation/device and /api/activation/batch (word counts and
// timestamps, on a 30s timer). Those calls are gone. The method names stay
// because main and the activation IPC handlers still call them; none of them
// talk to the API. Local rows from older builds are deleted on account purge.

class MetaActivation {
  constructor({ db }) {
    this.db = db;
    this.disposed = false;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS streams (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'new',
        registered_at TEXT, complete_through TEXT, last_seq INTEGER NOT NULL DEFAULT 0,
        total_words INTEGER NOT NULL DEFAULT 0, gap INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS captures (
        id TEXT PRIMARY KEY, stream_id TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL, started_at TEXT NOT NULL, occurred_at TEXT,
        seq INTEGER, words INTEGER
      );
    `);
    // Drop captures an older build left unfinished so they cannot be posted later.
    this.db.exec(`DELETE FROM captures WHERE words IS NULL;`);
  }

  start() {}

  async flush() {}

  async resync() {}

  begin() {
    return null;
  }

  stopCapture() {}

  finish() {}

  cancel() {}

  async close() {}

  purge(accountId) {
    if (!this.db?.open) return;
    this.db.prepare("DELETE FROM streams WHERE account_id=?").run(accountId);
  }

  dispose() {
    this.disposed = true;
    if (this.db?.open) this.db.close();
  }

  async shutdown() {
    await this.close();
  }
}

module.exports = { MetaActivation };
