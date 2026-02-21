/**
 * X1 Vault — Verification Gate System
 * 
 * Two-gate pattern that wraps skill execution:
 * 
 *   Gate 1 (Plan)     → Agent generates a plan → User approves/edits/rejects
 *   Execution         → Skill runs
 *   Gate 2 (Verify)   → Output checked against original request → User confirms
 * 
 * Risk-weighted: Low-risk tasks skip gates. High-risk tasks require both.
 * 
 *   NONE     → No gates (read-only ops)
 *   LOW      → No gates (internal writes)
 *   MEDIUM   → Gate 2 only (verify output)
 *   HIGH     → Both gates (plan + verify)
 *   CRITICAL → Both gates + cooldown + audit trail
 * 
 * Integrates with:
 *   - WorkflowRouter (as middleware)
 *   - ErrorLogger (logs all gate decisions)
 *   - Telegram bot (user confirmation UI)
 * 
 * Usage:
 *   const gates = new VerificationGates({ logger, router });
 *   
 *   // As router middleware (auto-applies based on route risk level)
 *   router.use('pre', gates.preMiddleware());
 *   router.use('post', gates.postMiddleware());
 *   
 *   // Or standalone
 *   const gate1 = await gates.planGate('deploy', plan, context);
 *   if (gate1.approved) {
 *     const result = await executeDeploy();
 *     const gate2 = await gates.verifyGate('deploy', result, originalRequest);
 *   }
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

// ─── Risk Thresholds ─────────────────────────────────────────────────

const GATE_POLICY = {
  none:     { gate1: false, gate2: false, cooldown: 0,  auditTrail: false },
  low:      { gate1: false, gate2: false, cooldown: 0,  auditTrail: false },
  medium:   { gate1: false, gate2: true,  cooldown: 0,  auditTrail: false },
  high:     { gate1: true,  gate2: true,  cooldown: 0,  auditTrail: true  },
  critical: { gate1: true,  gate2: true,  cooldown: 30, auditTrail: true  }  // 30s cooldown
};

// ─── Gate Status ─────────────────────────────────────────────────────

const GATE_STATUS = {
  PENDING:   'pending',
  APPROVED:  'approved',
  REJECTED:  'rejected',
  EDITED:    'edited',
  EXPIRED:   'expired',
  SKIPPED:   'skipped',    // Risk level too low for this gate
  AUTO:      'auto_passed' // Auto-approved (e.g., repeat of previously approved pattern)
};

// ─── Verification Rules ──────────────────────────────────────────────

/**
 * Built-in verification checks for Gate 2.
 * Each rule inspects the output and returns pass/fail.
 * Add custom rules for your specific skills.
 */
const DEFAULT_RULES = [
  {
    name: 'output-not-null',
    description: 'Execution must return a result',
    check: (output) => ({
      pass: output !== null && output !== undefined,
      reason: 'Execution returned null/undefined'
    })
  },
  {
    name: 'no-error-in-output',
    description: 'Output should not contain error flags',
    check: (output) => {
      if (typeof output === 'object' && output !== null) {
        if (output.error === true || output.status === 'error' || output.status === 'failed') {
          return { pass: false, reason: `Output indicates failure: ${output.message || output.error}` };
        }
      }
      return { pass: true };
    }
  },
  {
    name: 'output-matches-intent',
    description: 'Output should reference the original input',
    check: (output, context) => {
      // If we have the original request, check that key fields appear in output
      if (!context.originalInput) return { pass: true };
      
      const outputStr = JSON.stringify(output).toLowerCase();
      const inputStr = JSON.stringify(context.originalInput).toLowerCase();
      
      // Extract key terms from input
      const inputTerms = inputStr.match(/[a-z0-9]{4,}/g) || [];
      const matchedTerms = inputTerms.filter(t => outputStr.includes(t));
      
      // At least some input terms should appear in output
      if (inputTerms.length > 0 && matchedTerms.length === 0) {
        return { pass: false, reason: 'Output does not reference any input terms — possible mismatch' };
      }
      return { pass: true };
    }
  }
];

// ─── Core Verification Gates ─────────────────────────────────────────

