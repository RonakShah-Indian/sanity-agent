'use strict';

const path = require('path');
const { FileLocatorMemoryRepo, FileRunHistoryRepo, FileDefectRepo } = require('./repositories');

/**
 * Storage factory. Picks repository implementations based on environment.
 *
 *   default                      → file-backed (zero config, what we have today)
 *   QAAGENT_STORAGE=sqlite       → SQLite-backed via better-sqlite3 (opt-in)
 *   QAAGENT_STORAGE=postgres     → Postgres-backed (driver TBD, see sql-backend.js)
 *
 * The repos are passed into profile.js / health.js via the existing
 * factory call sites — no changes downstream.
 */
function createStorage({ root, mode = process.env.QAAGENT_STORAGE || 'file', logger = console } = {}) {
  if (mode === 'sqlite') {
    try {
      const Database = require('better-sqlite3');
      const dbPath = path.join(root, 'data', 'qaagent.db');
      require('fs').mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      const { SqlLocatorMemoryRepo, SqlRunHistoryRepo, SqlDefectRepo } = require('./sql-backend');
      logger.info?.(`[storage] sqlite backend (${dbPath})`);
      return {
        mode: 'sqlite',
        locatorMemory: new SqlLocatorMemoryRepo(db),
        runHistory:    new SqlRunHistoryRepo(db),
        defects:       new SqlDefectRepo(db),
        db,
      };
    } catch (e) {
      logger.warn?.(`[storage] sqlite unavailable (${e.message}); falling back to file backend`);
    }
  }

  return {
    mode: 'file',
    locatorMemory: new FileLocatorMemoryRepo(path.join(root, 'profiles')),
    runHistory:    new FileRunHistoryRepo(path.join(root, 'history')),
    defects:       new FileDefectRepo(path.join(root, 'defects')),
  };
}

module.exports = { createStorage };
