'use strict';

/**
 * Repository interfaces (Phase 8 — Learning & Persistence layer)
 *
 * Two repositories, two responsibilities. Both have a file-backed default
 * (zero-config, what we have today) and a SQL-backed implementation
 * (src/storage/sql-backend.js) that switches on when QAAGENT_STORAGE=sqlite.
 *
 *   LocatorMemoryRepo  — recall / remember / demote per (siteId, intent)
 *   RunHistoryRepo     — append / loadLatest / loadHistory / listSites / aggregate
 *
 * The same method signatures work whether the rows live in profiles/*.json,
 * a SQLite file, or a Postgres table. Orchestration code never knows the
 * backend; the factory in src/storage/index.js picks it.
 */

const fs = require('fs');
const path = require('path');
const sanitize = (s) => String(s).replace(/[^a-z0-9._-]/gi, '_');

// =============================================================================
// LocatorMemoryRepo — per-site learned selectors with confidence decay
// =============================================================================

/** File-backed implementation. Matches the existing src/profile.js behavior
 *  1:1 — same disk shape, same recall/remember/demote semantics. */
class FileLocatorMemoryRepo {
  constructor(profileDir) { this.profileDir = profileDir; }

  _file(siteId) { return path.join(this.profileDir, `${sanitize(siteId)}.json`); }
  _load(siteId) {
    try { return JSON.parse(fs.readFileSync(this._file(siteId), 'utf8')); }
    catch { return { siteId, locale: null, intents: {}, updatedAt: null }; }
  }
  _save(siteId, data) {
    fs.mkdirSync(this.profileDir, { recursive: true });
    fs.writeFileSync(this._file(siteId), JSON.stringify(data, null, 2));
  }

  recall(siteId, intent) {
    const data = this._load(siteId);
    const e = data.intents[intent];
    if (!e || e.confidence < 0.2) return null;
    return e;
  }

  remember(siteId, intent, selector, strategy) {
    const data = this._load(siteId);
    const prev = data.intents[intent];
    if (prev && prev.selector === selector) {
      prev.hits += 1;
      prev.confidence = Math.min(1, prev.confidence + 0.1);
    } else {
      const seed = { profile: 0.9, role: 0.8, 'semantic-text': 0.6, heuristic: 0.5, 'llm-vision': 0.4, override: 1.0 }[strategy] || 0.5;
      data.intents[intent] = { selector, strategy, confidence: seed, hits: 1, misses: 0 };
    }
    data.updatedAt = new Date().toISOString();
    this._save(siteId, data);
  }

  demote(siteId, intent) {
    const data = this._load(siteId);
    const e = data.intents[intent];
    if (!e) return;
    e.misses += 1;
    e.confidence = Math.max(0, e.confidence - 0.4);
    if (e.confidence <= 0) delete data.intents[intent];
    this._save(siteId, data);
  }

  setLocale(siteId, locale) {
    const data = this._load(siteId);
    data.locale = locale;
    this._save(siteId, data);
  }

  summary(siteId) {
    const data = this._load(siteId);
    const intents = Object.entries(data.intents);
    const avg = intents.length ? intents.reduce((s, [, v]) => s + v.confidence, 0) / intents.length : 0;
    return {
      siteId, locale: data.locale, learnedIntents: intents.length,
      avgConfidence: +avg.toFixed(2),
      byStrategy: intents.reduce((m, [, v]) => { m[v.strategy] = (m[v.strategy] || 0) + 1; return m; }, {}),
    };
  }
}

// =============================================================================
// RunHistoryRepo — append-only per-merchant run records + aggregate queries
// =============================================================================

/** File-backed: one JSONL line per run, per site. Matches src/health.js. */
class FileRunHistoryRepo {
  constructor(historyDir) { this.historyDir = historyDir; }

  _file(siteId) { return path.join(this.historyDir, `${sanitize(siteId)}.jsonl`); }

  append(record) {
    fs.mkdirSync(this.historyDir, { recursive: true });
    fs.appendFileSync(this._file(record.site), JSON.stringify(record) + '\n');
  }

  loadLatest(siteId) {
    const f = this._file(siteId);
    if (!fs.existsSync(f)) return null;
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
    if (!lines.length) return null;
    try { return JSON.parse(lines[lines.length - 1]); } catch { return null; }
  }

  loadHistory(siteId, limit = 50) {
    const f = this._file(siteId);
    if (!fs.existsSync(f)) return [];
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).slice(-limit);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  listSites() {
    if (!fs.existsSync(this.historyDir)) return [];
    return fs.readdirSync(this.historyDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace(/\.jsonl$/, ''));
  }
}

// =============================================================================
// DefectRepo — persistent bug records with dedupe-key updates (Phase 8 follow-up)
// =============================================================================

/**
 * One row per (siteId, dedupeKey). Re-finding the same defect updates
 * last_seen + occurrences instead of creating a duplicate (mirrors the
 * design's "dedupe key so re-runs update rather than duplicate" rule).
 */
class FileDefectRepo {
  constructor(dir) { this.dir = dir; }

  _file(siteId) { return path.join(this.dir, `${sanitize(siteId)}.jsonl`); }
  _all(siteId) {
    if (!fs.existsSync(this._file(siteId))) return [];
    return fs.readFileSync(this._file(siteId), 'utf8').trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  _save(siteId, list) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this._file(siteId), list.map(d => JSON.stringify(d)).join('\n') + (list.length ? '\n' : ''));
  }

  /** Upsert by dedupeKey. Returns { isNew, defect }. */
  upsert(defect) {
    const list = this._all(defect.siteId);
    const now = new Date().toISOString();
    const idx = list.findIndex(d => d.dedupeKey === defect.dedupeKey);
    if (idx === -1) {
      list.push({ ...defect, firstSeen: now, lastSeen: now, occurrences: 1, status: 'open' });
      this._save(defect.siteId, list);
      return { isNew: true, defect: list[list.length - 1] };
    } else {
      list[idx] = { ...list[idx], ...defect, lastSeen: now, occurrences: (list[idx].occurrences || 1) + 1 };
      this._save(defect.siteId, list);
      return { isNew: false, defect: list[idx] };
    }
  }

  listOpen(siteId) { return this._all(siteId).filter(d => d.status !== 'resolved'); }
  listAll(siteId)  { return this._all(siteId); }

  listAllSites() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace(/\.jsonl$/, ''));
  }

  /** Flatten all defects across all sites for the dashboard queue view. */
  queueAll({ openOnly = true } = {}) {
    return this.listAllSites().flatMap(s => openOnly ? this.listOpen(s) : this.listAll(s))
      .sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));
  }

  resolve(siteId, dedupeKey) {
    const list = this._all(siteId);
    const d = list.find(x => x.dedupeKey === dedupeKey);
    if (d) { d.status = 'resolved'; d.resolvedAt = new Date().toISOString(); this._save(siteId, list); }
    return !!d;
  }
}

module.exports = { FileLocatorMemoryRepo, FileRunHistoryRepo, FileDefectRepo };
