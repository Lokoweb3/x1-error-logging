/**
 * X1 Vault — Self-Audit Job
 * 
 * Runs on a schedule (daily/weekly) to:
 *   1. Scan error logs for recurring patterns
 *   2. Identify auto-fix candidates
 *   3. Generate a report for the improvement loop
 *   4. Optionally trigger auto-fix attempts
 * 
 * Usage:
 *   node self-audit.js                    # Run with defaults (7-day lookback)
 *   node self-audit.js --days 30          # 30-day lookback
 *   node self-audit.js --auto-fix         # Attempt auto-fixes for known patterns
 *   node self-audit.js --output report    # Save report to file
 */

const { ErrorLogger } = require('./error-logger');
const fs = require('fs');
const path = require('path');

// ─── Configuration ───────────────────────────────────────────────────

const CONFIG = {
  logDir: process.env.X1_ERROR_LOG_DIR || path.join(process.cwd(), 'errors'),
  reportDir: process.env.X1_REPORT_DIR || path.join(process.cwd(), 'reports'),
  autoFixThreshold: 2,     // Errors repeated more than N times trigger auto-fix
  confidenceThreshold: 0.8, // Minimum confidence to propose a fix
  lookbackDays: 7
};

// ─── Known Fix Patterns ─────────────────────────────────────────────
// 
// This is the "knowledge base" that grows over time.
// Each pattern maps an error signature to a fix strategy.
// The auto-fix pipeline checks here first before escalating.

const KNOWN_FIXES = [
  {
    match: { error_type: 'api', message_contains: 'rate limit' },
    fix: {
      strategy: 'add_retry_with_backoff',
      description: 'Add exponential backoff retry (1s, 2s, 4s)',
      confidence: 0.95,
      template: `
// Add to the failing function:
const retry = async (fn, maxRetries = 3) => {
  for (let i = 0; i < maxRetries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === maxRetries - 1) throw e;
      await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
    }
  }
};`
    }
  },
  {
    match: { error_type: 'network', message_contains: 'econnrefused' },
    fix: {
      strategy: 'check_service_health',
      description: 'Service unreachable — check if endpoint is up, add health check',
      confidence: 0.7,
      template: null // Manual fix — needs human review
    }
  },
  {
    match: { error_type: 'timeout' },
    fix: {
      strategy: 'increase_timeout',
      description: 'Increase timeout threshold or add timeout config',
      confidence: 0.6,
      template: null
    }
  },
  {
    match: { error_type: 'dependency', message_contains: 'cannot find module' },
    fix: {
      strategy: 'install_dependency',
      description: 'Missing module — run npm install',
      confidence: 0.9,
      template: '// Run: npm install <module_name>'
    }
  },
  {
    match: { error_type: 'validation' },
    fix: {
      strategy: 'add_input_validation',
      description: 'Add input validation before the failing operation',
      confidence: 0.5,
      template: null
    }
  }
];

// ─── Pattern Matcher ─────────────────────────────────────────────────

function findKnownFix(entry) {
  for (const pattern of KNOWN_FIXES) {
    const m = pattern.match;
    
    if (m.error_type && entry.error_type !== m.error_type) continue;
    if (m.message_contains && !(entry.message || '').toLowerCase().includes(m.message_contains)) continue;
    
    return pattern.fix;
  }
  return null;
}

// ─── Audit Runner ────────────────────────────────────────────────────

