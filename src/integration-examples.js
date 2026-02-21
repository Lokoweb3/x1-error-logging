/**
 * X1 Vault — Integration Examples
 * 
 * Shows how to plug ErrorLogger into your existing skills and agents.
 * Copy the patterns that fit your setup.
 */

const { ErrorLogger, SEVERITY_LEVELS } = require('./error-logger');

// ─── 1. Initialize Logger (do this once at bot startup) ─────────────

const logger = new ErrorLogger({
  logDir: './errors',
  maxRetries: 2,
  
  // Alert on critical errors (e.g., send Telegram message to you)
  onCritical: (entry) => {
    console.error(`🚨 CRITICAL ERROR in ${entry.skill}: ${entry.message}`);
    // sendTelegramAlert(`Critical error in ${entry.skill}: ${entry.message}`);
  },

  // Alert when an error keeps recurring (auto-fix candidate)
  onThresholdHit: (entry) => {
    console.warn(`🔁 Error ${entry.hash} has occurred ${entry.occurrence_count}x — triggering auto-fix review`);
    // triggerAutoFixReview(entry);
  }
});

// ─── 2. Wrap Your Token Audit Skill ─────────────────────────────────

async function auditToken(contractAddress, chain = 'solana') {
  const { success, result, error, entry } = await logger.wrapSkill(
    'token-audit',
    async () => {
      // Your existing audit logic here
      const response = await fetch(`https://api.example.com/audit/${contractAddress}`);
      if (!response.ok) throw new Error(`API returned ${response.status}`);
      return await response.json();
    },
    { contractAddress, chain },
    { agent: 'TokenAuditAgent' }
  );

  if (!success) {
    return { error: true, message: `Audit failed: ${error.message}`, hash: entry.hash };
  }
  return result;
}

// ─── 3. Wrap Your Vault Sync Skill ──────────────────────────────────

async function syncToVault(key, data) {
  const { success, result, error, entry } = await logger.wrapSkill(
    'vault-sync',
    async () => {
      // Your existing vault sync logic
      // e.g., encrypt and upload to X1 Vault
      if (!key) throw new Error('Vault key is required');
      if (!data) throw new Error('Data cannot be empty');
      
      // ... sync logic ...
      return { synced: true, key, timestamp: Date.now() };
    },
    { key, dataSize: JSON.stringify(data).length },
    { agent: 'VaultSyncAgent' }
  );

  if (!success) {
    return { error: true, message: `Sync failed: ${error.message}` };
  }
  return result;
}

// ─── 4. Wrap Your Deploy Skill (High Risk) ──────────────────────────

async function deployBot(config) {
  const { success, result, error, entry } = await logger.wrapSkill(
    'deploy-bot',
    async () => {
      // Deployment logic
      if (!config.version) throw new Error('Version is required for deployment');
      // ... deploy steps ...
      return { deployed: true, version: config.version };
    },
    config,
    { 
      agent: 'DeployAgent',
      severity: SEVERITY_LEVELS.CRITICAL, // Always critical for deploys
      metadata: { version: config.version, environment: config.env }
    }
  );

  if (!success) {
    // Deploy failures are always escalated
    return { error: true, message: `Deploy failed: ${error.message}`, entry };
  }
  return result;
}

// ─── 5. Manual Capture (for errors outside wrapSkill) ───────────────

function handleTelegramError(error, chatId, command) {
  // For errors in the Telegram bot handler itself
  logger.capture(error, {
    skill: 'telegram-handler',
    agent: 'CoordinatorAgent',
    input: { chatId, command },
    metadata: { source: 'telegram_webhook' }
  });
}

// ─── 6. Query Errors (for building dashboards or reports) ───────────

function getRecentFailures(skillName) {
  return logger.query({
    skill: skillName,
    days: 7
  });
}

function getAutoFixCandidates() {
  return logger.getRecurringErrors(10)
    .filter(r => r.count > 2);
}

// ─── 7. Record a Fix (after manually or auto-fixing) ────────────────

function recordManualFix(errorHash, description) {
  logger.recordFix(errorHash, {
    description,
    fixedBy: 'user'
  });
}

// ─── 8. Telegram Bot Command Integration ─────────────────────────────

/**
 * Add these commands to your Telegram bot:
 * 
 * /errors          — Show recent errors
 * /errors <skill>  — Show errors for a specific skill
 * /health          — Show system health score
 * /audit           — Run self-audit and show report
 * /fix <hash>      — Mark an error as fixed
 */

function handleErrorCommands(command, args) {
  switch (command) {
    case '/errors': {
      const skill = args[0] || null;
      const errors = logger.query({ skill, days: 7 });
      const summary = errors.slice(-5).map(e => 
        `• [${e.error_type}] ${e.skill}: ${(e.message || '').slice(0, 60)}`
      ).join('\n');
      return `Last 5 errors (7 days):\n${summary || 'No errors found 🎉'}`;
    }
    
    case '/health': {
      const report = logger.generateReport(7);
      const health = calculateHealthScore(report);
      return `System Health: ${health.status} (${health.score}/100)\n${health.notes.join('\n')}`;
    }
    
    case '/fix': {
      const hash = args[0];
      if (!hash) return 'Usage: /fix <error_hash> <description>';
      const description = args.slice(1).join(' ') || 'Manually fixed';
      logger.recordFix(hash, { description, fixedBy: 'user' });
      return `✅ Error ${hash} marked as fixed.`;
    }

    default:
      return null;
  }
}

// ── Quick health score calc (duplicated here for self-contained example)
function calculateHealthScore(report) {
  let score = 100;
  const notes = [];
  if (report.totals.error_rate > 0.3) { score -= 30; notes.push('High error rate'); }
  else if (report.totals.error_rate > 0.1) { score -= 15; notes.push('Moderate error rate'); }
  const unresolved = report.auto_fix_candidates.length;
  if (unresolved > 0) { score -= 10; notes.push(`${unresolved} recurring errors`); }
  if (report.totals.errors === 0) notes.push('Clean — no errors');
  score = Math.max(0, Math.min(100, score));
  let status = score >= 80 ? '🟢 Healthy' : score >= 60 ? '🟡 Needs Attention' : score >= 40 ? '🟠 Degraded' : '🔴 Critical';
  return { score, status, notes };
}

module.exports = {
  logger,
  auditToken,
  syncToVault,
  deployBot,
  handleTelegramError,
  getRecentFailures,
  getAutoFixCandidates,
  recordManualFix,
  handleErrorCommands
};
