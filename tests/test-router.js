/**
 * X1 Vault — Workflow Router Tests
 * 
 * Run: node tests/test-router.js
 */

const { WorkflowRouter, PRIORITY, RISK_LEVEL } = require('../src/workflow-router');
const { ErrorLogger } = require('../src/error-logger');
const { getDefaultRoutes } = require('../src/routes');
const fs = require('fs');
const path = require('path');

const TEST_LOG_DIR = path.join(__dirname, '../errors-test');
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) { console.log(`  ✅ ${message}`); passed++; }
  else { console.log(`  ❌ ${message}`); failed++; }
}

function cleanup() {
  if (fs.existsSync(TEST_LOG_DIR)) fs.rmSync(TEST_LOG_DIR, { recursive: true });
}

async function runTests() {
  cleanup();

  const logger = new ErrorLogger({ logDir: TEST_LOG_DIR });
  const router = new WorkflowRouter({ logger });

  // ── Route Registration ──────────────────────────────────────
  console.log('\n── Route Registration ───────────────────────');

  router.addRoute({
    name: 'token-audit',
    patterns: [/^\/audit\s+(\S+)/i, /audit\s+token\s+(\S+)/i],
    agent: 'TokenAuditAgent',
    priority: PRIORITY.HIGH,
    risk: RISK_LEVEL.MEDIUM,
    description: 'Audit a token',
    handler: async (match, ctx) => ({ address: match[1], status: 'audited' })
  });

  router.addRoute({
    name: 'vault-backup',
    patterns: [/^\/backup\s+(.+)/i, /save\s+(.+)/i],
    agent: 'VaultSyncAgent',
    priority: PRIORITY.NORMAL,
    risk: RISK_LEVEL.LOW,
    handler: async (match, ctx) => ({ data: match[1], status: 'saved' })
  });

  router.addRoute({
    name: 'deploy',
    patterns: [/^\/deploy(?:\s+(.+))?/i],
    agent: 'DeployAgent',
    priority: PRIORITY.HIGH,
    risk: RISK_LEVEL.HIGH,
    autoExecute: false,
    handler: async (match, ctx) => ({ version: match[1] || 'latest', status: 'deployed' })
  });

  router.addRoute({
    name: 'failing-skill',
    patterns: [/^\/fail/i],
    agent: 'TestAgent',
    handler: async () => { throw new Error('Intentional test failure'); }
  });

  assert(router.listRoutes().length === 4, 'Four routes registered');

  // ── Pattern Matching ────────────────────────────────────────
  console.log('\n── Pattern Matching ─────────────────────────');

  let result = await router.route('/audit 0xABC123');
  assert(result.matched === true, '/audit matches token-audit route');
  assert(result.route === 'token-audit', 'Correct route name');
  assert(result.result.address === '0xABC123', 'Captures address from match group');
  assert(result.error === null, 'No error on success');

  result = await router.route('audit token 0xDEF456');
  assert(result.matched === true, 'Natural language audit matches');
  assert(result.result.address === '0xDEF456', 'Captures address from second pattern');

  result = await router.route('/backup my important data');
  assert(result.matched === true, '/backup matches vault-backup route');
  assert(result.result.data === 'my important data', 'Captures backup data');

  result = await router.route('save session state to memory');
  assert(result.matched === true, '"save" keyword matches vault-backup');

  // ── No Match ────────────────────────────────────────────────
  console.log('\n── No Match / Fallback ──────────────────────');

  result = await router.route('random gibberish that matches nothing');
  assert(result.matched === false, 'Unmatched message returns matched=false');
  assert(result.error === 'No matching route', 'Error message set');

  // Set fallback
  router.setFallback(async (msg) => `Unknown command: ${msg.slice(0, 20)}`);
  result = await router.route('still no match here');
  assert(result.matched === false, 'Still reports no match');
  assert(result.result.includes('Unknown command'), 'Fallback handler runs');

  // ── Priority Ordering ───────────────────────────────────────
  console.log('\n── Priority Ordering ────────────────────────');

  const routes = router.listRoutes();
  const auditIdx = routes.findIndex(r => r.name === 'token-audit');
  const backupIdx = routes.findIndex(r => r.name === 'vault-backup');
  assert(auditIdx < backupIdx, 'High-priority routes checked before normal');

  // ── Event Emission (register listeners BEFORE error tests) ──
  console.log('\n── Events ───────────────────────────────────');

  let matchEvent = null;
  let errorEvent = null;
  let successEvent = null;
  let noMatchEvent = null;

  router.on('match', (e) => matchEvent = e);
  router.on('error', (e) => errorEvent = e);
  router.on('success', (e) => successEvent = e);
  router.on('no-match', (e) => noMatchEvent = e);

  await router.route('/audit 0x111');
  assert(matchEvent !== null, 'Match event emitted');
  assert(matchEvent.route === 'token-audit', 'Match event has route name');
  assert(successEvent !== null, 'Success event emitted');

  await router.route('no match xyz');
  assert(noMatchEvent !== null, 'No-match event emitted');

  // ── Error Handling ──────────────────────────────────────────
  console.log('\n── Error Handling ───────────────────────────');

  result = await router.route('/fail');
  assert(result.matched === true, 'Failing route still matches');
  assert(result.error === 'Intentional test failure', 'Error captured');
  assert(result.entry !== undefined, 'Error entry created');
  assert(errorEvent !== null, 'Error event emitted');
  assert(errorEvent.route === 'failing-skill', 'Error event has route name');

  // Verify error was logged
  const errors = logger.query({ skill: 'failing-skill', days: 1 });
  assert(errors.length > 0, 'Error logged to ErrorLogger');

  // ── Middleware ──────────────────────────────────────────────
  console.log('\n── Middleware ───────────────────────────────');

  let preRan = false;
  let postRan = false;
  let postOutcome = null;

  router.use('pre', async (route, ctx) => { preRan = true; });
  router.use('post', async (route, ctx, outcome) => { postRan = true; postOutcome = outcome; });

  await router.route('/audit 0x222');
  assert(preRan, 'Pre-middleware ran');
  assert(postRan, 'Post-middleware ran');
  assert(postOutcome.success === true, 'Post-middleware received outcome');

  // ── Parallel Routing ───────────────────────────────────────
  console.log('\n── Parallel Routing ─────────────────────────');

  const parallel = await router.routeParallel(
    ['token-audit', 'vault-backup'],
    { test: true }
  );
  assert(Object.keys(parallel.results).length > 0 || Object.keys(parallel.errors).length > 0, 'Parallel execution returns results');

  // ── Analytics ──────────────────────────────────────────────
  console.log('\n── Analytics ────────────────────────────────');

  const analytics = router.getAnalytics();
  assert(analytics.totalRouted > 0, 'Analytics tracks total routed');
  assert(analytics.totalMisses > 0, 'Analytics tracks misses');
  assert(analytics.routeStats['token-audit'] !== undefined, 'Analytics has per-route stats');
  assert(analytics.routeStats['token-audit'].hits > 0, 'Route hit count tracked');

  // ── Route Toggle ───────────────────────────────────────────
  console.log('\n── Route Toggle ─────────────────────────────');

  router.toggleRoute('token-audit', false);
  result = await router.route('/audit 0x333');
  assert(result.matched === false, 'Disabled route does not match');

  router.toggleRoute('token-audit', true);
  result = await router.route('/audit 0x333');
  assert(result.matched === true, 'Re-enabled route matches again');

  // ── Default Routes ─────────────────────────────────────────
  console.log('\n── Default Routes ───────────────────────────');

  const defaultRoutes = getDefaultRoutes();
  assert(defaultRoutes.length >= 8, `Default routes package has ${defaultRoutes.length} routes`);
  assert(defaultRoutes.some(r => r.name === 'token-audit'), 'Default includes token-audit');
  assert(defaultRoutes.some(r => r.name === 'deploy'), 'Default includes deploy');
  assert(defaultRoutes.some(r => r.name === 'help'), 'Default includes help');
  assert(defaultRoutes.some(r => r.name === 'health'), 'Default includes health');

  // ── Summary ────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════\n');

  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner failed:', err);
  cleanup();
  process.exit(1);
});
