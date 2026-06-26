'use strict';

const path = require('path');
const { FileLocatorMemoryRepo } = require('./storage/repositories');

/**
 * SiteProfile — per-site learned memory.
 *
 * Phase 8 refactor: this class now delegates to a LocatorMemoryRepo, so the
 * storage backend (file / SQLite / Postgres) is interchangeable. The public
 * shape (recall, remember, demote, setLocale, summary) is unchanged so every
 * caller works without modification.
 *
 * Backwards compat: `new SiteProfile(siteId, dir)` still works — the file
 * backend is constructed from the passed directory. Callers that want a
 * SQL backend instead inject a repo:  `new SiteProfile(siteId, null, { repo })`.
 */
class SiteProfile {
  constructor(siteId, dir, opts = {}) {
    this.siteId = siteId;
    this.repo = opts.repo || new FileLocatorMemoryRepo(dir);
  }

  recall(intent)                                  { return this.repo.recall(this.siteId, intent); }
  async remember(intent, selector, strategy)      { this.repo.remember(this.siteId, intent, selector, strategy); }
  demote(intent)                                  { this.repo.demote(this.siteId, intent); }
  setLocale(locale)                               { this.repo.setLocale(this.siteId, locale); }
  summary()                                       { return this.repo.summary(this.siteId); }
}

module.exports = { SiteProfile };
