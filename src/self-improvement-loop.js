/**
 * X1 Vault — Self-Improvement Loop
 * 
 * The brain of the system. Continuously learns from:
 *   1. Error logs → What keeps failing?
 *   2. Gate decisions → What gets rejected? What's always approved?
 *   3. Route analytics → What's slow? What's unused? What's missing?
 *   4. User corrections → What does the user keep fixing manually?
 * 
 * Outputs:
 *   - Skill update proposals (new triggers, better error handling)
 *   - Risk level adjustments (promote/demote based on approval history)
 *   - New route suggestions (from unmatched messages)
 *   - Performance alerts (degrading skills)
 *   - Auto-fix attempts (for known error patterns)
 * 
 * Flow:
 *   Capture → Analyze → Generate proposals → Review → Deploy → Backup to Vault
 * 
 * Usage:
 *   const loop = new SelfImprovementLoop({ logger, router, gates });
 *   
 *   // Record a user correction
 *   loop.recordCorrection('token-audit', originalOutput, correctedOutput, 'Wrong risk score');
 *   
 *   // Run analysis (daily/weekly)
 *   const insights = await loop.analyze();
 *   
 *   // Get proposals
 *   const proposals = loop.getProposals();
 *   
 *   // Apply an approved proposal
 *   loop.applyProposal(proposalId);
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// ─── Insight Types ───────────────────────────────────────────────────

const INSIGHT_TYPE = {
  ERROR_PATTERN:     'error_pattern',      // Recurring error detected
  CORRECTION_PATTERN:'correction_pattern',  // User keeps correcting same thing
  RISK_ADJUSTMENT:   'risk_adjustment',     // Gate approval history suggests risk change
  NEW_ROUTE:         'new_route',           // Unmatched messages suggest missing route
  PERFORMANCE:       'performance',         // Skill getting slower or failing more
  UNUSED_ROUTE:      'unused_route',        // Route never fires
  AUTO_FIX:          'auto_fix',            // Known fix available for recurring error
  SKILL_UPDATE:      'skill_update'         // General skill improvement suggestion
};

const PROPOSAL_STATUS = {
  PENDING:  'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  APPLIED:  'applied',
  EXPIRED:  'expired'
};

// ─── Core Self-Improvement Loop ──────────────────────────────────────

class SelfImprovementLoop extends EventEmitter {
  constructor(options = {}) {
    super();

    this.logger = options.logger || null;
    this.router = options.router || null;
    this.gates = options.gates || null;

    this.dataDir = options.dataDir || path.join(process.cwd(), 'improvement-data');
    this.correctionsFile = path.join(this.dataDir, 'corrections.json');
    this.proposalsFile = path.join(this.dataDir, 'proposals.json');
    this.insightsFile = path.join(this.dataDir, 'insights.json');
    this.metricsFile = path.join(this.dataDir, 'metrics-history.json');

    // Thresholds
    this.config = {
      correctionThreshold: 3,    // N corrections on same pattern → propose fix
      errorThreshold: 3,         // N occurrences → auto-fix candidate
      approvalThreshold: 5,      // N approvals with 0 rejections → lower risk
      rejectionThreshold: 3,     // N rejections → raise risk
      missThreshold: 5,          // N similar unmatched messages → suggest route
      performanceDegradation: 2, // 2x slower than baseline → alert
      unusedDays: 14,            // Route unused for N days → flag
      ...options.config
    };

    this._corrections = [];
    this._proposals = [];
    this._insights = [];
    this._metricsHistory = [];

    this._ensureDataDir();
    this._loadData();
  }

  // ── Capture: Record User Corrections ───────────────────────────

  /**
   * Record when a user corrects an agent's output.
   * This is the richest signal for improvement.
   * 
   * @param {string} skill - Which skill produced the wrong output
   * @param {*} original - What the agent output
   * @param {*} corrected - What the user changed it to
   * @param {string} [reason] - Why the correction was made
   * @param {Object} [context] - Additional context
   */
  recordCorrection(skill, original, corrected, reason = '', context = {}) {
    const correction = {
      id: this._generateId(),
      skill,
      original: this._summarize(original),
      corrected: this._summarize(corrected),
      reason,
      context,
      timestamp: new Date().toISOString(),
      patternHash: this._hashCorrection(skill, reason)
    };

    this._corrections.push(correction);
    this._saveCorrections();

    this.emit('correction', correction);

    // Check if this correction pattern has hit threshold
    const patternCount = this._corrections.filter(c => c.patternHash === correction.patternHash).length;
    if (patternCount >= this.config.correctionThreshold) {
      this._generateCorrectionProposal(skill, correction.patternHash);
    }

    return correction;
  }

  /**
   * Record user feedback (thumbs up/down, rating, comment).
   */
  recordFeedback(skill, rating, comment = '', context = {}) {
    const feedback = {
      id: this._generateId(),
      type: 'feedback',
      skill,
      rating, // 1-5 or 'up'/'down'
      comment,
      context,
      timestamp: new Date().toISOString()
    };

    // Store as a correction if negative
    if (rating === 'down' || rating <= 2) {
      this.recordCorrection(skill, context.output, null, comment || 'Negative feedback', context);
    }

    return feedback;
  }

  // ── Analyze: Pattern Detection ─────────────────────────────────

  /**
   * Run the full analysis pipeline. Call this daily/weekly.
   * 
   * @param {number} days - Lookback period
   * @returns {Object} Analysis results with insights and proposals
   */
  async analyze(days = 7) {
    const startTime = Date.now();
    this._insights = []; // Fresh insights each run

    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║      X1 VAULT — SELF-IMPROVEMENT ANALYSIS    ║');
    console.log('╚══════════════════════════════════════════════╝\n');

    // 1. Analyze error patterns
    if (this.logger) {
      await this._analyzeErrors(days);
    }

    // 2. Analyze correction patterns
    this._analyzeCorrections(days);

    // 3. Analyze gate decisions
    if (this.gates) {
      this._analyzeGateDecisions(days);
    }

    // 4. Analyze route performance
    if (this.router) {
      this._analyzeRoutePerformance(days);
    }

    // 5. Analyze unmatched messages
    if (this.router) {
      this._analyzeUnmatchedMessages();
    }

    // 6. Generate proposals from insights
    this._generateProposals();

    // 7. Track metrics over time
    this._trackMetrics(days);

    // 8. Save everything
    this._saveInsights();
    this._saveProposals();
    this._saveMetrics();

    const duration = Date.now() - startTime;

    const summary = {
      duration_ms: duration,
      period: `${days} days`,
      insights: this._insights.length,
      new_proposals: this._proposals.filter(p => p.status === PROPOSAL_STATUS.PENDING).length,
      breakdown: this._getInsightBreakdown()
    };

    console.log(`\n📊 Analysis complete in ${duration}ms`);
    console.log(`   Insights found: ${summary.insights}`);
    console.log(`   New proposals: ${summary.new_proposals}`);

    this.emit('analysis-complete', summary);
    return summary;
  }

  // ── Analysis Sub-Routines ──────────────────────────────────────

  async _analyzeErrors(days) {
    console.log('── Analyzing Error Patterns ──────────────────');
    
    const report = this.logger.generateReport(days);
    const recurring = this.logger.getRecurringErrors(10);

    for (const { hash, count, latestEntry } of recurring) {
      if (count >= this.config.errorThreshold && latestEntry) {
        this._addInsight({
          type: INSIGHT_TYPE.ERROR_PATTERN,
          severity: count > 10 ? 'high' : 'medium',
          skill: latestEntry.skill,
          message: `Error "${latestEntry.message}" has occurred ${count} times`,
          data: { hash, count, errorType: latestEntry.error_type, skill: latestEntry.skill }
        });
      }
    }

    // Check for skills with high error rates
    for (const [skill, data] of Object.entries(report.by_skill)) {
      const totalForSkill = data.errors;
      if (totalForSkill > 5) {
        this._addInsight({
          type: INSIGHT_TYPE.PERFORMANCE,
          severity: 'medium',
          skill,
          message: `${skill} has ${totalForSkill} errors in the last ${days} days`,
          data: { errorCount: totalForSkill, types: data.types }
        });
      }
    }

    console.log(`   Found ${this._insights.filter(i => i.type === INSIGHT_TYPE.ERROR_PATTERN).length} error patterns`);
  }

  _analyzeCorrections(days) {
    console.log('── Analyzing Correction Patterns ─────────────');

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const recentCorrections = this._corrections.filter(c => 
      new Date(c.timestamp) >= cutoff
    );

    // Group by pattern hash
    const patterns = {};
    for (const c of recentCorrections) {
      if (!patterns[c.patternHash]) {
        patterns[c.patternHash] = { corrections: [], skill: c.skill, reasons: [] };
      }
      patterns[c.patternHash].corrections.push(c);
      if (c.reason) patterns[c.patternHash].reasons.push(c.reason);
    }

    for (const [hash, data] of Object.entries(patterns)) {
      if (data.corrections.length >= this.config.correctionThreshold) {
        const commonReason = this._findCommonReason(data.reasons);
        this._addInsight({
          type: INSIGHT_TYPE.CORRECTION_PATTERN,
          severity: 'high',
          skill: data.skill,
          message: `User corrected ${data.skill} ${data.corrections.length} times: "${commonReason}"`,
          data: {
            patternHash: hash,
            count: data.corrections.length,
            commonReason,
            examples: data.corrections.slice(-3)
          }
        });
      }
    }

    console.log(`   Found ${this._insights.filter(i => i.type === INSIGHT_TYPE.CORRECTION_PATTERN).length} correction patterns`);
  }

  _analyzeGateDecisions(days) {
    console.log('── Analyzing Gate Decisions ──────────────────');

    const stats = this.gates.getStats(days);

    // Skills always approved → suggest lowering risk
    for (const candidate of stats.autoApprovalCandidates) {
      this._addInsight({
        type: INSIGHT_TYPE.RISK_ADJUSTMENT,
        severity: 'low',
        skill: candidate.skill,
        message: candidate.suggestion,
        data: { direction: 'lower', approvals: candidate.totalApprovals }
      });
    }

    // Skills frequently rejected → suggest raising risk or fixing
    for (const [skill, data] of Object.entries(stats.bySkill)) {
      if (data.rejected >= this.config.rejectionThreshold) {
        this._addInsight({
          type: INSIGHT_TYPE.RISK_ADJUSTMENT,
          severity: 'medium',
          skill,
          message: `${skill} rejected ${data.rejected}/${data.total} times — consider raising risk level or fixing output quality`,
          data: { direction: 'raise', rejections: data.rejected, total: data.total }
        });
      }
    }

    // High expiration rate → timeout too short or user not responsive
    const totalGate1 = stats.gate1.approved + stats.gate1.rejected + stats.gate1.expired;
    if (totalGate1 > 0 && stats.gate1.expired / totalGate1 > 0.3) {
      this._addInsight({
        type: INSIGHT_TYPE.SKILL_UPDATE,
        severity: 'low',
        skill: 'verification-gates',
        message: `${stats.gate1.expired} gate expirations (${Math.round(stats.gate1.expired / totalGate1 * 100)}%) — consider increasing timeout`,
        data: { expirations: stats.gate1.expired, total: totalGate1 }
      });
    }

    console.log(`   Found ${this._insights.filter(i => i.type === INSIGHT_TYPE.RISK_ADJUSTMENT).length} risk adjustments`);
  }

  _analyzeRoutePerformance(days) {
    console.log('── Analyzing Route Performance ───────────────');

    const analytics = this.router.getAnalytics();

    for (const [route, stats] of Object.entries(analytics.routeStats)) {
      // Check for degrading success rate
      const successRate = parseFloat(stats.successRate);
      if (!isNaN(successRate) && successRate < 80 && stats.executions > 5) {
        this._addInsight({
          type: INSIGHT_TYPE.PERFORMANCE,
          severity: 'medium',
          skill: route,
          message: `${route} success rate dropped to ${stats.successRate} (${stats.executions} executions)`,
          data: { successRate: stats.successRate, avgDuration: stats.avgDuration }
        });
      }

      // Check for slow routes
      const avgMs = parseInt(stats.avgDuration);
      if (!isNaN(avgMs) && avgMs > 5000) {
        this._addInsight({
          type: INSIGHT_TYPE.PERFORMANCE,
          severity: 'low',
          skill: route,
          message: `${route} averaging ${stats.avgDuration} — consider optimization`,
          data: { avgDuration: stats.avgDuration }
        });
      }
    }

    // Check for unused routes
    const allRoutes = this.router.listRoutes();
    for (const route of allRoutes) {
      if (!analytics.routeStats[route.name]) {
        this._addInsight({
          type: INSIGHT_TYPE.UNUSED_ROUTE,
          severity: 'low',
          skill: route.name,
          message: `${route.name} has never been triggered — consider removing or improving patterns`,
          data: { patterns: route.patterns }
        });
      }
    }

    console.log(`   Found ${this._insights.filter(i => i.type === INSIGHT_TYPE.PERFORMANCE).length} performance issues`);
  }

  _analyzeUnmatchedMessages() {
    console.log('── Analyzing Unmatched Messages ──────────────');

    const analytics = this.router.getAnalytics();
    const misses = analytics.recentMisses || [];

    if (misses.length < this.config.missThreshold) return;

    // Cluster similar unmatched messages
    const clusters = this._clusterMessages(misses.map(m => m.message));

    for (const cluster of clusters) {
      if (cluster.count >= 3) {
        this._addInsight({
          type: INSIGHT_TYPE.NEW_ROUTE,
          severity: 'medium',
          skill: null,
          message: `${cluster.count} similar unmatched messages like: "${cluster.representative}"`,
          data: { examples: cluster.messages, suggestedPattern: cluster.suggestedPattern }
        });
      }
    }

    console.log(`   Found ${this._insights.filter(i => i.type === INSIGHT_TYPE.NEW_ROUTE).length} new route suggestions`);
  }

  // ── Proposal Generation ────────────────────────────────────────

  _generateProposals() {
    console.log('── Generating Proposals ──────────────────────');

    for (const insight of this._insights) {
      // Don't generate duplicate proposals
      const existingProposal = this._proposals.find(p =>
        p.insightType === insight.type &&
        p.skill === insight.skill &&
        p.status === PROPOSAL_STATUS.PENDING
      );
      if (existingProposal) continue;

      const proposal = this._insightToProposal(insight);
      if (proposal) {
        this._proposals.push(proposal);
        this.emit('new-proposal', proposal);
      }
    }

    const newCount = this._proposals.filter(p => p.status === PROPOSAL_STATUS.PENDING).length;
    console.log(`   Generated ${newCount} pending proposals`);
  }

  _insightToProposal(insight) {
    const base = {
      id: this._generateId(),
      insightType: insight.type,
      skill: insight.skill,
      severity: insight.severity,
      status: PROPOSAL_STATUS.PENDING,
      createdAt: new Date().toISOString(),
      insight: insight.message,
      data: insight.data
    };

    switch (insight.type) {
      case INSIGHT_TYPE.ERROR_PATTERN:
        return {
          ...base,
          action: 'add_error_handling',
          description: `Add error handling for recurring ${insight.data.errorType} error in ${insight.skill}`,
          implementation: `Wrap ${insight.skill} handler with retry/fallback for "${insight.data.errorType}" errors`,
          effort: 'medium'
        };

      case INSIGHT_TYPE.CORRECTION_PATTERN:
        return {
          ...base,
          action: 'update_skill_logic',
          description: `Fix ${insight.skill}: ${insight.data.commonReason}`,
          implementation: `Update ${insight.skill} handler to account for: "${insight.data.commonReason}". Examples of corrections available in improvement-data/corrections.json`,
          effort: 'high'
        };

      case INSIGHT_TYPE.RISK_ADJUSTMENT:
        return {
          ...base,
          action: 'adjust_risk_level',
          description: `${insight.data.direction === 'lower' ? 'Lower' : 'Raise'} risk level for ${insight.skill}`,
          implementation: insight.data.direction === 'lower'
            ? `Change risk from 'high' to 'medium' in routes.js for ${insight.skill}`
            : `Change risk from 'medium' to 'high' in routes.js for ${insight.skill}`,
          effort: 'low',
          autoApplicable: true
        };

      case INSIGHT_TYPE.NEW_ROUTE:
        return {
          ...base,
          action: 'add_new_route',
          description: `Add new route for unmatched messages like: "${insight.data.examples?.[0]}"`,
          implementation: `Add a new route in routes.js with pattern: ${insight.data.suggestedPattern || 'TBD'}`,
          effort: 'medium'
        };

      case INSIGHT_TYPE.PERFORMANCE:
        return {
          ...base,
          action: 'optimize_performance',
          description: `Optimize ${insight.skill}: ${insight.message}`,
          implementation: `Profile and optimize ${insight.skill} handler. Check for slow API calls, unnecessary processing, or missing caching.`,
          effort: 'medium'
        };

      case INSIGHT_TYPE.UNUSED_ROUTE:
        return {
          ...base,
          action: 'review_unused_route',
          description: `Review unused route: ${insight.skill}`,
          implementation: `Either improve trigger patterns or remove ${insight.skill} if no longer needed`,
          effort: 'low'
        };

      default:
        return {
          ...base,
          action: 'manual_review',
          description: insight.message,
          implementation: 'Requires manual review',
          effort: 'unknown'
        };
    }
  }

  _generateCorrectionProposal(skill, patternHash) {
    const corrections = this._corrections.filter(c => c.patternHash === patternHash);
    const reasons = corrections.map(c => c.reason).filter(Boolean);
    const commonReason = this._findCommonReason(reasons);

    const proposal = {
      id: this._generateId(),
      insightType: INSIGHT_TYPE.CORRECTION_PATTERN,
      skill,
      severity: 'high',
      status: PROPOSAL_STATUS.PENDING,
      createdAt: new Date().toISOString(),
      action: 'update_skill_logic',
      description: `User corrected ${skill} ${corrections.length}x: "${commonReason}"`,
      implementation: `Review corrections and update ${skill} logic. Corrections stored in improvement-data/corrections.json (patternHash: ${patternHash})`,
      effort: 'high',
      data: {
        patternHash,
        correctionCount: corrections.length,
        commonReason,
        recentExamples: corrections.slice(-3)
      }
    };

    // Avoid duplicates
    const existing = this._proposals.find(p =>
      p.data?.patternHash === patternHash &&
      p.status === PROPOSAL_STATUS.PENDING
    );
    if (!existing) {
      this._proposals.push(proposal);
      this._saveProposals();
      this.emit('new-proposal', proposal);
    }
  }

  // ── Proposal Management ────────────────────────────────────────

  /**
   * Get all proposals, optionally filtered.
   */
  getProposals(filter = {}) {
    let proposals = [...this._proposals];
    
    if (filter.status) proposals = proposals.filter(p => p.status === filter.status);
    if (filter.skill) proposals = proposals.filter(p => p.skill === filter.skill);
    if (filter.severity) proposals = proposals.filter(p => p.severity === filter.severity);
    
    return proposals.sort((a, b) => {
      const severityOrder = { high: 0, medium: 1, low: 2, unknown: 3 };
      return (severityOrder[a.severity] || 3) - (severityOrder[b.severity] || 3);
    });
  }

  /**
   * Approve a proposal.
   */
  approveProposal(proposalId) {
    const proposal = this._proposals.find(p => p.id === proposalId);
    if (!proposal) return null;
    
    proposal.status = PROPOSAL_STATUS.APPROVED;
    proposal.approvedAt = new Date().toISOString();
    this._saveProposals();
    this.emit('proposal-approved', proposal);
    return proposal;
  }

  /**
   * Reject a proposal.
   */
  rejectProposal(proposalId, reason = '') {
    const proposal = this._proposals.find(p => p.id === proposalId);
    if (!proposal) return null;
    
    proposal.status = PROPOSAL_STATUS.REJECTED;
    proposal.rejectedAt = new Date().toISOString();
    proposal.rejectionReason = reason;
    this._saveProposals();
    this.emit('proposal-rejected', proposal);
    return proposal;
  }

  /**
   * Mark a proposal as applied (after implementing the fix).
   */
  markApplied(proposalId, notes = '') {
    const proposal = this._proposals.find(p => p.id === proposalId);
    if (!proposal) return null;
    
    proposal.status = PROPOSAL_STATUS.APPLIED;
    proposal.appliedAt = new Date().toISOString();
    proposal.notes = notes;
    this._saveProposals();
    this.emit('proposal-applied', proposal);
    return proposal;
  }

  // ── Metrics & Reporting ────────────────────────────────────────

  _trackMetrics(days) {
    const metrics = {
      timestamp: new Date().toISOString(),
      period: days,
      corrections: this._corrections.length,
      insights: this._insights.length,
      pendingProposals: this._proposals.filter(p => p.status === PROPOSAL_STATUS.PENDING).length,
      appliedProposals: this._proposals.filter(p => p.status === PROPOSAL_STATUS.APPLIED).length,
      insightBreakdown: this._getInsightBreakdown()
    };

    if (this.logger) {
      const report = this.logger.generateReport(days);
      metrics.errorRate = report.totals.error_rate;
      metrics.totalErrors = report.totals.errors;
    }

    if (this.router) {
      const analytics = this.router.getAnalytics();
      metrics.totalRouted = analytics.totalRouted;
      metrics.totalMisses = analytics.totalMisses;
    }

    this._metricsHistory.push(metrics);
    // Keep last 90 data points
    if (this._metricsHistory.length > 90) this._metricsHistory.shift();
  }

  _getInsightBreakdown() {
    const breakdown = {};
    for (const insight of this._insights) {
      breakdown[insight.type] = (breakdown[insight.type] || 0) + 1;
    }
    return breakdown;
  }

  /**
   * Get a summary report for display.
   */
  getReport() {
    const pending = this._proposals.filter(p => p.status === PROPOSAL_STATUS.PENDING);
    const applied = this._proposals.filter(p => p.status === PROPOSAL_STATUS.APPLIED);

    // Calculate improvement trend
    const recentMetrics = this._metricsHistory.slice(-4);
    let trend = 'stable';
    if (recentMetrics.length >= 2) {
      const first = recentMetrics[0];
      const last = recentMetrics[recentMetrics.length - 1];
      if (last.errorRate !== undefined && first.errorRate !== undefined) {
        if (last.errorRate < first.errorRate * 0.8) trend = 'improving';
        else if (last.errorRate > first.errorRate * 1.2) trend = 'degrading';
      }
    }

    return {
      generated_at: new Date().toISOString(),
      trend,
      corrections: {
        total: this._corrections.length,
        recent: this._corrections.slice(-5)
      },
      proposals: {
        pending: pending.length,
        applied: applied.length,
        topPending: pending.slice(0, 5)
      },
      insights: {
        total: this._insights.length,
        breakdown: this._getInsightBreakdown()
      },
      metricsHistory: this._metricsHistory.slice(-10)
    };
  }

  // ── Helper Methods ─────────────────────────────────────────────

  _addInsight(insight) {
    this._insights.push({
      id: this._generateId(),
      ...insight,
      timestamp: new Date().toISOString()
    });
  }

  _hashCorrection(skill, reason) {
    const key = `${skill}:${(reason || '').toLowerCase().trim()}`;
    return crypto.createHash('md5').update(key).digest('hex').slice(0, 10);
  }

  _findCommonReason(reasons) {
    if (reasons.length === 0) return 'Unknown';
    // Simple: return most frequent reason
    const counts = {};
    for (const r of reasons) {
      const normalized = r.toLowerCase().trim();
      counts[normalized] = (counts[normalized] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return sorted[0][0];
  }

  _clusterMessages(messages) {
    // Simple keyword-based clustering
    const clusters = [];

    for (const msg of messages) {
      const words = msg.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      let matched = false;

      for (const cluster of clusters) {
        const overlap = words.filter(w => cluster.keywords.has(w)).length;
        if (overlap >= 2 || (words.length <= 3 && overlap >= 1)) {
          cluster.messages.push(msg);
          cluster.count++;
          for (const w of words) cluster.keywords.add(w);
          matched = true;
          break;
        }
      }

      if (!matched) {
        clusters.push({
          representative: msg,
          messages: [msg],
          count: 1,
          keywords: new Set(words),
          suggestedPattern: words.length > 0 ? words.join('.*') : null
        });
      }
    }

    return clusters.map(c => ({
      ...c,
      keywords: [...c.keywords]
    }));
  }

  _summarize(data) {
    if (!data) return null;
    try {
      const str = typeof data === 'string' ? data : JSON.stringify(data);
      return str.length > 500 ? str.slice(0, 500) + '...' : str;
    } catch {
      return '[unserializable]';
    }
  }

  _generateId() {
    return crypto.randomBytes(6).toString('hex');
  }

  // ── Persistence ────────────────────────────────────────────────

  _ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  _loadData() {
    this._corrections = this._loadJson(this.correctionsFile, []);
    this._proposals = this._loadJson(this.proposalsFile, []);
    this._metricsHistory = this._loadJson(this.metricsFile, []);
  }

  _loadJson(filePath, defaultValue) {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      }
    } catch { /* corrupted file, start fresh */ }
    return defaultValue;
  }

  _saveCorrections() {
    fs.writeFileSync(this.correctionsFile, JSON.stringify(this._corrections, null, 2));
  }

  _saveProposals() {
    fs.writeFileSync(this.proposalsFile, JSON.stringify(this._proposals, null, 2));
  }

  _saveInsights() {
    fs.writeFileSync(this.insightsFile, JSON.stringify(this._insights, null, 2));
  }

  _saveMetrics() {
    fs.writeFileSync(this.metricsFile, JSON.stringify(this._metricsHistory, null, 2));
  }
}

// ─── Exports ─────────────────────────────────────────────────────────

module.exports = {
  SelfImprovementLoop,
  INSIGHT_TYPE,
  PROPOSAL_STATUS
};
