/**
 * X1 Vault — Structured Error Logger
 * 
 * Foundation layer for the self-improvement pipeline.
 * Captures errors with enough context to:
 *   1. Auto-fix later (stack trace hash → known fix mapping)
 *   2. Detect patterns (repeated failures by type/skill/agent)
 *   3. Inform risk gates (which tasks actually fail?)
 *   4. Feed the self-audit loop (what keeps going wrong?)
 * 
 * Usage:
 *   const logger = new ErrorLogger({ logDir: './errors' });
 *   
 *   // Wrap any skill
 *   const result = await logger.wrapSkill('token-audit', async () => {
 *     return await auditToken(contractAddress);
 *   }, { contractAddress, chain: 'solana' });
 *   
 *   // Or log manually
 *   logger.capture(error, {
 *     skill: 'vault-sync',
 *     agent: 'VaultSyncAgent',
 *     input: { key: 'session_abc' },
 *     severity: 'high'
 *   });
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Error Classification ────────────────────────────────────────────

const ERROR_TYPES = {
  SYNTAX:       'syntax',
  LOGIC:        'logic',
  API:          'api',
  DEPENDENCY:   'dependency',
  TIMEOUT:      'timeout',
  PERMISSION:   'permission',
  VALIDATION:   'validation',
  NETWORK:      'network',
  UNKNOWN:      'unknown'
};

const SEVERITY_LEVELS = {
  LOW:      'low',       // Logged, no action needed
  MEDIUM:   'medium',    // Logged, flag for review
  HIGH:     'high',      // Logged, alert user
  CRITICAL: 'critical'   // Logged, halt execution, alert immediately
};

// ─── Stack Trace Hashing ─────────────────────────────────────────────

/**
 * Generate a stable hash from an error's stack trace.
 * Strips line numbers and file paths to group "same root cause" errors.
 * This is the key that links errors to known fixes.
 */
