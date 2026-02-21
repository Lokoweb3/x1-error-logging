# X1 Vault — Structured Error Logging System

Foundation layer for the X1 multi-agent self-improvement pipeline.

## Architecture

```
Error occurs in any skill/agent
    ↓
ErrorLogger.capture() or wrapSkill()
    ↓
├── Classify error type (syntax, api, network, logic, etc.)
├── Hash stack trace (fingerprint for dedup & fix matching)
├── Infer severity (low → critical, based on skill + error type)
├── Track occurrence count (triggers auto-fix at threshold)
├── Write to daily JSON log (errors/YYYY-MM-DD.json)
    ↓
Self-Audit Job (daily/weekly)
    ↓
├── Scan logs for recurring patterns
├── Match against known fixes
├── Calculate system health score
├── Propose fixes for approval
└── Generate report
```

## Quick Start

### 1. Wrap your skills

```js
const { ErrorLogger } = require('./src/error-logger');
const logger = new ErrorLogger({ logDir: './errors' });

// Wrap any async function
const { success, result, error } = await logger.wrapSkill(
  'token-audit',
  () => auditToken(address),
  { address },
  { agent: 'TokenAuditAgent' }
);
```

### 2. Run the self-audit

```bash
npm run audit           # 7-day lookback
npm run audit:30d       # 30-day lookback  
npm run audit:report    # Save to reports/
```

### 3. Add Telegram commands

```
/errors          — Recent errors
/errors <skill>  — Errors by skill
/health          — System health score
/fix <hash>      — Mark error as fixed
```

## Files

| File | Purpose |
|------|---------|
| `src/error-logger.js` | Core logger — capture, classify, hash, query, report |
| `src/self-audit.js` | Scheduled audit job — pattern detection, fix proposals |
| `src/integration-examples.js` | Drop-in examples for your agents/skills |
| `tests/test-logger.js` | Full test suite (40 tests) |

## What Gets Logged

Each error entry in `errors/YYYY-MM-DD.json`:

```json
{
  "type": "error",
  "timestamp": "2026-02-21T19:34:28.601Z",
  "hash": "bceedd8d7588",
  "error_type": "api",
  "severity": "high",
  "skill": "token-audit",
  "agent": "TokenAuditAgent",
  "message": "Rate limit exceeded 429",
  "input_summary": "{\"contractAddress\":\"0xabc123\"}",
  "occurrence_count": 2,
  "metadata": {}
}
```

Successes are logged too (for calculating error rates).

## How This Feeds the Pipeline

1. **Error Logging** ← you are here
2. **Workflow Router** — uses error data to learn which skills fail most
3. **Verification Gates** — uses severity/skill data to calibrate risk levels
4. **Self-Improvement Loop** — uses recurring errors + fix history to auto-improve

## Next Step

→ Build the **workflow router** using the error patterns this system captures.
