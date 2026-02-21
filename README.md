# X1 Vault — Multi-Agent Operating System

A self-improving AI agent framework for Telegram bots. Four layers that work together: the bot catches its own mistakes, routes tasks to the right skill, checks before doing anything risky, and learns from its failures.

**152 tests. Zero dependencies beyond `node-telegram-bot-api` and `node-cron`.**

## Architecture

```
User sends message to Telegram bot
    ↓
┌─────────────────────────────────────────────────────────┐
│  WORKFLOW ROUTER                                        │
│  Pattern match → find the right skill → execute         │
│  Priority ordering, parallel execution, analytics       │
├─────────────────────────────────────────────────────────┤
│  VERIFICATION GATES                                     │
│  Gate 1 (Plan): "Here's what I'm about to do. OK?"     │
│  Gate 2 (Verify): "Here's the result. Looks right?"    │
│  Risk-weighted: low=skip, medium=auto-verify, high=ask │
├─────────────────────────────────────────────────────────┤
│  ERROR LOGGING                                          │
│  Every execution wrapped → classify, hash, track       │
│  Recurring errors flagged for auto-fix                  │
├─────────────────────────────────────────────────────────┤
│  SELF-IMPROVEMENT LOOP                                  │
│  Analyze errors + corrections + gate decisions          │
│  Generate proposals → you approve → bot improves        │
└─────────────────────────────────────────────────────────┘
    ↓
Data persists locally + backs up to X1 Vault
```

## Quick Start

### 1. Install

```bash
cd your-bot-project
npm install node-telegram-bot-api node-cron
```

### 2. Set up your Telegram bot

1. Message **@BotFather** on Telegram → `/newbot` → copy the token
2. Message **@userinfobot** → copy your chat ID

### 3. Run

```bash
BOT_TOKEN=your_token ADMIN_CHAT_ID=your_chat_id node src/bot.js
```

### 4. Test

```
/help              — see all commands
/audit 0xABC       — test token audit
/health            — system health score
/errors            — recent errors
/proposals         — improvement proposals
/trend             — improvement trend over time
/gates             — pending verification gates
/gatestats         — gate approval/rejection stats
```

## The Four Layers

### Layer 1: Error Logging

Every skill execution is wrapped. Errors are auto-classified (syntax, api, network, logic, timeout, permission, validation, dependency), stack traces are hashed for deduplication, severity is inferred from skill + error type, and occurrence counts trigger auto-fix reviews.

```js
const { ErrorLogger } = require('./src/error-logger');
const logger = new ErrorLogger({ logDir: './errors' });

// Wrap any skill
const { success, result, error } = await logger.wrapSkill(
  'token-audit',
  () => auditToken(address),
  { address },
  { agent: 'TokenAuditAgent' }
);
```

Daily logs written to `errors/YYYY-MM-DD.json`. Run `npm run audit` for a health report.

### Layer 2: Workflow Router

Single entry point for all incoming messages. Pattern-matches to the right skill, executes with error logging, tracks analytics.

```js
const { WorkflowRouter } = require('./src/workflow-router');
const router = new WorkflowRouter({ logger });

router.addRoute({
  name: 'token-audit',
  patterns: [/^\/audit\s+(\S+)/i, /check\s+contract\s+(\S+)/i],
  agent: 'TokenAuditAgent',
  priority: PRIORITY.HIGH,
  risk: RISK_LEVEL.MEDIUM,
  handler: async (match, ctx) => auditToken(match[1])
});

// Route any message
const result = await router.route('/audit 0xABC123');
```

Pre-built routes in `src/routes.js`: token-audit, vault-backup, deploy, research, code-review, health, errors, help, analytics.

### Layer 3: Verification Gates

Two-gate system that prevents dangerous actions without your approval.

```
Risk Level    Gate 1 (Plan)    Gate 2 (Verify)    Cooldown    Audit Trail
─────────────────────────────────────────────────────────────────────────
none          skip             skip               no          no
low           skip             skip               no          no
medium        skip             auto-check          no          no
high          ask user         ask user            no          yes
critical      ask user         ask user            30s         yes
```

After you approve the same action 3 times, it auto-approves. Renders as Telegram inline keyboard buttons (Approve / Reject / Details).