function hashStackTrace(stack) {
  if (!stack) return 'no-stack';

  const normalized = stack
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('at '))
    .map(line => {
      // Strip line:col numbers — same function, different line = same root cause
      return line.replace(/:\d+:\d+\)?$/, '');
    })
    // Strip absolute paths — normalize across environments
    .map(line => line.replace(/\(\/.*\//g, '('))
    .slice(0, 5) // Top 5 frames are usually enough to fingerprint
    .join('|');

  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

// ─── Error Type Classifier ──────────────────────────────────────────

/**
 * Auto-classify an error by inspecting its message and properties.
 * This classification feeds the auto-fix pipeline later.
 */
function classifyError(error) {
  const msg = (error.message || '').toLowerCase();
  const name = (error.name || '').toLowerCase();

  if (name === 'syntaxerror' || msg.includes('unexpected token'))
    return ERROR_TYPES.SYNTAX;

  if (msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('fetch failed') || msg.includes('network'))
    return ERROR_TYPES.NETWORK;

  if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('deadline'))
    return ERROR_TYPES.TIMEOUT;

  if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('permission'))
    return ERROR_TYPES.PERMISSION;

  if (msg.includes('404') || msg.includes('429') || msg.includes('500') || msg.includes('api') || msg.includes('rate limit'))
    return ERROR_TYPES.API;

  // Check error name for JS built-in type errors BEFORE message-based checks
  // so TypeError("x is not a function") is classified as logic, not dependency
  if (name === 'typeerror' || name === 'referenceerror' || name === 'rangeerror')
    return ERROR_TYPES.LOGIC;

  if (msg.includes('cannot find module') || msg.includes('module not found') || msg.includes('is not a function'))
    return ERROR_TYPES.DEPENDENCY;

  if (msg.includes('invalid') || msg.includes('required') || msg.includes('expected') || msg.includes('must be'))
    return ERROR_TYPES.VALIDATION;

  return ERROR_TYPES.UNKNOWN;
}

// ─── Core Logger ─────────────────────────────────────────────────────

class ErrorLogger {
  constructor(options = {}) {
    this.logDir = options.logDir || path.join(process.cwd(), 'errors');
    this.maxRetries = options.maxRetries || 2;           // Auto-fix threshold
    this.onCritical = options.onCritical || null;         // Callback for critical errors
    this.onThresholdHit = options.onThresholdHit || null; // Callback when error repeats > maxRetries

    // In-memory occurrence counter (persisted to disk on flush)
    this._occurrenceMap = new Map(); // hash → count

    this._ensureLogDir();
    this._loadOccurrenceMap();
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Capture a structured error entry.
   * 
   * @param {Error} error - The caught error
   * @param {Object} context - What was happening when it failed
   * @param {string} context.skill - Which skill was running
   * @param {string} [context.agent] - Which agent triggered it
   * @param {*} [context.input] - The input that caused the failure
   * @param {string} [context.severity] - Override auto-detected severity
   * @param {Object} [context.metadata] - Any additional context
   * @returns {Object} The structured error entry (for chaining/inspection)
   */
  capture(error, context = {}) {
    const entry = this._buildEntry(error, context);

    // Track occurrences
    const count = (this._occurrenceMap.get(entry.hash) || 0) + 1;
    this._occurrenceMap.set(entry.hash, count);
    entry.occurrence_count = count;

    // Write to daily log file
    this._appendToLog(entry);

    // Persist occurrence map
    this._saveOccurrenceMap();

    // Trigger callbacks
    if (entry.severity === SEVERITY_LEVELS.CRITICAL && this.onCritical) {
      this.onCritical(entry);
    }

    if (count > this.maxRetries && this.onThresholdHit) {
      this.onThresholdHit(entry);
    }

    return entry;
  }

  /**
   * Wrap a skill function with automatic error capture.
   * This is the primary integration point for your agents.
   * 
   * @param {string} skillName - Name of the skill being executed
   * @param {Function} fn - The async function to execute
   * @param {*} input - The input being passed to the skill
   * @param {Object} [options] - Additional context
   * @returns {Object} { success, result, error, entry }
   */
  async wrapSkill(skillName, fn, input = {}, options = {}) {
    const startTime = Date.now();

    try {
      const result = await fn();
      
      // Log success too (for pattern analysis — what succeeds vs fails?)
      this._appendToLog({
        type: 'success',
        skill: skillName,
        agent: options.agent || null,
        input_summary: this._summarizeInput(input),
        duration_ms: Date.now() - startTime,
        timestamp: new Date().toISOString()
      });

      return { success: true, result, error: null, entry: null };
    } catch (error) {
      const entry = this.capture(error, {
        skill: skillName,
        agent: options.agent,
        input,
        severity: options.severity,
        metadata: {
          ...options.metadata,
          duration_ms: Date.now() - startTime
        }
      });

      return { success: false, result: null, error, entry };
    }
  }

  /**
   * Query errors by various filters. 
   * Used by the self-audit job and auto-fix pipeline.
   * 
   * @param {Object} filters
   * @param {string} [filters.skill] - Filter by skill name
   * @param {string} [filters.type] - Filter by error type
   * @param {string} [filters.hash] - Filter by stack trace hash
   * @param {number} [filters.minOccurrences] - Minimum occurrence count
   * @param {number} [filters.days] - Look back N days (default: 7)
   * @returns {Array} Matching error entries
   */
  query(filters = {}) {
    const days = filters.days || 7;
    const entries = [];

    for (let i = 0; i < days; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const filePath = path.join(this.logDir, `${dateStr}.json`);

      if (fs.existsSync(filePath)) {
        const lines = fs.readFileSync(filePath, 'utf-8')
          .split('\n')
          .filter(Boolean);

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (this._matchesFilters(entry, filters)) {
              entries.push(entry);
            }
          } catch { /* skip malformed lines */ }
        }
      }
    }

    return entries;
  }

  /**
   * Get the top recurring errors — prime candidates for auto-fix.
   * 
   * @param {number} limit - How many to return
   * @returns {Array} [{ hash, count, latestEntry }]
   */
  getRecurringErrors(limit = 10) {
    const sorted = [...this._occurrenceMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);

    return sorted.map(([hash, count]) => {
      // Find the most recent entry for this hash
      const entries = this.query({ hash, days: 30 });
      const latest = entries[entries.length - 1] || null;
      return { hash, count, latestEntry: latest };
    });
  }

  /**
   * Generate a summary report for the self-audit loop.
   * 
   * @param {number} days - Look back period
   * @returns {Object} Summary stats
   */
  generateReport(days = 7) {
    const allEntries = this.query({ days });
    
    const errors = allEntries.filter(e => e.type !== 'success');
    const successes = allEntries.filter(e => e.type === 'success');

    // Group by skill
    const bySkill = {};
    for (const entry of errors) {
      const skill = entry.skill || 'unknown';
      if (!bySkill[skill]) bySkill[skill] = { errors: 0, types: {} };
      bySkill[skill].errors++;
      const t = entry.error_type || 'unknown';
      bySkill[skill].types[t] = (bySkill[skill].types[t] || 0) + 1;
    }

    // Group by error type
    const byType = {};
    for (const entry of errors) {
      const t = entry.error_type || 'unknown';
      byType[t] = (byType[t] || 0) + 1;
    }

    // Find auto-fix candidates (>2 occurrences)
    const autoFixCandidates = this.getRecurringErrors(5)
      .filter(r => r.count > this.maxRetries);

    return {
      period: `${days} days`,
      generated_at: new Date().toISOString(),
      totals: {
        errors: errors.length,
        successes: successes.length,
        error_rate: errors.length / (errors.length + successes.length) || 0
      },
      by_skill: bySkill,
      by_type: byType,
      auto_fix_candidates: autoFixCandidates,
      top_recurring: this.getRecurringErrors(5)
    };
  }

  /**
   * Record a successful fix so future auto-fix can reference it.
   * 
   * @param {string} errorHash - The hash of the error that was fixed
   * @param {Object} fix - Description of the fix
   * @param {string} fix.description - What was done
   * @param {string} fix.diff - Code diff or change summary
   * @param {string} fix.fixedBy - 'auto' | 'user' | agent name
   */
  recordFix(errorHash, fix) {
    const fixEntry = {
      type: 'fix',
      error_hash: errorHash,
      description: fix.description,
      diff: fix.diff || null,
      fixed_by: fix.fixedBy || 'user',
      timestamp: new Date().toISOString()
    };

    this._appendToLog(fixEntry);

    // Reset occurrence count for this hash
    this._occurrenceMap.delete(errorHash);
    this._saveOccurrenceMap();

    return fixEntry;
  }

  // ── Private Methods ──────────────────────────────────────────────

  _buildEntry(error, context) {
    const hash = hashStackTrace(error.stack);
    const errorType = classifyError(error);

    return {
      type: 'error',
      timestamp: new Date().toISOString(),
      hash,
      error_type: errorType,
      severity: context.severity || this._inferSeverity(errorType, context),
      skill: context.skill || null,
      agent: context.agent || null,
      message: error.message,
      name: error.name,
      stack: error.stack,
      input_summary: this._summarizeInput(context.input),
      metadata: context.metadata || {},
      occurrence_count: 0 // Set by capture()
    };
  }

  _inferSeverity(errorType, context) {
    // Critical: anything touching deploys, deletes, or financial ops
    const criticalSkills = ['deploy', 'delete', 'transfer', 'swap', 'send'];
    if (criticalSkills.some(s => (context.skill || '').includes(s))) {
      return SEVERITY_LEVELS.CRITICAL;
    }

    // High: API/network errors (external dependency failures)
    if ([ERROR_TYPES.API, ERROR_TYPES.NETWORK, ERROR_TYPES.PERMISSION].includes(errorType)) {
      return SEVERITY_LEVELS.HIGH;
    }

    // Medium: logic/validation errors
    if ([ERROR_TYPES.LOGIC, ERROR_TYPES.VALIDATION].includes(errorType)) {
      return SEVERITY_LEVELS.MEDIUM;
    }

    return SEVERITY_LEVELS.LOW;
  }

  _summarizeInput(input) {
    if (!input) return null;
    try {
      const str = JSON.stringify(input);
      // Truncate large inputs — keep enough context for debugging
      return str.length > 500 ? str.slice(0, 500) + '...[truncated]' : str;
    } catch {
      return '[unserializable]';
    }
  }

  _matchesFilters(entry, filters) {
    if (filters.skill && entry.skill !== filters.skill) return false;
    if (filters.type && entry.error_type !== filters.type) return false;
    if (filters.hash && entry.hash !== filters.hash) return false;
    if (filters.minOccurrences && (entry.occurrence_count || 0) < filters.minOccurrences) return false;
    if (entry.type === 'success' && filters.type) return false; // Don't return successes when filtering by error type
    return true;
  }

  _ensureLogDir() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  _appendToLog(entry) {
    const dateStr = new Date().toISOString().split('T')[0];
    const filePath = path.join(this.logDir, `${dateStr}.json`);
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  }

  _loadOccurrenceMap() {
    const mapPath = path.join(this.logDir, '_occurrences.json');
    if (fs.existsSync(mapPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
        this._occurrenceMap = new Map(Object.entries(data));
      } catch {
        this._occurrenceMap = new Map();
      }
    }
  }

  _saveOccurrenceMap() {
    const mapPath = path.join(this.logDir, '_occurrences.json');
    const obj = Object.fromEntries(this._occurrenceMap);
    fs.writeFileSync(mapPath, JSON.stringify(obj, null, 2));
  }
}

// ─── Exports ─────────────────────────────────────────────────────────

module.exports = {
  ErrorLogger,
  ERROR_TYPES,
  SEVERITY_LEVELS,
  hashStackTrace,
  classifyError
};
