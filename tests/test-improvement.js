/**
 * X1 Vault — Self-Improvement Loop Tests
 * 
 * Run: node tests/test-improvement.js
 */

const { SelfImprovementLoop, INSIGHT_TYPE, PROPOSAL_STATUS } = require('../src/self-improvement-loop');
const { ErrorLogger } = require('../src/error-logger');
const { WorkflowRouter, PRIORITY, RISK_LEVEL } = require('../src/workflow-router');
const { VerificationGates } = require('../src/verification-gates');
const fs = require('fs');
const path = require('path');

const TEST_DIR = path.join(__dirname, '../test-improvement-data');
const TEST_LOG_DIR = path.join(__dirname, '../errors-test');
const TEST_AUDIT_DIR = path.join(__dirname, '../audit-test');
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) { console.log(`  ✅ ${message}`); passed++; }
  else { console.log(`  ❌ ${message}`); failed++; }
}

function cleanup() {
  for (const dir of [TEST_DIR, TEST_LOG_DIR, TEST_AUDIT_DIR]) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  }
}

async function runTests() {
  cleanup();

  // Set up dependencies
  const logger = new ErrorLogger({ logDir: TEST_LOG_DIR });
  const router = new WorkflowRouter({ logger });
  const gates = new VerificationGates({ logger, auditDir: TEST_AUDIT_DIR, timeout: 1000 });

  // Register a test error listener to prevent unhandled error events
  router.on('error', () => {});

  // Add some routes
  router.addRoute({
    name: 'token-audit',
    patterns: [/^\/audit\s+(\S+)/i],
    agent: 'TokenAuditAgent',
    priority: PRIORITY.HIGH,
    risk: RISK_LEVEL.MEDIUM,
    handler: async (match) => ({ address: match[1], status: 'audited' })
  });

  router.addRoute({
    name: 'deploy',
    patterns: [/^\/deploy/i],
    agent: 'DeployAgent',
    priority: PRIORITY.HIGH,
    risk: RISK_LEVEL.HIGH,
    handler: async () => ({ status: 'deployed', version: '1.0' })
  });

  router.addRoute({
    name: 'unused-route',
    patterns: [/^\/never-triggered/i],
    agent: 'TestAgent',
    priority: PRIORITY.LOW,
    risk: RISK_LEVEL.NONE,
    handler: async () => ({ status: 'ok' })
  });

  router.addRoute({
    name: 'failing-skill',
    patterns: [/^\/fail/i],
    agent: 'TestAgent',
    handler: async () => { throw new Error('Recurring test failure'); }
  });

  const loop = new SelfImprovementLoop({
    logger,
    router,
    gates,
    dataDir: TEST_DIR,
    config: {
      correctionThreshold: 2,  // Lower for testing
      errorThreshold: 2,
      missThreshold: 3
    }
  });

  // ── Correction Recording ────────────────────────────────────
  console.log('\n── Correction Recording ─────────────────────');

  const c1 = loop.recordCorrection('token-audit', 
    { risk: 'low' }, 
    { risk: 'high' }, 
    'Wrong risk score'
  );
  assert(c1.id !== undefined, 'Correction has ID');
  assert(c1.skill === 'token-audit', 'Correction has skill');
  assert(c1.reason === 'Wrong risk score', 'Correction has reason');
  assert(c1.patternHash !== undefined, 'Correction has pattern hash');

  const c2 = loop.recordCorrection('token-audit', 
    { risk: 'low' }, 
    { risk: 'high' }, 
    'Wrong risk score'
  );
  assert(c1.patternHash === c2.patternHash, 'Same correction produces same pattern hash');

  // ── Correction Threshold Triggers Proposal ──────────────────
  console.log('\n── Correction Threshold ─────────────────────');

  // c1 + c2 = 2 corrections with threshold of 2, should trigger proposal
  const proposals = loop.getProposals({ status: PROPOSAL_STATUS.PENDING });
  assert(proposals.length > 0, 'Proposal generated after correction threshold hit');
  assert(proposals[0].skill === 'token-audit', 'Proposal targets correct skill');
  assert(proposals[0].action === 'update_skill_logic', 'Proposal action is update_skill_logic');

  // ── Feedback Recording ──────────────────────────────────────
  console.log('\n── Feedback Recording ───────────────────────');

  loop.recordFeedback('deploy', 'down', 'Deploy took too long');
  // Negative feedback should create a correction
  const report = loop.getReport();
  assert(report.corrections.total >= 3, 'Negative feedback creates correction');

  // ── Generate Error Data ─────────────────────────────────────
  console.log('\n── Generating Test Data ─────────────────────');

  // Generate some errors
  for (let i = 0; i < 4; i++) {
    await router.route('/fail');
  }

  // Generate some successful routes
  for (let i = 0; i < 5; i++) {
    await router.route(`/audit 0x${i}`);
  }

  // Generate unmatched messages
  for (let i = 0; i < 5; i++) {
    await router.route(`price check BTC${i}`);
  }

  // Generate gate decisions
  const gatePromise = gates.planGate('deploy', { description: 'Test deploy' }, { risk: 'high' });
  const pending = gates.getPending();
  if (pending.length > 0) gates.approve(pending[0].gateId);
  await gatePromise;

  console.log('   Test data generated');

  // ── Run Analysis ────────────────────────────────────────────
  console.log('\n── Running Analysis ─────────────────────────');

  const summary = await loop.analyze(1);
  
  assert(summary.insights > 0, `Analysis found ${summary.insights} insights`);
  assert(typeof summary.breakdown === 'object', 'Summary has breakdown');
  assert(summary.duration_ms > 0, 'Analysis duration tracked');

  // ── Insight Types ───────────────────────────────────────────
  console.log('\n── Insight Detection ────────────────────────');

  const allProposals = loop.getProposals();
  
  // Should have error pattern insights (from /fail errors)
  const errorProposals = allProposals.filter(p => p.insightType === INSIGHT_TYPE.ERROR_PATTERN);
  assert(errorProposals.length > 0, 'Error pattern proposals generated');

  // Should have correction pattern insights
  const correctionProposals = allProposals.filter(p => p.insightType === INSIGHT_TYPE.CORRECTION_PATTERN);
  assert(correctionProposals.length > 0, 'Correction pattern proposals generated');

  // Should detect unused routes
  const unusedProposals = allProposals.filter(p => p.insightType === INSIGHT_TYPE.UNUSED_ROUTE);
  assert(unusedProposals.length > 0, 'Unused route detected');

  // ── Proposal Management ─────────────────────────────────────
  console.log('\n── Proposal Management ──────────────────────');

  const pendingProposals = loop.getProposals({ status: PROPOSAL_STATUS.PENDING });
  assert(pendingProposals.length > 0, 'Has pending proposals');

  // Approve one
  const toApprove = pendingProposals[0];
  const approved = loop.approveProposal(toApprove.id);
  assert(approved.status === PROPOSAL_STATUS.APPROVED, 'Proposal approved successfully');
  assert(approved.approvedAt !== undefined, 'Approved timestamp set');

  // Reject one
  if (pendingProposals.length > 1) {
    const toReject = pendingProposals[1];
    const rejected = loop.rejectProposal(toReject.id, 'Not needed');
    assert(rejected.status === PROPOSAL_STATUS.REJECTED, 'Proposal rejected successfully');
    assert(rejected.rejectionReason === 'Not needed', 'Rejection reason stored');
  }

  // Mark as applied
  const applied = loop.markApplied(toApprove.id, 'Fixed in commit abc123');
  assert(applied.status === PROPOSAL_STATUS.APPLIED, 'Proposal marked as applied');
  assert(applied.notes === 'Fixed in commit abc123', 'Application notes stored');

  // ── Filtering ───────────────────────────────────────────────
  console.log('\n── Proposal Filtering ───────────────────────');

  const bySkill = loop.getProposals({ skill: 'token-audit' });
  assert(bySkill.every(p => p.skill === 'token-audit'), 'Skill filter works');

  const bySeverity = loop.getProposals({ severity: 'high' });
  assert(bySeverity.every(p => p.severity === 'high'), 'Severity filter works');

  // ── Report ──────────────────────────────────────────────────
  console.log('\n── Report Generation ────────────────────────');

  const fullReport = loop.getReport();
  assert(fullReport.trend !== undefined, 'Report has trend');
  assert(fullReport.corrections.total > 0, 'Report has correction count');
  assert(fullReport.proposals.applied > 0, 'Report tracks applied proposals');
  assert(fullReport.metricsHistory.length > 0, 'Report has metrics history');

  // ── Event Emission ──────────────────────────────────────────
  console.log('\n── Events ───────────────────────────────────');

  let proposalEvent = null;
  loop.on('new-proposal', (p) => proposalEvent = p);

  // Record enough corrections on a new skill to trigger a proposal
  loop.recordCorrection('vault-sync', 'old', 'new', 'Bad encryption');
  loop.recordCorrection('vault-sync', 'old', 'new', 'Bad encryption');

  assert(proposalEvent !== null, 'new-proposal event emitted');
  assert(proposalEvent.skill === 'vault-sync', 'Event has correct skill');

  let analysisEvent = null;
  loop.on('analysis-complete', (s) => analysisEvent = s);
  await loop.analyze(1);
  assert(analysisEvent !== null, 'analysis-complete event emitted');

  // ── Persistence ─────────────────────────────────────────────
  console.log('\n── Persistence ──────────────────────────────');

  assert(fs.existsSync(path.join(TEST_DIR, 'corrections.json')), 'Corrections file persisted');
  assert(fs.existsSync(path.join(TEST_DIR, 'proposals.json')), 'Proposals file persisted');
  assert(fs.existsSync(path.join(TEST_DIR, 'insights.json')), 'Insights file persisted');
  assert(fs.existsSync(path.join(TEST_DIR, 'metrics-history.json')), 'Metrics file persisted');

  // Reload and verify data survives
  const loop2 = new SelfImprovementLoop({ dataDir: TEST_DIR });
  const reloadedProposals = loop2.getProposals();
  assert(reloadedProposals.length > 0, 'Proposals survive reload');
  
  const reloadedReport = loop2.getReport();
  assert(reloadedReport.corrections.total > 0, 'Corrections survive reload');

  // ── Cleanup ─────────────────────────────────────────────────
  gates.destroy();

  // ── Summary ─────────────────────────────────────────────────
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
