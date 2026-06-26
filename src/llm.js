'use strict';

const { spawn } = require('child_process');

/**
 * LLMClient
 * ---------
 * Wraps the reasoning/vision fallback used by the resolver's last rung and
 * by the diagnosis step of auto-remediation.
 *
 * Three backends, picked in this order:
 *   1. ANTHROPIC_API_KEY env var → direct Messages API call (cheapest at scale)
 *   2. `claude` CLI in $PATH (you ran `claude login`) → shell out to it as
 *      a subprocess. Uses your Claude Code subscription, no API key needed.
 *   3. Deterministic heuristic fallback (keyword overlap)
 *
 * Same `.pickElement()` / `.diagnose()` interface across all three. The
 * resolver and runner don't care which backend served the answer.
 */
class LLMClient {
  constructor({ apiKey = process.env.ANTHROPIC_API_KEY, model = 'claude-sonnet-4-6', logger = console } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.logger = logger;
    if (apiKey) {
      this.backend = 'api';
    } else if (claudeCliAvailable()) {
      this.backend = 'claude-cli';
      this.logger.info?.('[llm] using `claude -p` subprocess (logged-in session)');
    } else {
      this.backend = 'heuristic';
    }
    this.enabled = this.backend !== 'heuristic';
  }

  /** Pick the element index that best matches the intent. Returns idx or null. */
  async pickElement({ intent, goal, elements }) {
    if (!this.enabled) return this._heuristicPick({ goal, elements });
    try {
      const prompt =
        `You are locating a UI element for an automated sanity test.\n` +
        `Intent: ${intent}\nGoal: ${goal}\n\n` +
        `Here is a JSON list of visible interactive elements (idx, tag, role, text, type):\n` +
        `${JSON.stringify(elements)}\n\n` +
        `Reply with ONLY the integer idx of the single best matching element, or -1 if none fit.`;
      const idx = await this._complete(prompt);
      const n = parseInt(String(idx).match(/-?\d+/)?.[0], 10);
      return Number.isInteger(n) && n >= 0 ? n : null;
    } catch (e) {
      this.logger.debug?.(`[llm] pickElement failed, using heuristic: ${e.message}`);
      return this._heuristicPick({ goal, elements });
    }
  }

  /** Diagnose a failed step in plain language for the report / ticket. */
  async diagnose({ flow, step, error, domDigest }) {
    if (!this.enabled) {
      return `Heuristic diagnosis: step "${step.action}" for intent "${step.intent || '-'}" failed (${error}). ` +
             `Most likely the element was missing, hidden, or renamed on this site.`;
    }
    try {
      const prompt =
        `An automated sanity test failed. Give a 2-sentence root-cause hypothesis and a concrete fix suggestion.\n` +
        `Flow: ${flow}\nStep: ${JSON.stringify(step)}\nError: ${error}\n` +
        `Visible elements digest: ${JSON.stringify(domDigest).slice(0, 2000)}`;
      return await this._complete(prompt);
    } catch {
      return `Diagnosis unavailable (LLM error). Raw error: ${error}`;
    }
  }

  // Deterministic fallback: keyword-overlap scoring against the goal text.
  _heuristicPick({ goal, elements }) {
    const words = goal.toLowerCase().match(/[a-z]+/g) || [];
    let best = null, bestScore = 0;
    for (const el of elements) {
      const hay = `${el.text} ${el.role} ${el.type} ${el.tag}`.toLowerCase();
      const score = words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; best = el.idx; }
    }
    return bestScore > 0 ? best : null;
  }

  async _complete(prompt) {
    if (this.backend === 'api')        return this._completeViaApi(prompt);
    if (this.backend === 'claude-cli') return this._completeViaClaudeCli(prompt);
    throw new Error('LLM backend not available');
  }

  async _completeViaApi(prompt) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  }

  // Shell out to the `claude` CLI in headless mode. Reads prompt from stdin,
  // captures stdout. Bounded by a hard timeout so a hung CLI never wedges a run.
  async _completeViaClaudeCli(prompt, { timeoutMs = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      const proc = spawn('claude', ['-p'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      const timer = setTimeout(() => { proc.kill('SIGTERM'); reject(new Error('claude CLI timeout')); }, timeoutMs);
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.stderr.on('data', d => { err += d.toString(); });
      proc.on('error', e => { clearTimeout(timer); reject(e); });
      proc.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`claude CLI exit ${code}: ${err.slice(0, 200)}`));
        resolve(out.trim());
      });
      proc.stdin.write(prompt);
      proc.stdin.end();
    });
  }
}

function claudeCliAvailable() {
  // Cheap sync probe: `which claude`. Don't actually invoke the CLI here —
  // we'll find out on the first real call if it's misconfigured.
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('which', ['claude'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 && r.stdout.toString().trim().length > 0;
  } catch { return false; }
}

module.exports = { LLMClient };
