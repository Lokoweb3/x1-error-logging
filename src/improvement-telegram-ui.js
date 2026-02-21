/**
 * X1 Vault — Self-Improvement Telegram Integration
 * 
 * Adds Telegram commands and notifications for the improvement loop.
 * 
 * Commands:
 *   /proposals           — Show pending improvement proposals
 *   /propose approve <id> — Approve a proposal
 *   /propose reject <id>  — Reject a proposal
 *   /propose applied <id> — Mark as implemented
 *   /corrections          — Show recent corrections
 *   /improve              — Run analysis now
 *   /trend                — Show improvement trend
 * 
 * Usage:
 *   const improvementUI = new ImprovementTelegramUI({ bot, loop, adminChatId });
 */

const { PROPOSAL_STATUS } = require('./self-improvement-loop');

function getImprovementRoutes(loop) {
  return [
    // ── View Proposals ────────────────────────────────────────
    {
      name: 'proposals',
      patterns: [
        /^\/proposals?$/i,
        /show\s+proposals/i,
        /improvement\s+suggestions/i
      ],
      aliases: ['proposals'],
      agent: 'CoordinatorAgent',
      priority: 3,
      risk: 'none',
      description: 'Show pending improvement proposals',
      handler: async () => {
        const pending = loop.getProposals({ status: PROPOSAL_STATUS.PENDING });
        
        if (pending.length === 0) {
          return { message: '✅ No pending proposals. System is running clean.' };
        }

        const lines = pending.map((p, i) => {
          const emoji = p.severity === 'high' ? '🔴' : p.severity === 'medium' ? '🟡' : '🟢';
          return `${emoji} *${i + 1}. ${p.description}*\n` +
            `   ID: \`${p.id}\`\n` +
            `   Skill: ${p.skill || 'global'}\n` +
            `   Action: ${p.action}\n` +
            `   Effort: ${p.effort}`;
        });

        return {
          message: `📋 *${pending.length} Pending Proposals:*\n\n${lines.join('\n\n')}\n\n` +
            `Use \`/propose approve <id>\` or \`/propose reject <id>\``
        };
      }
    },

    // ── Manage Proposals ──────────────────────────────────────
    {
      name: 'propose-action',
      patterns: [
        /^\/propose\s+(approve|reject|applied)\s+(\S+)(?:\s+(.+))?/i
      ],
      aliases: [],
      agent: 'CoordinatorAgent',
      priority: 3,
      risk: 'none',
      description: 'Approve, reject, or mark a proposal as applied',
      handler: async (match) => {
        const action = match[1].toLowerCase();
        const proposalId = match[2];
        const reason = match[3] || '';

        let result;
        switch (action) {
          case 'approve':
            result = loop.approveProposal(proposalId);
            if (result) return { message: `✅ Proposal \`${proposalId}\` approved.\n\n*Implementation:*\n${result.implementation}` };
            break;
          case 'reject':
            result = loop.rejectProposal(proposalId, reason);
            if (result) return { message: `❌ Proposal \`${proposalId}\` rejected.${reason ? ' Reason: ' + reason : ''}` };
            break;
          case 'applied':
            result = loop.markApplied(proposalId, reason);
            if (result) return { message: `🚀 Proposal \`${proposalId}\` marked as applied. Nice work.` };
            break;
        }

        return { message: `⚠️ Proposal \`${proposalId}\` not found.` };
      }
    },

    // ── View Corrections ──────────────────────────────────────
    {
      name: 'corrections',
      patterns: [
        /^\/corrections?$/i,
        /show\s+corrections/i,
        /what\s+did\s+i\s+correct/i
      ],
      aliases: ['corrections'],
      agent: 'CoordinatorAgent',
      priority: 3,
      risk: 'none',
      description: 'Show recent user corrections',
      handler: async () => {
        const report = loop.getReport();
        const recent = report.corrections.recent;

        if (recent.length === 0) {
          return { message: '✅ No corrections recorded yet.' };
        }

        const lines = recent.map(c =>
          `• *${c.skill}*: ${c.reason || 'No reason given'}\n  _${c.timestamp}_`
        );

        return {
          message: `📝 *Recent Corrections (${report.corrections.total} total):*\n\n${lines.join('\n\n')}`
        };
      }
    },

    // ── Run Analysis ──────────────────────────────────────────
    {
      name: 'improve',
      patterns: [
        /^\/improve$/i,
        /^\/analyze$/i,
        /run\s+(?:self[- ]?)?improvement/i,
        /run\s+analysis/i
      ],
      aliases: ['improve', 'analyze'],
      agent: 'CoordinatorAgent',
      priority: 2,
      risk: 'low',
      description: 'Run self-improvement analysis now',
      handler: async () => {
        const summary = await loop.analyze(7);
        
        let msg = `🧠 *Self-Improvement Analysis Complete*\n\n`;
        msg += `⏱ Duration: ${summary.duration_ms}ms\n`;
        msg += `💡 Insights: ${summary.insights}\n`;
        msg += `📋 New proposals: ${summary.new_proposals}\n\n`;

        if (Object.keys(summary.breakdown).length > 0) {
          msg += `*Breakdown:*\n`;
          for (const [type, count] of Object.entries(summary.breakdown)) {
            msg += `  • ${type}: ${count}\n`;
          }
        }

        if (summary.new_proposals > 0) {
          msg += `\nType \`/proposals\` to review.`;
        }

        return { message: msg };
      }
    },

    // ── Improvement Trend ─────────────────────────────────────
    {
      name: 'trend',
      patterns: [
        /^\/trend$/i,
        /improvement\s+trend/i,
        /how\s+am\s+i\s+doing/i,
        /system\s+trend/i
      ],
      aliases: ['trend'],
      agent: 'CoordinatorAgent',
      priority: 3,
      risk: 'none',
      description: 'Show system improvement trend over time',
      handler: async () => {
        const report = loop.getReport();

        const trendEmoji = report.trend === 'improving' ? '📈' : 
                           report.trend === 'degrading' ? '📉' : '➡️';

        let msg = `${trendEmoji} *System Trend: ${report.trend.toUpperCase()}*\n\n`;
        msg += `📋 Proposals: ${report.proposals.pending} pending, ${report.proposals.applied} applied\n`;
        msg += `📝 Corrections: ${report.corrections.total} total\n`;
        msg += `💡 Insights: ${report.insights.total} from last analysis\n`;

        // Show recent metrics
        if (report.metricsHistory.length > 0) {
          const latest = report.metricsHistory[report.metricsHistory.length - 1];
          msg += `\n*Latest Metrics:*\n`;
          if (latest.errorRate !== undefined) msg += `  Error rate: ${(latest.errorRate * 100).toFixed(1)}%\n`;
          if (latest.totalRouted !== undefined) msg += `  Total routed: ${latest.totalRouted}\n`;
          if (latest.totalMisses !== undefined) msg += `  Unmatched: ${latest.totalMisses}\n`;
        }

        return { message: msg };
      }
    },

    // ── Record Correction (inline) ────────────────────────────
    {
      name: 'correct',
      patterns: [
        /^\/correct\s+(\S+)\s+(.+)/i,
        /correction:\s*(\S+)\s+(.+)/i
      ],
      aliases: ['correct'],
      agent: 'CoordinatorAgent',
      priority: 3,
      risk: 'none',
      description: 'Record a correction: /correct <skill> <what was wrong>',
      handler: async (match) => {
        const skill = match[1];
        const reason = match[2];

        loop.recordCorrection(skill, null, null, reason, {});

        return { message: `📝 Correction recorded for \`${skill}\`: "${reason}"` };
      }
    }
  ];
}

/**
 * Auto-notification setup. Call once at bot startup.
 * Sends Telegram alerts when new proposals are generated.
 */
function setupImprovementNotifications(bot, loop, adminChatId) {
  if (!adminChatId) return;

  loop.on('new-proposal', (proposal) => {
    const emoji = proposal.severity === 'high' ? '🔴' : proposal.severity === 'medium' ? '🟡' : '🟢';
    bot.sendMessage(adminChatId,
      `${emoji} *New Improvement Proposal*\n\n` +
      `*${proposal.description}*\n` +
      `Skill: ${proposal.skill || 'global'}\n` +
      `ID: \`${proposal.id}\`\n\n` +
      `\`/propose approve ${proposal.id}\` to approve`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  });

  loop.on('analysis-complete', (summary) => {
    if (summary.new_proposals > 0) {
      bot.sendMessage(adminChatId,
        `🧠 Analysis complete: ${summary.insights} insights, ${summary.new_proposals} new proposals.\nType /proposals to review.`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    }
  });
}

module.exports = { getImprovementRoutes, setupImprovementNotifications };