class VerificationGates extends EventEmitter {
  constructor(options = {}) {
    super();

    this.logger = options.logger || null;
    this.policies = { ...GATE_POLICY, ...options.policies };
    this.rules = [...DEFAULT_RULES, ...(options.rules || [])];
    this.auditDir = options.auditDir || path.join(process.cwd(), 'audit-trail');
    this.defaultTimeout = options.timeout || 120000; // 2 minutes

    // Pending gate approvals: key → { resolve, reject, gate, expires }
    this.pendingGates = new Map();

    // Approval history: tracks patterns that were previously approved
    // Used for auto-approval of repeat actions
    this._approvalHistory = new Map(); // patternHash → { count, lastApproved }

    // Custom rules per skill
    this._skillRules = new Map(); // skillName → Rule[]

    this._ensureAuditDir();
    this._startExpirationCheck();
  }

  // ── Gate 1: Plan Gate ──────────────────────────────────────────

  /**
   * Gate 1: Present a plan for approval before execution.
   * 
   * @param {string} skillName - Which skill is about to execute
   * @param {Object} plan - The proposed action plan
   * @param {string} plan.description - What will happen
   * @param {string[]} [plan.steps] - Ordered steps
   * @param {string} [plan.risk] - Risk assessment
   * @param {Object} [plan.rollback] - How to undo if it fails
   * @param {Object} context - Execution context
   * @param {string} context.userId - Who triggered the action
   * @param {string} context.chatId - Where to send confirmation
   * @returns {Promise<Object>} { status, plan, editedPlan?, approvedAt }
   */
  async planGate(skillName, plan, context = {}) {
    const risk = context.risk || 'high';
    const policy = this.policies[risk] || this.policies.high;

    // Check if this gate applies
    if (!policy.gate1) {
      return this._gateResult(GATE_STATUS.SKIPPED, skillName, 'gate1', plan, context);
    }

    // Check for auto-approval (previously approved identical pattern)
    const patternKey = this._hashPattern(skillName, plan);
    const history = this._approvalHistory.get(patternKey);
    if (history && history.count >= 3) {
      // User has approved this exact pattern 3+ times — auto-approve
      this._logGateDecision('gate1', skillName, GATE_STATUS.AUTO, plan, context);
      return this._gateResult(GATE_STATUS.AUTO, skillName, 'gate1', plan, context);
    }

    // Apply cooldown for critical actions
    if (policy.cooldown > 0) {
      const cooldownKey = `cooldown:${skillName}:${context.userId}`;
      const lastExecution = this._approvalHistory.get(cooldownKey);
      if (lastExecution && (Date.now() - lastExecution.lastApproved) < policy.cooldown * 1000) {
        const remaining = Math.ceil((policy.cooldown * 1000 - (Date.now() - lastExecution.lastApproved)) / 1000);
        return this._gateResult(GATE_STATUS.REJECTED, skillName, 'gate1', plan, context,
          `Cooldown active: ${remaining}s remaining before another ${skillName} execution`);
      }
    }

    // Create pending approval
    const gateId = `gate1:${skillName}:${Date.now()}`;
    
    const result = await this._waitForApproval(gateId, {
      gate: 'gate1',
      skill: skillName,
      plan,
      risk,
      context,
      timeout: this.defaultTimeout
    });

    // Track approval history
    if (result.status === GATE_STATUS.APPROVED || result.status === GATE_STATUS.EDITED) {
      this._trackApproval(patternKey);
      if (policy.cooldown > 0) {
        this._approvalHistory.set(`cooldown:${skillName}:${context.userId}`, {
          count: 1,
          lastApproved: Date.now()
        });
      }
    }

    // Audit trail
    if (policy.auditTrail) {
      this._writeAuditTrail('gate1', skillName, result, plan, context);
    }

    this._logGateDecision('gate1', skillName, result.status, plan, context);
    return result;
  }

  // ── Gate 2: Verify Gate ────────────────────────────────────────

