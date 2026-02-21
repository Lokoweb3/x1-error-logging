/**
 * X1 Vault — Gate Telegram Integration
 * 
 * Wires the VerificationGates into your Telegram bot.
 * Renders gates as interactive messages with approve/reject buttons.
 * 
 * Usage:
 *   const gateUI = new GateTelegramUI({ bot, gates, adminChatId });
 *   // That's it — it auto-listens for gate events and callback queries
 */

const { GATE_STATUS } = require('./verification-gates');

class GateTelegramUI {
  constructor(options = {}) {
    this.bot = options.bot;
    this.gates = options.gates;
    this.adminChatId = options.adminChatId;

    if (!this.bot || !this.gates) {
      throw new Error('GateTelegramUI requires bot and gates instances');
    }

    this._bindEvents();
    this._bindCallbacks();
  }

  // ── Event Listeners ────────────────────────────────────────────

  _bindEvents() {
    // When a gate is pending, send a Telegram message
    this.gates.on('gate-pending', (data) => this._renderGate(data));

    // When verification fails, alert
    this.gates.on('verification-failed', (data) => this._renderVerificationFailure(data));

    // When verification is rejected post-execution
    this.gates.on('verification-rejected', (data) => this._renderRejection(data));
  }

  _bindCallbacks() {
    // Handle inline keyboard button presses
    this.bot.on('callback_query', async (query) => {
      const data = query.data;
      if (!data) return;

      // Parse callback data: "gate:approve:gateId" or "gate:reject:gateId"
      const parts = data.split(':');
      if (parts[0] !== 'gate') return;

      const action = parts[1];
      const gateId = parts.slice(2).join(':'); // Rejoin in case gateId contains colons

      const chatId = query.message?.chat?.id;

      if (action === 'approve') {
        const success = this.gates.approve(gateId);
        if (success) {
          await this.bot.answerCallbackQuery(query.id, { text: '✅ Approved' });
          await this._editMessage(chatId, query.message.message_id, '✅ *Approved* — executing...');
        } else {
          await this.bot.answerCallbackQuery(query.id, { text: '⏰ Gate expired or already handled' });
        }
      }

      else if (action === 'reject') {
        const success = this.gates.reject(gateId, 'User rejected via Telegram');
        if (success) {
          await this.bot.answerCallbackQuery(query.id, { text: '❌ Rejected' });
          await this._editMessage(chatId, query.message.message_id, '❌ *Rejected* — action cancelled.');
        } else {
          await this.bot.answerCallbackQuery(query.id, { text: '⏰ Gate expired or already handled' });
        }
      }

      else if (action === 'details') {
        // Show full details of the pending gate
        const pending = this.gates.getPending().find(p => p.gateId === gateId);
        if (pending) {
          const details = this._formatDetails(pending);
          await this.bot.answerCallbackQuery(query.id, { text: 'Details shown below' });
          await this.bot.sendMessage(chatId, details, { parse_mode: 'Markdown' });
        } else {
          await this.bot.answerCallbackQuery(query.id, { text: 'Gate no longer pending' });
        }
      }
    });
  }

  // ── Rendering ──────────────────────────────────────────────────

