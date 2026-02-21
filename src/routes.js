/**
 * X1 Vault — Route Definitions
 * 
 * Pre-built routes for your X1 multi-agent setup.
 * Import and register these with the WorkflowRouter.
 * 
 * Each route defines:
 *   - What messages trigger it (patterns)
 *   - Which agent handles it
 *   - Risk level (for verification gates later)
 *   - The handler function (replace stubs with your real logic)
 * 
 * Usage:
 *   const { getDefaultRoutes } = require('./routes');
 *   router.addRoutes(getDefaultRoutes(dependencies));
 */

const { PRIORITY, RISK_LEVEL } = require('./workflow-router');

/**
 * Returns all default routes. Pass in your dependencies (API clients, etc.)
 * so handlers can use them.
 * 
 * @param {Object} deps
 * @param {Object} deps.vault - Your X1 Vault client
 * @param {Object} deps.tokenApi - Token audit API client
 * @param {Object} deps.git - Git operations helper
 * @param {Object} deps.bot - Telegram bot instance
 */
function getDefaultRoutes(deps = {}) {
  return [

    // ── Token Audit ────────────────────────────────────────────
    {
      name: 'token-audit',
      patterns: [
        /^\/audit\s+(\S+)/i,
        /audit\s+(?:token\s+)?(\S+)/i,
        /check\s+(?:contract\s+)?(\S+)/i,
        /scan\s+(\S+)/i
      ],
      aliases: ['audit', 'scan', 'check'],
      agent: 'TokenAuditAgent',
      priority: PRIORITY.HIGH,
      risk: RISK_LEVEL.MEDIUM,  // External API calls
      description: 'Audit a token contract for risks and red flags',
      handler: async (match, ctx) => {
        const address = match[1];
        
        // ── Replace with your real audit logic ──
        // const result = await deps.tokenApi.audit(address);
        // return result;
        
        return {
          address,
          status: 'audit_complete',
          message: `Token audit for ${address} — replace this stub with your real audit logic`
        };
      }
    },

    // ── Vault Memory Backup ────────────────────────────────────
    {
      name: 'vault-backup',
      patterns: [
        /^\/backup(?:\s+(.+))?/i,
        /save\s+(?:to\s+)?(?:vault|memory)(?:\s+(.+))?/i,
        /persist\s+(.+)/i,
        /remember\s+(.+)/i
      ],
      aliases: ['backup', 'save', 'persist'],
      agent: 'VaultSyncAgent',
      priority: PRIORITY.NORMAL,
      risk: RISK_LEVEL.LOW,  // Internal write
      autoExecute: true,
      description: 'Save data to X1 Vault memory',
      handler: async (match, ctx) => {
        const data = match[1] || match[2] || ctx.input;
        
        // ── Replace with your vault sync logic ──
        // await deps.vault.backup(data);
        
        return {
          status: 'backed_up',
          key: `memory_${Date.now()}`,
          message: `Saved to vault — replace this stub with your real vault logic`
        };
      }
    },

    // ── Deploy Bot ─────────────────────────────────────────────
    {
      name: 'deploy',
      patterns: [
        /^\/deploy(?:\s+(.+))?/i,
        /deploy\s+(?:bot\s+)?(?:v?(\S+))?/i,
        /release\s+(?:v?(\S+))?/i,
        /push\s+(?:to\s+)?(?:prod|production)/i
      ],
      aliases: ['deploy', 'release'],
      agent: 'DeployAgent',
      priority: PRIORITY.HIGH,
      risk: RISK_LEVEL.HIGH,  // External write — needs confirmation
      autoExecute: false,     // Always confirm deploys
      preChecks: [
        async (ctx) => {
          // ── Replace with real checks ──
          // const gitStatus = await deps.git.status();
          // if (gitStatus.dirty) return { pass: false, reason: 'Uncommitted changes' };
          // const tests = await deps.git.runTests();
          // if (!tests.pass) return { pass: false, reason: 'Tests failing' };
          return { pass: true };
        }
      ],
      description: 'Deploy bot to production (requires confirmation)',
      handler: async (match, ctx) => {
        const version = match[1] || 'latest';
        
        // ── Replace with your deploy logic ──
        // await deps.git.deploy(version);
        
        return {
          status: 'deployed',
          version,
          message: `Deployed v${version} — replace this stub with your real deploy logic`
        };
      }
    },

    // ── Research / Analysis ────────────────────────────────────
    {
      name: 'research',
      patterns: [
        /^\/research\s+(.+)/i,
        /research\s+(.+)/i,
        /analyze\s+(.+)/i,
        /compare\s+(.+)/i,
        /look\s*up\s+(.+)/i
      ],
      aliases: ['research', 'analyze', 'lookup'],
      agent: 'ResearchAgent',
      priority: PRIORITY.NORMAL,
      risk: RISK_LEVEL.NONE,  // Read-only
      description: 'Research a topic, token, or project',
      handler: async (match, ctx) => {
        const query = match[1];
        
        return {
          query,
          status: 'research_complete',
          message: `Research results for "${query}" — replace with your real research logic`
        };
      }
    },

    // ── Code Review ────────────────────────────────────────────
    {
      name: 'code-review',
      patterns: [
        /^\/review(?:\s+(.+))?/i,
        /review\s+(?:pr|pull\s*request|code)(?:\s+(.+))?/i,
        /check\s+(?:my\s+)?code(?:\s+(.+))?/i
      ],
      aliases: ['review'],
      agent: 'CodeReviewAgent',
      priority: PRIORITY.NORMAL,
      risk: RISK_LEVEL.NONE,
      description: 'Review code or a pull request',
      handler: async (match, ctx) => {
        const target = match[1] || match[2] || 'latest commit';
        
        return {
          target,
          status: 'review_complete',
          message: `Code review for ${target} — replace with your real review logic`
        };
      }
    },

    // ── System Health ──────────────────────────────────────────
    {
      name: 'health',
      patterns: [
        /^\/health/i,
        /^\/status/i,
        /system\s+(?:health|status)/i
      ],
      aliases: ['health', 'status'],
      agent: 'CoordinatorAgent',
      priority: PRIORITY.LOW,
      risk: RISK_LEVEL.NONE,
      description: 'Show system health and error stats',
      handler: async (match, ctx) => {
        if (ctx.logger) {
          return ctx.logger.generateReport(7);
        }
        return { status: 'healthy', message: 'No logger available for detailed stats' };
      }
    },

    // ── Error Queries ──────────────────────────────────────────
    {
      name: 'errors',
      patterns: [
        /^\/errors?(?:\s+(\S+))?/i,
        /show\s+errors?(?:\s+(?:for\s+)?(\S+))?/i,
        /what\s+(?:went\s+wrong|failed|broke)/i
      ],
      aliases: ['errors'],
      agent: 'CoordinatorAgent',
      priority: PRIORITY.LOW,
      risk: RISK_LEVEL.NONE,
      description: 'Show recent errors, optionally filtered by skill',
      handler: async (match, ctx) => {
        const skill = match?.[1] || null;
        if (ctx.logger) {
          const errors = ctx.logger.query({ skill, days: 7 });
          return errors.filter(e => e.type === 'error').slice(-10);
        }
        return [];
      }
    },

    // ── Help ───────────────────────────────────────────────────
    {
      name: 'help',
      patterns: [
        /^\/help/i,
        /^\/commands/i,
        /what\s+can\s+you\s+do/i,
        /show\s+commands/i
      ],
      aliases: ['help', 'commands'],
      agent: 'CoordinatorAgent',
      priority: PRIORITY.LOW,
      risk: RISK_LEVEL.NONE,
      description: 'Show available commands',
      handler: async (match, ctx) => {
        if (ctx.router) {
          return ctx.router.listRoutes().map(r => 
            `/${r.name} — ${r.description} [${r.risk} risk]`
          );
        }
        return ['No routes registered'];
      }
    },

    // ── Analytics ──────────────────────────────────────────────
    {
      name: 'analytics',
      patterns: [
        /^\/analytics/i,
        /^\/stats/i,
        /show\s+(?:analytics|stats|metrics)/i
      ],
      aliases: ['analytics', 'stats'],
      agent: 'CoordinatorAgent',
      priority: PRIORITY.LOW,
      risk: RISK_LEVEL.NONE,
      description: 'Show routing analytics and performance stats',
      handler: async (match, ctx) => {
        if (ctx.router) {
          return ctx.router.getAnalytics();
        }
        return { message: 'No analytics available' };
      }
    }
  ];
}

module.exports = { getDefaultRoutes };