  /**
   * Gate 2: Verify output after execution, before marking complete.
   * 
   * @param {string} skillName - Which skill just executed
   * @param {*} output - The execution result
   * @param {Object} context - Execution context
   * @param {*} context.originalInput - The original request
   * @param {string} context.risk - Risk level
   * @returns {Promise<Object>} { status, checks, output }
   */
  async verifyGate(skillName, output, context = {}) {
    const risk = context.risk || 'medium';
    const policy = this.policies[risk] || this.policies.medium;

    // Check if this gate applies
    if (!policy.gate2) {
      return this._gateResult(GATE_STATUS.SKIPPED, skillName, 'gate2', output, context);
    }

    // Run verification rules
    const allRules = [...this.rules, ...(this._skillRules.get(skillName) || [])];
    const checks = [];
    let allPassed = true;

    for (const rule of allRules) {
      try {
        const result = rule.check(output, context);
        checks.push({
          rule: rule.name,
          description: rule.description,
          ...result
        });
        if (!result.pass) allPassed = false;
      } catch (err) {
        checks.push({
          rule: rule.name,
          pass: false,
          reason: `Rule threw error: ${err.message}`
        });
        allPassed = false;
      }
    }

    // If all auto-checks pass AND risk is medium, auto-approve
    if (allPassed && risk === 'medium') {
      const result = this._gateResult(GATE_STATUS.AUTO, skillName, 'gate2', output, context);
      result.checks = checks;
      this._logGateDecision('gate2', skillName, GATE_STATUS.AUTO, output, context);
      return result;
    }

    // If checks failed OR risk is high/critical, require user confirmation
    if (!allPassed) {
      const failedChecks = checks.filter(c => !c.pass);
      
      // Emit for UI to display
      this.emit('verification-failed', {
        skill: skillName,
        output,
        failedChecks,
        context
      });

      // For high/critical: always ask user even on failure
      if (risk === 'high' || risk === 'critical') {
        const gateId = `gate2:${skillName}:${Date.now()}`;
        const result = await this._waitForApproval(gateId, {
          gate: 'gate2',
          skill: skillName,
          output,
          checks,
          failedChecks,
          context,
          timeout: this.defaultTimeout
        });
        result.checks = checks;

        if (policy.auditTrail) {
          this._writeAuditTrail('gate2', skillName, result, output, context);
        }
        this._logGateDecision('gate2', skillName, result.status, output, context);
        return result;
      }

      // For medium risk with failed checks: reject automatically
      const result = this._gateResult(GATE_STATUS.REJECTED, skillName, 'gate2', output, context,
        `Verification failed: ${failedChecks.map(c => c.reason).join(', ')}`);
      result.checks = checks;
      this._logGateDecision('gate2', skillName, GATE_STATUS.REJECTED, output, context);
      return result;
    }

    // All passed, high/critical risk: still ask for confirmation
    const gateId = `gate2:${skillName}:${Date.now()}`;
    const result = await this._waitForApproval(gateId, {
      gate: 'gate2',
      skill: skillName,
      output,
      checks,
      context,
      timeout: this.defaultTimeout
    });
    result.checks = checks;

    if (policy.auditTrail) {
      this._writeAuditTrail('gate2', skillName, result, output, context);
    }
    this._logGateDecision('gate2', skillName, result.status, output, context);
    return result;
  }

  // ── Router Middleware ──────────────────────────────────────────

  /**
   * Returns a pre-middleware function for the WorkflowRouter.
   * Applies Gate 1 automatically based on route risk level.
   */
  preMiddleware() {
    return async (route, ctx) => {
      const policy = this.policies[route.risk] || this.policies.none;
      
      if (policy.gate1 && !ctx.confirmed) {
        // Generate plan from the route info
        const plan = {
          description: `Execute ${route.name}: ${route.description || 'No description'}`,
          risk: route.risk,
          agent: route.agent,
          input: ctx.message
        };

        const gate1Result = await this.planGate(route.name, plan, {
          ...ctx,
          risk: route.risk
        });

        // Attach gate result to context for the handler to read
        ctx.gate1 = gate1Result;

        if (gate1Result.status === GATE_STATUS.REJECTED || gate1Result.status === GATE_STATUS.EXPIRED) {
          // Abort execution by throwing (router catches this)
          const err = new Error(`Gate 1 ${gate1Result.status}: ${gate1Result.reason || 'User rejected'}`);
          err.gateResult = gate1Result;
          throw err;
        }
      }
    };
  }

  /**
   * Returns a post-middleware function for the WorkflowRouter.
   * Applies Gate 2 automatically based on route risk level.
   */
  postMiddleware() {
    return async (route, ctx, outcome) => {
      if (!outcome.success) return; // Don't verify failed executions

      const policy = this.policies[route.risk] || this.policies.none;
      
      if (policy.gate2) {
        const gate2Result = await this.verifyGate(route.name, outcome.result, {
          ...ctx,
          risk: route.risk,
          originalInput: ctx.message
        });

        // Attach gate result to context
        ctx.gate2 = gate2Result;

        if (gate2Result.status === GATE_STATUS.REJECTED) {
          this.emit('verification-rejected', {
            skill: route.name,
            output: outcome.result,
            gate2Result,
            context: ctx
          });
        }
      }
    };
  }

