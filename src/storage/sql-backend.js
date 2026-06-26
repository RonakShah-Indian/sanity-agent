'use strict';

/**
 * SQL-backed repositories (Phase 8, opt-in).
 *
 * Same interface as the file backends — drop-in replacement. Wraps any node
 * SQL driver that exposes:  db.prepare(sql).run(...) / .get(...) / .all(...).
 *
 *   • better-sqlite3        — `new (require('better-sqlite3'))(path)`
 *   • pg                    — easy adapter to the same shape
 *   • node:sqlite (Node 22+) — works directly
 *
 * The schema mirrors the design doc's PostgreSQL tables. We use TEXT for
 * JSON columns so the same SQL works on SQLite and Postgres without dialect
 * branching (Postgres devs can ALTER COLUMN ... TYPE JSONB later if needed).
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS locator_memory (
  site_id     TEXT NOT NULL,
  intent      TEXT NOT NULL,
  selector    TEXT NOT NULL,
  strategy    TEXT NOT NULL,
  confidence  REAL NOT NULL,
  hits        INTEGER NOT NULL DEFAULT 0,
  misses      INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (site_id, intent)
);
CREATE TABLE IF NOT EXISTS site_meta (
  site_id  TEXT PRIMARY KEY,
  locale   TEXT
);
CREATE TABLE IF NOT EXISTS run_history (
  ts                          TEXT NOT NULL,
  site_id                     TEXT NOT NULL,
  url                         TEXT,
  status                      TEXT NOT NULL,
  score                       INTEGER,
  archetype                   TEXT,
  locale                      TEXT,
  region                      TEXT,
  theme_version               TEXT,
  duration_ms                 INTEGER,
  flows                       TEXT,                  -- JSON
  persona_findings_count      INTEGER DEFAULT 0,
  business_impact_per_hour    REAL DEFAULT 0,
  currency                    TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_history_site_ts ON run_history(site_id, ts);
CREATE INDEX IF NOT EXISTS idx_locator_memory_site ON locator_memory(site_id);
CREATE TABLE IF NOT EXISTS defect (
  site_id      TEXT NOT NULL,
  dedupe_key   TEXT NOT NULL,
  title        TEXT,
  severity     TEXT,
  diagnosis    TEXT,
  narrative    TEXT,
  journey      TEXT,
  status       TEXT NOT NULL DEFAULT 'open',
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  resolved_at  TEXT,
  occurrences  INTEGER NOT NULL DEFAULT 1,
  jira_ref     TEXT,
  payload      TEXT,                                                   -- full JSON
  PRIMARY KEY (site_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_defect_last_seen ON defect(last_seen);
CREATE INDEX IF NOT EXISTS idx_defect_status    ON defect(status);
`;

class SqlLocatorMemoryRepo {
  constructor(db) {
    this.db = db;
    this._init();
  }
  _init() { for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) this.db.prepare(stmt + ';').run(); }

  recall(siteId, intent) {
    const row = this.db.prepare(
      'SELECT selector, strategy, confidence, hits, misses FROM locator_memory WHERE site_id = ? AND intent = ?'
    ).get(siteId, intent);
    if (!row || row.confidence < 0.2) return null;
    return row;
  }

  remember(siteId, intent, selector, strategy) {
    const existing = this.db.prepare(
      'SELECT selector, confidence, hits FROM locator_memory WHERE site_id = ? AND intent = ?'
    ).get(siteId, intent);
    const now = new Date().toISOString();

    if (existing && existing.selector === selector) {
      this.db.prepare(
        'UPDATE locator_memory SET confidence = MIN(1.0, confidence + 0.1), hits = hits + 1, updated_at = ? WHERE site_id = ? AND intent = ?'
      ).run(now, siteId, intent);
    } else {
      const seed = { profile: 0.9, role: 0.8, 'semantic-text': 0.6, heuristic: 0.5, 'llm-vision': 0.4, override: 1.0 }[strategy] || 0.5;
      this.db.prepare(
        'INSERT OR REPLACE INTO locator_memory(site_id, intent, selector, strategy, confidence, hits, misses, updated_at) VALUES (?,?,?,?,?,?,?,?)'
      ).run(siteId, intent, selector, strategy, seed, 1, 0, now);
    }
  }

  demote(siteId, intent) {
    const row = this.db.prepare('SELECT confidence FROM locator_memory WHERE site_id = ? AND intent = ?').get(siteId, intent);
    if (!row) return;
    const next = Math.max(0, row.confidence - 0.4);
    if (next <= 0) {
      this.db.prepare('DELETE FROM locator_memory WHERE site_id = ? AND intent = ?').run(siteId, intent);
    } else {
      this.db.prepare(
        'UPDATE locator_memory SET confidence = ?, misses = misses + 1 WHERE site_id = ? AND intent = ?'
      ).run(next, siteId, intent);
    }
  }

  setLocale(siteId, locale) {
    this.db.prepare('INSERT OR REPLACE INTO site_meta(site_id, locale) VALUES (?, ?)').run(siteId, locale);
  }

  summary(siteId) {
    const intents = this.db.prepare(
      'SELECT selector, strategy, confidence FROM locator_memory WHERE site_id = ?'
    ).all(siteId);
    const localeRow = this.db.prepare('SELECT locale FROM site_meta WHERE site_id = ?').get(siteId);
    const avg = intents.length ? intents.reduce((s, v) => s + v.confidence, 0) / intents.length : 0;
    return {
      siteId, locale: localeRow?.locale || null,
      learnedIntents: intents.length,
      avgConfidence: +avg.toFixed(2),
      byStrategy: intents.reduce((m, v) => { m[v.strategy] = (m[v.strategy] || 0) + 1; return m; }, {}),
    };
  }
}

class SqlRunHistoryRepo {
  constructor(db) { this.db = db; new SqlLocatorMemoryRepo(db); /* ensures schema */ }

  append(record) {
    this.db.prepare(
      'INSERT INTO run_history(ts, site_id, url, status, score, archetype, locale, region, theme_version, duration_ms, flows, persona_findings_count, business_impact_per_hour, currency) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      record.ts, record.site, record.url, record.status, record.score,
      record.archetype, record.locale, record.region, record.themeVersion,
      record.durationMs, JSON.stringify(record.flows || []),
      record.persona_findings_count || 0,
      record.business_impact_per_hour || 0, record.currency
    );
  }

  loadLatest(siteId) {
    const row = this.db.prepare(
      'SELECT * FROM run_history WHERE site_id = ? ORDER BY ts DESC LIMIT 1'
    ).get(siteId);
    return row ? this._hydrate(row) : null;
  }

  loadHistory(siteId, limit = 50) {
    const rows = this.db.prepare(
      'SELECT * FROM run_history WHERE site_id = ? ORDER BY ts DESC LIMIT ?'
    ).all(siteId, limit);
    return rows.map(this._hydrate).reverse();
  }

  listSites() {
    return this.db.prepare('SELECT DISTINCT site_id FROM run_history').all().map(r => r.site_id);
  }

  _hydrate(row) {
    return {
      ts: row.ts, site: row.site_id, url: row.url, status: row.status,
      score: row.score, archetype: row.archetype, locale: row.locale,
      region: row.region, themeVersion: row.theme_version,
      durationMs: row.duration_ms,
      flows: row.flows ? JSON.parse(row.flows) : [],
      persona_findings_count: row.persona_findings_count,
      business_impact_per_hour: row.business_impact_per_hour,
      currency: row.currency,
    };
  }
}