### Layer 4: Self-Improvement Loop

Analyzes everything to make the bot better over time:

- **Error patterns** → "This API call fails every day at 3am — add retry logic"
- **User corrections** → "You keep fixing the risk score — update the scoring logic"
- **Gate decisions** → "You always approve deploys — lower the risk level"
- **Unmatched messages** → "People keep asking for 'price check' — add a route"
- **Unused routes** → "Nobody uses /review — remove it or fix the patterns"

Generates proposals you approve/reject via Telegram:

```
/proposals                    — view pending proposals
/propose approve abc123       — approve a proposal
/propose reject abc123        — reject a proposal
/correct token-audit reason   — record a manual correction
/improve                      — run analysis now
/trend                        — show improvement over time
```

## Project Structure

```
your-bot-project/
├── src/
│   ├── error-logger.js            — Core error capture, classify, hash, query
│   ├── self-audit.js              — Scheduled error analysis + health reports
│   ├── workflow-router.js         — Pattern matching router + analytics
│   ├── routes.js                  — Pre-built route definitions (edit these)
│   ├── bot.js                     — Telegram bot wiring (main entry point)
│   ├── verification-gates.js      — Two-gate plan/verify system
│   ├── gate-telegram-ui.js        — Telegram UI for gate approvals
│   ├── self-improvement-loop.js   — Pattern analysis + proposal generation
│   ├── improvement-telegram-ui.js — Telegram UI for proposals/corrections
│   └── integration-examples.js    — Drop-in examples for your skills
├── tests/
│   ├── test-logger.js             — 40 tests
│   ├── test-router.js             — 40 tests
│   ├── test-gates.js              — 35 tests
│   └── test-improvement.js        — 37 tests
├── errors/                        — Daily error logs (gitignored)
├── audit-trail/                   — Gate decision logs (gitignored)
├── improvement-data/              — Corrections, proposals, metrics (gitignored)
├── reports/                       — Self-audit reports (gitignored)
├── package.json
├── .gitignore
└── README.md
```

## Runtime Data

Code lives on GitHub. Runtime data lives locally and backs up to X1 Vault:

| Directory | Contents | Persisted |
|-----------|----------|-----------|
| `errors/` | Daily error logs (JSONL) | Local + Vault backup |
| `audit-trail/` | Gate approval/rejection decisions | Local + Vault backup |
| `improvement-data/` | Corrections, proposals, metrics | Local + Vault backup |
| `reports/` | Self-audit health reports | Local |

## NPM Scripts

```bash
npm test              # Run error logger tests
npm run audit         # Run self-audit (7-day lookback)
npm run audit:30d     # 30-day lookback
npm run audit:report  # Save audit report to file
```

## Customization

### Adding a new skill

1. Add a route in `src/routes.js`:

```js
{
  name: 'my-new-skill',
  patterns: [/^\/mycommand\s+(.+)/i],
  agent: 'MyAgent',
  risk: RISK_LEVEL.MEDIUM,
  handler: async (match, ctx) => {
    // Your logic here
    return { result: match[1] };
  }
}
```

2. The router, error logger, gates, and improvement loop all pick it up automatically.

### Adding a custom verification rule

```js
gates.addRule('deploy', {
  name: 'tests-must-pass',
  description: 'Deploy output must confirm tests passed',
  check: (output) => ({
    pass: output.testsPassed === true,
    reason: 'Tests did not pass before deploy'
  })
});
```

### Recording a correction

When the bot gets something wrong, tell it:

```
/correct token-audit Wrong risk score for low-liquidity tokens
```

After enough corrections on the same pattern, the improvement loop generates a proposal to fix it.

## Core Principles

| Principle | How It's Implemented |
|-----------|---------------------|
| Wallet-first identity | Every agent action is traceable to a skill + agent |
| Memory is explicit | Nothing persists unless logged to errors/ or improvement-data/ |
| Verify before trust | Gates check all outputs against rules before completing |
| Fail visible | Every error captured with full context, never swallowed |
| User owns the loop | Auto for low-risk, confirm for high-risk |
| Skills are composable | Each route exposes clear patterns, risk, and handler |
| System improves itself | Corrections + errors + analytics → proposals → better bot |

## License

MIT