  // ── Custom Rules ───────────────────────────────────────────────

  /**
   * Add custom verification rules for a specific skill.
   * 
   * @param {string} skillName
   * @param {Object} rule - { name, description, check: (output, ctx) => { pass, reason } }
   */
  addRule(skillName, rule) {
    if (!this._skillRules.has(skillName)) {
      this._skillRules.set(skillName, []);
    }
    this._skillRules.get(skillName).push(rule);
    return this;
  }

  /**
   * Add a global verification rule (applies to all skills).
   */
  addGlobalRule(rule) {
    this.rules.push(rule);
    return this;
  }

  // ── Approval Interface ─────────────────────────────────────────

  /**
   * Approve a pending gate. Call this from your Telegram bot
   * when the user responds "yes" / "approve".
   * 
   * @param {string} gateId - The gate to approve
   * @param {Object} [edits] - Optional edits to the plan
   */
  approve(gateId, edits = null) {
    const pending = this.pendingGates.get(gateId);
    if (!pending) return false;

    this.pendingGates.delete(gateId);
    
    if (edits) {
      pending.resolve({
        status: GATE_STATUS.EDITED,
        edits,
        approvedAt: new Date().toISOString()
      });
    } else {
      pending.resolve({
        status: GATE_STATUS.APPROVED,
        approvedAt: new Date().toISOString()
      });
    }
    return true;
  }

  /**
   * Reject a pending gate. Call this from your Telegram bot
   * when the user responds "no" / "cancel".
   * 
   * @param {string} gateId - The gate to reject
   * @param {string} [reason] - Why it was rejected
   */
  reject(gateId, reason = null) {
    const pending = this.pendingGates.get(gateId);
    if (!pending) return false;

    this.pendingGates.delete(gateId);
    pending.resolve({
      status: GATE_STATUS.REJECTED,
      reason: reason || 'User rejected',
      rejectedAt: new Date().toISOString()
    });
    return true;
  }

  /**
   * Get all pending gates (for displaying to user).
   */
  getPending() {
    const pending = [];
    for (const [gateId, data] of this.pendingGates) {
      pending.push({
        gateId,
        gate: data.gate,
        skill: data.skill,
        risk: data.risk,
        expires: new Date(data.expires).toISOString(),
        plan: data.plan || null,
        output: data.output || null
      });
    }
    return pending;
  }

  // ── Reporting ──────────────────────────────────────────────────