async function runAudit(options = {}) {
  const days = options.days || CONFIG.lookbackDays;
  const autoFix = options.autoFix || false;

  const logger = new ErrorLogger({ logDir: CONFIG.logDir });
  const report = logger.generateReport(days);

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║        X1 VAULT — SELF-AUDIT REPORT         ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // ── Summary ──
  console.log(`📅 Period: Last ${days} days`);
  console.log(`📊 Total errors: ${report.totals.errors}`);
  console.log(`✅ Total successes: ${report.totals.successes}`);
  console.log(`📉 Error rate: ${(report.totals.error_rate * 100).toFixed(1)}%\n`);

  // ── Errors by Skill ──
  if (Object.keys(report.by_skill).length > 0) {
    console.log('── Errors by Skill ──────────────────────────');
    for (const [skill, data] of Object.entries(report.by_skill)) {
      console.log(`  ${skill}: ${data.errors} errors`);
      for (const [type, count] of Object.entries(data.types)) {
        console.log(`    └─ ${type}: ${count}`);
      }
    }
    console.log('');
  }

  // ── Errors by Type ──
  if (Object.keys(report.by_type).length > 0) {
    console.log('── Errors by Type ───────────────────────────');
    for (const [type, count] of Object.entries(report.by_type)) {
      const bar = '█'.repeat(Math.min(count, 30));
      console.log(`  ${type.padEnd(12)} ${bar} ${count}`);
    }
    console.log('');
  }

  // ── Recurring Errors (Auto-Fix Candidates) ──
  const recurring = report.top_recurring.filter(r => r.count > 1);
  if (recurring.length > 0) {
    console.log('── Recurring Errors (Auto-Fix Candidates) ───');
    
    const proposals = [];

    for (const { hash, count, latestEntry } of recurring) {
      console.log(`\n  🔁 Hash: ${hash} (${count}x)`);
      if (latestEntry) {
        console.log(`     Skill: ${latestEntry.skill || 'unknown'}`);
        console.log(`     Type:  ${latestEntry.error_type}`);
        console.log(`     Msg:   ${(latestEntry.message || '').slice(0, 80)}`);

        const knownFix = findKnownFix(latestEntry);
        if (knownFix) {
          console.log(`     💡 Known fix: ${knownFix.description}`);
          console.log(`     📊 Confidence: ${(knownFix.confidence * 100).toFixed(0)}%`);
          
          if (knownFix.confidence >= CONFIG.confidenceThreshold) {
            proposals.push({
              hash,
              entry: latestEntry,
              fix: knownFix,
              occurrences: count
            });
          }
        } else {
          console.log(`     ❓ No known fix — needs manual review`);
        }
      }
    }

    // ── Proposed Fixes ──
    if (proposals.length > 0) {
      console.log('\n── Proposed Fixes ───────────────────────────');
      for (const p of proposals) {
        console.log(`\n  📋 Fix for: ${p.entry.skill || 'unknown'} (${p.hash})`);
        console.log(`     Strategy: ${p.fix.strategy}`);
        console.log(`     Description: ${p.fix.description}`);
        if (p.fix.template) {
          console.log(`     Template:\n${p.fix.template}`);
        }
        
        if (autoFix && p.fix.template) {
          console.log(`     ⚡ AUTO-FIX: Would apply this fix (dry-run mode)`);
          // In production, this would:
          // 1. Apply the fix template
          // 2. Run the test suite
          // 3. If tests pass, commit and log the fix
          // 4. If tests fail, revert and escalate
        }
      }
    }
  }

  // ── Health Score ──
  const healthScore = calculateHealthScore(report);
  console.log('\n── System Health ─────────────────────────────');
  console.log(`  Score: ${healthScore.score}/100`);
  console.log(`  Status: ${healthScore.status}`);
  for (const note of healthScore.notes) {
    console.log(`  • ${note}`);
  }

  // ── Save Report ──
  if (options.output === 'report') {
    if (!fs.existsSync(CONFIG.reportDir)) {
      fs.mkdirSync(CONFIG.reportDir, { recursive: true });
    }
    const reportPath = path.join(CONFIG.reportDir, `audit-${new Date().toISOString().split('T')[0]}.json`);
    fs.writeFileSync(reportPath, JSON.stringify({
      ...report,
      health: healthScore,
      proposals: recurring.map(r => ({
        hash: r.hash,
        count: r.count,
        fix: r.latestEntry ? findKnownFix(r.latestEntry) : null
      }))
    }, null, 2));
    console.log(`\n📁 Report saved to: ${reportPath}`);
  }

  return report;
}

// ─── Health Score Calculator ─────────────────────────────────────────

function calculateHealthScore(report) {
  let score = 100;
  const notes = [];

  // Deduct for high error rate
  if (report.totals.error_rate > 0.3) {
    score -= 30;
    notes.push('High error rate (>30%) — investigate top failing skills');
  } else if (report.totals.error_rate > 0.1) {
    score -= 15;
    notes.push('Moderate error rate (>10%) — review recurring errors');
  }

  // Deduct for unresolved recurring errors
  const unresolvedRecurring = report.auto_fix_candidates.length;
  if (unresolvedRecurring > 3) {
    score -= 20;
    notes.push(`${unresolvedRecurring} recurring errors need attention`);
  } else if (unresolvedRecurring > 0) {
    score -= 10;
    notes.push(`${unresolvedRecurring} recurring error(s) — consider auto-fix`);
  }

  // Deduct for critical errors
  const criticalCount = (report.by_type || {})['permission'] || 0;
  if (criticalCount > 0) {
    score -= 15;
    notes.push(`${criticalCount} permission errors — check API keys/access`);
  }

  // Bonus for no errors
  if (report.totals.errors === 0) {
    notes.push('No errors recorded — system running clean');
  }

  score = Math.max(0, Math.min(100, score));

  let status;
  if (score >= 80) status = '🟢 Healthy';
  else if (score >= 60) status = '🟡 Needs Attention';
  else if (score >= 40) status = '🟠 Degraded';
  else status = '🔴 Critical';

  return { score, status, notes };
}

// ─── CLI Entry Point ─────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {
    days: 7,
    autoFix: false,
    output: null
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) options.days = parseInt(args[i + 1]);
    if (args[i] === '--auto-fix') options.autoFix = true;
    if (args[i] === '--output' && args[i + 1]) options.output = args[i + 1];
  }

  runAudit(options).catch(console.error);
}

module.exports = { runAudit, findKnownFix, KNOWN_FIXES };
