/**
 * X1 Vault — Auto-Fix Telegram Integration
 * 
 * Commands:
 *   /autofix           — Run the AI auto-fix pipeline
 *   /fixes             — Show pending fixes
 *   /fix approve <id>  — Approve and apply a fix
 *   /fix reject <id>   — Reject a fix
 *   /fix show <id>     — Show the diff for a fix
 *   /fixreport         — Show fix statistics
 */

const { FIX_STATUS } = require('./autofix-engine');

function getAutoFixRoutes(autofix) {
  return [
    // ── Run Pipeline ──────────────────────────────────────────
    {
      name: 'autofix-run',
      patterns: [
        /^\/autofix$/i,
        /run\s+auto[- ]?fix/i,
        /generate\s+fixes/i
      ],
      aliases: ['autofix'],
      agent: 'CoordinatorAgent',
      priority: 2,
      risk: 'low',
      description: 'Run the AI auto-fix pipeline',
      handler: async () => {
        const result = await autofix.runPipeline();
        const readyFixes = result.fixes.filter(f => f.status === FIX_STATUS.READY);
        const failedFixes = result.fixes.filter(f => f.status === FIX_STATUS.FAILED);

        let msg = `🤖 *Auto-Fix Pipeline Complete*\n\n`;
        msg += `Fixes generated: ${readyFixes.length}\n`;
        msg += `Failed to generate: ${failedFixes.length}\n`;
        msg += `Skipped (not fixable): ${result.skipped}\n`;

        if (readyFixes.length > 0) {
          msg += `\n*Ready for review:*\n`;
          for (const fix of readyFixes) {
            msg += `\n⚡ \`${fix.id}\` — ${fix.proposal.description}\n`;
            msg += `   ${fix.explanation}\n`;
          }
          msg += `\nUse \`/fix show <id>\` to see the diff`;
          msg += `\nUse \`/fix approve <id>\` to apply`;
        }

        return { message: msg };
      }
    },

    // ── List Fixes ────────────────────────────────────────────
    {
      name: 'fixes-list',
      patterns: [
        /^\/fixes$/i,
        /show\s+fixes/i,
        /pending\s+fixes/i
      ],
      aliases: ['fixes'],
      agent: 'CoordinatorAgent',
      priority: 3,
      risk: 'none',
      description: 'Show pending AI-generated fixes',
      handler: async () => {
        const ready = autofix.getFixes({ status: FIX_STATUS.READY });
        const approved = autofix.getFixes({ status: FIX_STATUS.APPROVED });
        const deployed = autofix.getFixes({ status: FIX_STATUS.DEPLOYED });

        if (ready.length === 0 && approved.length === 0) {
          return { message: '✅ No pending fixes. Run `/autofix` to generate new ones.' };
        }

        let msg = `🔧 *AI-Generated Fixes*\n`;

        if (ready.length > 0) {
          msg += `\n*Awaiting Approval (${ready.length}):*\n`;
          for (const fix of ready) {
            msg += `⚡ \`${fix.id}\` — ${fix.proposal.description}\n`;
          }
        }

        if (approved.length > 0) {
          msg += `\n*Approved, Ready to Deploy (${approved.length}):*\n`;
          for (const fix of approved) {
            msg += `✅ \`${fix.id}\` — ${fix.proposal.description}\n`;
          }
        }

        if (deployed.length > 0) {
          msg += `\n*Recently Deployed (${deployed.length}):*\n`;
          for (const fix of deployed.slice(-3)) {
            msg += `🚀 \`${fix.id}\` — ${fix.proposal.description}\n`;
          }
        }

        return { message: msg };
      }
    },

    // ── Show Fix Diff ─────────────────────────────────────────
    {
      name: 'fix-show',
      patterns: [
        /^\/fix\s+show\s+(\S+)/i,
        /show\s+fix\s+(\S+)/i,
        /fix\s+diff\s+(\S+)/i
      ],
      agent: 'CoordinatorAgent',
      priority: 3,
      risk: 'none',
      description: 'Show the diff for a specific fix',
      handler: async (match) => {
        const fixId = match[1];
        const fixes = autofix.getFixes();
        const fix = fixes.find(f => f.id === fixId);

        if (!fix) return { message: `⚠️ Fix \`${fixId}\` not found.` };

        let msg = `🔍 *Fix ${fix.id}*\n\n`;
        msg += `*Skill:* ${fix.skill}\n`;
        msg += `*Status:* ${fix.status}\n`;
        msg += `*File:* \`${fix.sourceFile}\`\n\n`;
        msg += `*Explanation:*\n${fix.explanation}\n\n`;

        if (fix.diff) {
          // Truncate diff for Telegram
          const diffPreview = fix.diff.length > 1500
            ? fix.diff.slice(0, 1500) + '\n... (truncated)'
            : fix.diff;
          msg += `*Diff:*\n\`\`\`\n${diffPreview}\n\`\`\`\n`;
        }

        if (fix.status === FIX_STATUS.READY) {
          msg += `\n\`/fix approve ${fix.id}\` to apply`;
          msg += `\n\`/fix reject ${fix.id}\` to discard`;
        }

        return { message: msg };
      }
    },

    // ── Approve/Reject/Apply Fix ──────────────────────────────
    {
      name: 'fix-action',
      patterns: [
        /^\/fix\s+(approve|reject|apply)\s+(\S+)(?:\s+(.+))?/i
      ],
      agent: 'CoordinatorAgent',
      priority: 2,
      risk: 'high',  // Applying code changes is high-risk
      description: 'Approve, reject, or apply an AI-generated fix',
      handler: async (match) => {
        const action = match[1].toLowerCase();
        const fixId = match[2];
        const reason = match[3] || '';

        switch (action) {
          case 'approve': {
            const fix = autofix.approveFix(fixId);
            if (!fix) return { message: `⚠️ Fix \`${fixId}\` not found or not in ready state.` };

            // Auto-apply after approval
            const result = await autofix.applyFix(fixId);
            if (result.success) {
              let msg = `🚀 *Fix ${fixId} Deployed*\n\n`;
              msg += `*Skill:* ${fix.skill}\n`;
              msg += `*What changed:* ${fix.explanation}\n`;
              if (fix.testResults?.testFile) {
                msg += `*Tests:* ✅ Passed\n`;
              } else {
                msg += `*Tests:* ⚠️ No test file found (skipped)\n`;
              }
              msg += `*Backup:* \`${fix.backupPath}\`\n`;
              msg += `\nThe fix is live. Monitor for new errors.`;
              return { message: msg };
            } else {
              let msg = `❌ *Fix ${fixId} Failed*\n\n`;
              msg += `*Reason:* ${result.reason}\n`;
              msg += `*Status:* Rolled back to original\n`;
              msg += `\nThe original code has been restored.`;
              return { message: msg };
            }
          }

          case 'reject': {
            const fix = autofix.rejectFix(fixId, reason);
            if (!fix) return { message: `⚠️ Fix \`${fixId}\` not found.` };
            return { message: `❌ Fix \`${fixId}\` rejected.${reason ? ' Reason: ' + reason : ''}` };
          }

          default:
            return { message: `Unknown action: ${action}` };
        }
      }
    },

    // ── Fix Report ────────────────────────────────────────────
    {
      name: 'fix-report',
      patterns: [
        /^\/fixreport$/i,
        /fix\s+report/i,
        /fix\s+stats/i
      ],
      aliases: ['fixreport'],
      agent: 'CoordinatorAgent',
      priority: 3,
      risk: 'none',
      description: 'Show auto-fix statistics',
      handler: async () => {
        const report = autofix.getReport();

        let msg = `📊 *Auto-Fix Report*\n\n`;
        msg += `Total fixes: ${report.total}\n`;
        msg += `✅ Deployed: ${report.byStatus.deployed}\n`;
        msg += `⏳ Ready: ${report.byStatus.ready}\n`;
        msg += `❌ Failed: ${report.byStatus.failed}\n`;
        msg += `🚫 Rejected: ${report.byStatus.rejected}\n`;
        msg += `↩️ Rolled back: ${report.byStatus.rolledBack}\n`;

        if (report.recentFixes.length > 0) {
          msg += `\n*Recent:*\n`;
          for (const fix of report.recentFixes) {
            const icon = fix.status === FIX_STATUS.DEPLOYED ? '🚀' :
                         fix.status === FIX_STATUS.READY ? '⚡' :
                         fix.status === FIX_STATUS.FAILED ? '❌' : '⏳';
            msg += `${icon} \`${fix.id}\` ${fix.skill} — ${fix.status}\n`;
          }
        }

        return { message: msg };
      }
    }
  ];
}

/**
 * Auto-notification setup for fix events.
 */
function setupAutoFixNotifications(bot, autofix, adminChatId) {
  if (!adminChatId) return;

  autofix.on('fix-ready', (fix) => {
    bot.sendMessage(adminChatId,
      `⚡ *AI Fix Generated*\n\n` +
      `Skill: \`${fix.skill}\`\n` +
      `ID: \`${fix.id}\`\n` +
      `${fix.explanation}\n\n` +
      `\`/fix show ${fix.id}\` to review\n` +
      `\`/fix approve ${fix.id}\` to deploy`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  });

  autofix.on('fix-deployed', (fix) => {
    bot.sendMessage(adminChatId,
      `🚀 Fix \`${fix.id}\` deployed to ${fix.skill}. Monitoring for errors.`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  });

  autofix.on('fix-rolled-back', (fix) => {
    bot.sendMessage(adminChatId,
      `↩️ Fix \`${fix.id}\` rolled back: ${fix.rollbackReason}`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  });
}

module.exports = { getAutoFixRoutes, setupAutoFixNotifications };