  async _renderGate(data) {
    const chatId = data.context?.chatId || this.adminChatId;
    if (!chatId) return;

    const isGate1 = data.gate === 'gate1';
    const emoji = isGate1 ? '📋' : '🔍';
    const title = isGate1 ? 'PLAN APPROVAL' : 'OUTPUT VERIFICATION';

    let message = `${emoji} *${title}*\n\n`;
    message += `Skill: \`${data.skill}\`\n`;
    message += `Risk: *${data.risk || 'unknown'}*\n`;

    if (isGate1 && data.plan) {
      message += `\n*Plan:*\n${data.plan.description || JSON.stringify(data.plan).slice(0, 200)}`;
      if (data.plan.steps) {
        message += '\n\n*Steps:*\n';
        data.plan.steps.forEach((step, i) => {
          message += `${i + 1}. ${step}\n`;
        });
      }
      if (data.plan.rollback) {
        message += `\n↩️ *Rollback:* ${data.plan.rollback.description || 'Available'}`;
      }
    }

    if (!isGate1 && data.checks) {
      message += '\n*Checks:*\n';
      for (const check of data.checks) {
        const icon = check.pass ? '✅' : '❌';
        message += `${icon} ${check.rule}${check.pass ? '' : ': ' + check.reason}\n`;
      }
    }

    if (data.failedChecks && data.failedChecks.length > 0) {
      message += '\n⚠️ *Failed checks:*\n';
      for (const check of data.failedChecks) {
        message += `❌ ${check.rule}: ${check.reason}\n`;
      }
    }

    const timeoutSec = Math.round((data.timeout || 120000) / 1000);
    message += `\n⏱ Expires in ${timeoutSec}s`;

    // Inline keyboard
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: `gate:approve:${data.gateId}` },
            { text: '❌ Reject', callback_data: `gate:reject:${data.gateId}` }
          ],
          [
            { text: '📄 Details', callback_data: `gate:details:${data.gateId}` }
          ]
        ]
      },
      parse_mode: 'Markdown'
    };

    try {
      await this.bot.sendMessage(chatId, message, keyboard);
    } catch (err) {
      console.error('Failed to send gate message:', err.message);
    }
  }

  async _renderVerificationFailure(data) {
    const chatId = data.context?.chatId || this.adminChatId;
    if (!chatId) return;

    let message = `⚠️ *VERIFICATION FAILED*\n\n`;
    message += `Skill: \`${data.skill}\`\n\n`;
    message += `*Failed checks:*\n`;
    for (const check of data.failedChecks) {
      message += `❌ ${check.rule}: ${check.reason}\n`;
    }

    try {
      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Failed to send verification failure:', err.message);
    }
  }

  async _renderRejection(data) {
    const chatId = data.context?.chatId || this.adminChatId;
    if (!chatId) return;

    let message = `🚫 *OUTPUT REJECTED*\n\n`;
    message += `Skill: \`${data.skill}\`\n`;
    message += `Status: ${data.gate2Result.status}\n`;
    message += `\nThe output did not pass verification. No changes were committed.`;

    try {
      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Failed to send rejection:', err.message);
    }
  }

  _formatDetails(pending) {
    let msg = `📄 *Gate Details*\n\n`;
    msg += `Gate: ${pending.gate}\n`;
    msg += `Skill: \`${pending.skill}\`\n`;
    msg += `Risk: ${pending.risk}\n`;
    msg += `Expires: ${pending.expires}\n`;

    if (pending.plan) {
      msg += `\n*Plan:*\n\`\`\`\n${JSON.stringify(pending.plan, null, 2).slice(0, 500)}\n\`\`\``;
    }
    if (pending.output) {
      msg += `\n*Output:*\n\`\`\`\n${JSON.stringify(pending.output, null, 2).slice(0, 500)}\n\`\`\``;
    }

    return msg;
  }

  async _editMessage(chatId, messageId, text) {
    try {
      await this.bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [] } // Remove buttons
      });
    } catch (err) {
      // Message might have been deleted
      console.error('Failed to edit gate message:', err.message);
    }
  }
}

// ─── Telegram Commands for Gate Management ───────────────────────────

/**
 * Add these as routes to your WorkflowRouter:
 * 
 * /gates          — Show pending gates
 * /gatestats      — Show gate approval/rejection statistics
 * /approve <id>   — Approve a gate manually
 * /reject <id>    — Reject a gate manually
 */
function getGateRoutes(gates) {
  return [
    {
      name: 'gates-pending',
      patterns: [/^\/gates$/i, /show\s+pending\s+gates/i],
      aliases: ['gates'],
      agent: 'CoordinatorAgent',
      priority: 3, // LOW
      risk: 'none',
      description: 'Show pending verification gates',
      handler: async () => {
        const pending = gates.getPending();
        if (pending.length === 0) return { message: '✅ No pending gates.' };
        return {
          message: `📋 *${pending.length} pending gate(s):*\n\n` +
            pending.map(p =>
              `• \`${p.gateId}\`\n  Skill: ${p.skill} | Gate: ${p.gate} | Expires: ${p.expires}`
            ).join('\n\n')
        };
      }
    },
    {
      name: 'gate-stats',
      patterns: [/^\/gatestats/i, /gate\s+stats/i, /gate\s+statistics/i],
      aliases: ['gatestats'],
      agent: 'CoordinatorAgent',
      priority: 3,
      risk: 'none',
      description: 'Show gate approval/rejection statistics',
      handler: async () => {
        const stats = gates.getStats(7);
        let msg = `📊 *Gate Stats (7 days)*\n\n`;
        msg += `*Gate 1 (Plan):*\n`;
        msg += `  ✅ Approved: ${stats.gate1.approved} | ❌ Rejected: ${stats.gate1.rejected} | ⏰ Expired: ${stats.gate1.expired} | ⚡ Auto: ${stats.gate1.auto}\n\n`;
        msg += `*Gate 2 (Verify):*\n`;
        msg += `  ✅ Approved: ${stats.gate2.approved} | ❌ Rejected: ${stats.gate2.rejected} | ⏰ Expired: ${stats.gate2.expired} | ⚡ Auto: ${stats.gate2.auto}`;

        if (stats.autoApprovalCandidates.length > 0) {
          msg += `\n\n💡 *Auto-approval candidates:*\n`;
          for (const c of stats.autoApprovalCandidates) {
            msg += `  • ${c.suggestion}\n`;
          }
        }

        return { message: msg };
      }
    }
  ];
}

module.exports = { GateTelegramUI, getGateRoutes };