class SqlDefectRepo {
  constructor(db) { this.db = db; new SqlLocatorMemoryRepo(db); /* schema */ }

  upsert(defect) {
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT first_seen, occurrences FROM defect WHERE site_id = ? AND dedupe_key = ?')
      .get(defect.siteId, defect.dedupeKey);
    if (!existing) {
      this.db.prepare(
        'INSERT INTO defect(site_id, dedupe_key, title, severity, diagnosis, narrative, journey, status, first_seen, last_seen, occurrences, jira_ref, payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(defect.siteId, defect.dedupeKey, defect.title, defect.severity, defect.diagnosis,
            defect.narrative, defect.journey, 'open', now, now, 1, defect.jiraRef, JSON.stringify(defect.payload || {}));
      return { isNew: true, defect: { ...defect, firstSeen: now, lastSeen: now, occurrences: 1, status: 'open' } };
    }
    this.db.prepare(
      'UPDATE defect SET last_seen = ?, occurrences = occurrences + 1, title = ?, severity = ?, diagnosis = ?, narrative = ?, payload = ? WHERE site_id = ? AND dedupe_key = ?'
    ).run(now, defect.title, defect.severity, defect.diagnosis, defect.narrative, JSON.stringify(defect.payload || {}), defect.siteId, defect.dedupeKey);
    return { isNew: false, defect: { ...defect, lastSeen: now, occurrences: (existing.occurrences || 1) + 1 } };
  }

  listOpen(siteId) {
    return this.db.prepare("SELECT * FROM defect WHERE site_id = ? AND status != 'resolved' ORDER BY last_seen DESC").all(siteId).map(toDefectRow);
  }
  listAll(siteId) {
    return this.db.prepare('SELECT * FROM defect WHERE site_id = ? ORDER BY last_seen DESC').all(siteId).map(toDefectRow);
  }
  listAllSites() {
    return this.db.prepare('SELECT DISTINCT site_id FROM defect').all().map(r => r.site_id);
  }
  queueAll({ openOnly = true } = {}) {
    const sql = openOnly
      ? "SELECT * FROM defect WHERE status != 'resolved' ORDER BY last_seen DESC LIMIT 200"
      : "SELECT * FROM defect ORDER BY last_seen DESC LIMIT 200";
    return this.db.prepare(sql).all().map(toDefectRow);
  }
  resolve(siteId, dedupeKey) {
    const r = this.db.prepare("UPDATE defect SET status='resolved', resolved_at=? WHERE site_id=? AND dedupe_key=?")
      .run(new Date().toISOString(), siteId, dedupeKey);
    return r.changes > 0;
  }
}

function toDefectRow(r) {
  return {
    siteId: r.site_id, dedupeKey: r.dedupe_key,
    title: r.title, severity: r.severity, diagnosis: r.diagnosis,
    narrative: r.narrative, journey: r.journey, status: r.status,
    firstSeen: r.first_seen, lastSeen: r.last_seen, resolvedAt: r.resolved_at,
    occurrences: r.occurrences, jiraRef: r.jira_ref,
    payload: r.payload ? safeJson(r.payload) : null,
  };
}
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

module.exports = { SqlLocatorMemoryRepo, SqlRunHistoryRepo, SqlDefectRepo, SCHEMA };