  /**
   * Get gate statistics from audit trail.
   */
  getStats(days = 7) {
    const stats = {
      gate1: { approved: 0, rejected: 0, expired: 0, skipped: 0, auto: 0 },
      gate2: { approved: 0, rejected: 0, expired: 0, skipped: 0, auto: 0 },
      bySkill: {},
      autoApprovalCandidates: []
    };

    // Read audit trail files
    for (let i = 0; i < days; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const filePath = path.join(this.auditDir, `${dateStr}.json`);

      if (fs.existsSync(filePath)) {
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const gate = entry.gate === 'gate1' ? stats.gate1 : stats.gate2;
            
            if (entry.status === GATE_STATUS.APPROVED) gate.approved++;
            else if (entry.status === GATE_STATUS.REJECTED) gate.rejected++;
            else if (entry.status === GATE_STATUS.EXPIRED) gate.expired++;
            else if (entry.status === GATE_STATUS.SKIPPED) gate.skipped++;
            else if (entry.status === GATE_STATUS.AUTO) gate.auto++;

            // Track by skill
            if (!stats.bySkill[entry.skill]) {
              stats.bySkill[entry.skill] = { approved: 0, rejected: 0, total: 0 };
            }
            stats.bySkill[entry.skill].total++;
            if (entry.status === GATE_STATUS.APPROVED || entry.status === GATE_STATUS.AUTO) {
              stats.bySkill[entry.skill].approved++;
            } else if (entry.status === GATE_STATUS.REJECTED) {
              stats.bySkill[entry.skill].rejected++;
            }
          } catch { /* skip malformed lines */ }
        }
      }
    }

    // Find skills that are always approved → candidates for auto-approval
    for (const [skill, data] of Object.entries(stats.bySkill)) {
      if (data.total >= 5 && data.rejected === 0) {
        stats.autoApprovalCandidates.push({
          skill,
          totalApprovals: data.approved,
          suggestion: `${skill} has been approved ${data.approved} times with 0 rejections — consider lowering risk level`
        });
      }
    }

    return stats;
  }

  // ── Private Methods ────────────────────────────────────────────

  _waitForApproval(gateId, data) {
    return new Promise((resolve) => {
      const timeout = data.timeout || this.defaultTimeout;

      this.pendingGates.set(gateId, {
        ...data,
        resolve,
        expires: Date.now() + timeout
      });

      // Emit event for UI to display the gate
      this.emit('gate-pending', {
        gateId,
        gate: data.gate,
        skill: data.skill,
        plan: data.plan || null,
        output: data.output || null,
        checks: data.checks || null,
        failedChecks: data.failedChecks || null,
        risk: data.risk || data.context?.risk,
        timeout
      });

      // Auto-expire
      setTimeout(() => {
        if (this.pendingGates.has(gateId)) {
          this.pendingGates.delete(gateId);
          resolve({
            status: GATE_STATUS.EXPIRED,
            reason: `Gate expired after ${timeout / 1000}s`,
            expiredAt: new Date().toISOString()
          });
        }
      }, timeout);
    });
  }

  _gateResult(status, skill, gate, data, context, reason = null) {
    return {
      status,
      gate,
      skill,
      reason,
      timestamp: new Date().toISOString()
    };
  }

  _hashPattern(skillName, plan) {
    // Create a stable key for the action pattern
    const key = `${skillName}:${JSON.stringify(plan.steps || plan.description || '')}`;
    return require('crypto').createHash('md5').update(key).digest('hex').slice(0, 10);
  }

  _trackApproval(patternKey) {
    const existing = this._approvalHistory.get(patternKey) || { count: 0, lastApproved: 0 };
    existing.count++;
    existing.lastApproved = Date.now();
    this._approvalHistory.set(patternKey, existing);
  }

  _logGateDecision(gate, skill, status, data, context) {
    if (this.logger) {
      // Log gate decisions as structured entries in the error log
      // (not errors — but useful for the self-audit loop)
      const dateStr = new Date().toISOString().split('T')[0];
      const logPath = path.join(this.auditDir, `${dateStr}.json`);
      const entry = {
        type: 'gate_decision',
        gate,
        skill,
        status,
        risk: context.risk || null,
        userId: context.userId || null,
        timestamp: new Date().toISOString()
      };
      fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
    }
  }

  _writeAuditTrail(gate, skill, result, data, context) {
    const dateStr = new Date().toISOString().split('T')[0];
    const filePath = path.join(this.auditDir, `${dateStr}.json`);
    
    const entry = {
      type: 'audit_trail',
      gate,
      skill,
      status: result.status,
      risk: context.risk || null,
      userId: context.userId || null,
      plan: gate === 'gate1' ? data : null,
      outputSummary: gate === 'gate2' ? this._summarize(data) : null,
      checks: result.checks || null,
      timestamp: new Date().toISOString()
    };

    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  }

  _summarize(data) {
    try {
      const str = JSON.stringify(data);
      return str.length > 300 ? str.slice(0, 300) + '...' : str;
    } catch {
      return '[unserializable]';
    }
  }

  _ensureAuditDir() {
    if (!fs.existsSync(this.auditDir)) {
      fs.mkdirSync(this.auditDir, { recursive: true });
    }
  }

  _startExpirationCheck() {
    // Check for expired gates every 30 seconds
    this._expirationInterval = setInterval(() => {
      const now = Date.now();
      for (const [gateId, data] of this.pendingGates) {
        if (now > data.expires) {
          this.pendingGates.delete(gateId);
          data.resolve({
            status: GATE_STATUS.EXPIRED,
            reason: 'Gate expired',
            expiredAt: new Date().toISOString()
          });
        }
      }
    }, 30000);

    // Don't block process exit
    if (this._expirationInterval.unref) {
      this._expirationInterval.unref();
    }
  }

  /**
   * Clean up timers (call on shutdown).
   */
  destroy() {
    if (this._expirationInterval) {
      clearInterval(this._expirationInterval);
    }
    // Reject all pending gates
    for (const [gateId, data] of this.pendingGates) {
      data.resolve({
        status: GATE_STATUS.REJECTED,
        reason: 'System shutdown'
      });
    }
    this.pendingGates.clear();
  }
}

// ─── Exports ─────────────────────────────────────────────────────────

module.exports = {
  VerificationGates,
  GATE_POLICY,
  GATE_STATUS,
  DEFAULT_RULES
};
