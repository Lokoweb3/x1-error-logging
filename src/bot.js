/**
 * X1 Vault — Telegram Bot Integration
 * 
 * Complete example of wiring the WorkflowRouter into a Telegram bot.
 * Copy this as your starting point and replace the stubs.
 * 
 * Install: npm install node-telegram-bot-api
 * Run: BOT_TOKEN=your_token ADMIN_CHAT_ID=your_chat_id node src/bot.js
 */

const TelegramBot = require('node-telegram-bot-api');
const { WorkflowRouter, PRIORITY, RISK_LEVEL } = require('./workflow-router');
const { ErrorLogger } = require('./error-logger');
const { getDefaultRoutes } = require('./routes');

// ─── Configuration ───────────────────────────────────────────────────

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

if (!BOT_TOKEN) {
  console.error('❌ Set BOT_TOKEN environment variable');
  process.exit(1);
}

// ─── Initialize Components ───────────────────────────────────────────

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const logger = new ErrorLogger({
  logDir: './errors',
  maxRetries: 2,

  // Alert on critical errors
  onCritical: (entry) => {
    if (ADMIN_CHAT_ID) {
      bot.sendMessage(ADMIN_CHAT_ID, 
        `🚨 *CRITICAL ERROR*\nSkill: \`${entry.skill}\`\nError: ${entry.message}\nHash: \`${entry.hash}\``,
        { parse_mode: 'Markdown' }
      );
    }
  },

  // Alert when error repeats past threshold
  onThresholdHit: (entry) => {
    if (ADMIN_CHAT_ID) {
      bot.sendMessage(ADMIN_CHAT_ID,
        `🔁 *Recurring Error* (${entry.occurrence_count}x)\nSkill: \`${entry.skill}\`\nHash: \`${entry.hash}\`\nMessage: ${entry.message}`,
        { parse_mode: 'Markdown' }
      );
    }
  }
});

const router = new WorkflowRouter({ logger });

// ─── Register Routes ─────────────────────────────────────────────────

// Load default routes (token-audit, vault-backup, deploy, etc.)
router.addRoutes(getDefaultRoutes({
  // Pass your real dependencies here:
  // vault: vaultClient,
  // tokenApi: tokenApiClient,
  // git: gitHelper,
  // bot: bot
}));

// Set fallback for unmatched messages
router.setFallback(async (message, ctx) => {
  return `I didn't understand: "${message.slice(0, 50)}"\nType /help to see available commands.`;
});

// ─── Middleware ───────────────────────────────────────────────────────

// Log every routed command
router.use('pre', async (route, ctx) => {
  console.log(`[ROUTE] ${route.name} ← "${ctx.message.slice(0, 50)}"`);
});

// Track execution time
router.use('post', async (route, ctx, outcome) => {
  const status = outcome.success ? '✅' : '❌';
  console.log(`[DONE] ${status} ${route.name} (${outcome.duration}ms)`);
});

// ─── Confirmation System (for high-risk routes) ─────────────────────

const pendingConfirmations = new Map(); // chatId → { route, match, ctx, expires }

/**
 * Handle confirmation flow for high-risk actions.
 * Returns true if the message was a confirmation response.
 */
function handleConfirmation(chatId, text) {
  const pending = pendingConfirmations.get(chatId);
  if (!pending) return false;

  const normalized = text.toLowerCase().trim();

  if (normalized === 'yes' || normalized === 'y' || normalized === 'confirm') {
    pendingConfirmations.delete(chatId);
    return { confirmed: true, pending };
  }

  if (normalized === 'no' || normalized === 'n' || normalized === 'cancel') {
    pendingConfirmations.delete(chatId);
    return { confirmed: false, pending };
  }

  return false; // Not a confirmation response
}

// Clean up expired confirmations every minute
setInterval(() => {
  const now = Date.now();
  for (const [chatId, pending] of pendingConfirmations) {
    if (now > pending.expires) {
      pendingConfirmations.delete(chatId);
      bot.sendMessage(chatId, `⏰ Confirmation for \`${pending.route}\` expired.`, { parse_mode: 'Markdown' });
    }
  }
}, 60000);

// ─── Message Handler ─────────────────────────────────────────────────

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;

  try {
    // Check if this is a confirmation response
    const confirmResult = handleConfirmation(chatId, text);
    if (confirmResult) {
      if (confirmResult.confirmed) {
        bot.sendMessage(chatId, '⚡ Executing...');
        const result = await router.route(confirmResult.pending.originalMessage, {
          chatId,
          userId: msg.from?.id,
          confirmed: true,
          logger,
          router
        });
        await sendResult(chatId, result);
      } else {
        bot.sendMessage(chatId, '❌ Cancelled.');
      }
      return;
    }

    // Route the message
    const result = await router.route(text, {
      chatId,
      userId: msg.from?.id,
      logger,
      router
    });

    // If matched a high-risk route that needs confirmation
    if (result.matched && result.route) {
      const routeDef = router.routes.find(r => r.name === result.route);
      if (routeDef && !routeDef.autoExecute && !result.error) {
        // Ask for confirmation instead of executing
        pendingConfirmations.set(chatId, {
          route: result.route,
          originalMessage: text,
          expires: Date.now() + 60000 // 1 minute to confirm
        });
        bot.sendMessage(chatId,
          `⚠️ *${result.route}* is a high-risk action (${routeDef.risk})\n\nConfirm? Reply *yes* or *no*`,
          { parse_mode: 'Markdown' }
        );
        return;
      }
    }

    await sendResult(chatId, result);

  } catch (error) {
    logger.capture(error, {
      skill: 'telegram-handler',
      agent: 'CoordinatorAgent',
      input: { chatId, text }
    });
    bot.sendMessage(chatId, `❌ Internal error: ${error.message}`);
  }
});

// ─── Response Formatting ─────────────────────────────────────────────

async function sendResult(chatId, result) {
  if (!result.matched) {
    bot.sendMessage(chatId, result.result || '🤷 No matching command. Try /help');
    return;
  }

  if (result.error) {
    bot.sendMessage(chatId, `❌ *${result.route}* failed:\n${result.error}`, { parse_mode: 'Markdown' });
    return;
  }

  // Format the result based on type
  const data = result.result;

  if (typeof data === 'string') {
    bot.sendMessage(chatId, data);
  } else if (Array.isArray(data)) {
    const formatted = data.map(item => {
      if (typeof item === 'string') return item;
      if (item.message) return `• ${item.message}`;
      if (item.skill) return `• [${item.error_type}] ${item.skill}: ${(item.message || '').slice(0, 60)}`;
      return `• ${JSON.stringify(item).slice(0, 80)}`;
    }).join('\n');
    bot.sendMessage(chatId, formatted || 'No results.');
  } else if (data && typeof data === 'object') {
    if (data.message) {
      bot.sendMessage(chatId, data.message);
    } else {
      // Pretty-print object results
      const formatted = Object.entries(data)
        .map(([k, v]) => `*${k}:* ${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join('\n');
      bot.sendMessage(chatId, formatted, { parse_mode: 'Markdown' });
    }
  }
}

// ─── Startup ─────────────────────────────────────────────────────────

console.log('🤖 X1 Bot starting...');
console.log(`📋 Routes loaded: ${router.listRoutes().length}`);
console.log(`📊 Error logging to: ./errors/`);
console.log('✅ Ready.\n');

if (ADMIN_CHAT_ID) {
  bot.sendMessage(ADMIN_CHAT_ID, '🤖 X1 Bot online. Type /help for commands.');
}

module.exports = { bot, router, logger };
