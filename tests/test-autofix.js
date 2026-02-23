/**
 * X1 Vault — Auto-Fix Engine Tests
 * 
 * Run: node tests/test-autofix.js
 */

const { AutoFixEngine, FIX_STATUS } = require('../src/autofix-engine');
const { SelfImprovementLoop, PROPOSAL_STATUS } = require('../src/self-improvement-loop');
const { ErrorLogger } = require('../src/error-logger');
const { WorkflowRouter } = require('../src/workflow-router');
const fs = require('fs');
const path = require('path');

const TEST_DIR = path.join(__dirname, '../test-autofix-data');
const TEST_LOG_DIR = path.join(__dirname, '../test-autofix-errors');
const TEST_SKILLS_DIR = path.join(__dirname, '../test-autofix-skills');
const TEST_IMPROVEMENT_DIR = path.join(__dirname, '../test-autofix-improvement');
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) { console.log(`  ✅ ${message}`); passed++; }
  else { console.log(`  ❌ ${message}`); failed++; }
}

function cleanup() {
  for (const dir of [TEST_DIR, TEST_LOG_DIR, TEST_SKILLS_DIR, TEST_IMPROVEMENT_DIR]) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  }
}

async function runTests() {
  cleanup();

  // Create a fake skill for testing
  const skillDir = path.join(TEST_SKILLS_DIR, 'token-audit');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'index.js'), `
// Token audit skill
const fetch = require('fetch');

async function main() {
  const address = process.argv[2];
  const result = await fetch('https://api.example.com/audit/' + address);
  const data = result.json();
  console.log(data.risk[0]); // BUG: data.risk might be undefined
  return data;
}

main();
  `.trim());

  // Set up dependencies
  const logger = new ErrorLogger({ logDir: TEST_LOG_DIR });
  const router = new WorkflowRouter({ logger });
  router.on('error', () => {}); // Prevent unhandled error

  const loop = new SelfImprovementLoop({
    logger, router,
    dataDir: TEST_IMPROVEMENT_DIR,
    config: { correctionThreshold: 2, errorThreshold: 2 }
  });

  const autofix = new AutoFixEngine({
    logger, loop,
    skillsDir: TEST_SKILLS_DIR,
    dataDir: TEST_DIR,
    llmProvider: null // Use template fixes
  });

  // ── Initialization ──────────────────────────────────────────
  console.log('\n── Initialization ───────────────────────────');

  assert(fs.existsSync(TEST_DIR), 'Data directory created');
  assert(fs.existsSync(path.join(TEST_DIR, 'backups')), 'Backup directory created');

  // ── Generate Errors to Create Proposals ─────────────────────
  console.log('\n── Generating Test Data ─────────────────────');

  // Log some errors to create proposals
  for (let i = 0; i < 3; i++) {
    const err = new Error("Cannot read properties of undefined (reading '0')");
    err.stack = `Error: Cannot read properties of undefined (reading '0')
    at main (${path.join(skillDir, 'index.js')}:6:25)
    at Object.<anonymous> (${path.join(skillDir, 'index.js')}:10:1)`;
    logger.capture(err, {
      skill: 'token-audit',
      agent: 'TokenAuditAgent',
      input: { address: '0xabc123' }
    });
  }

  // Run analysis to generate proposals
  await loop.analyze(1);

  const proposals = loop.getProposals({ status: PROPOSAL_STATUS.PENDING });
  assert(proposals.length > 0, `Proposals generated: ${proposals.length}`);

  // ── Fix Generation (Template Mode) ──────────────────────────
  console.log('\n── Fix Generation (Template) ─────────────────');

  const errorProposal = proposals.find(p => p.insightType === 'error_pattern');
  if (errorProposal) {
    const fix = await autofix.generateFix(errorProposal.id);
    assert(fix.id !== undefined, 'Fix has ID');
    assert(fix.status === FIX_STATUS.READY, 'Fix status is ready');
    assert(fix.sourceFile !== null, 'Source file found');
    assert(fix.originalCode !== null, 'Original code captured');
    assert(fix.fixedCode !== null, 'Fixed code generated');
    assert(fix.diff !== null, 'Diff generated');
    assert(fix.explanation !== null, 'Explanation provided');
    assert(fix.explanation.includes('null check') || fix.explanation.includes('Cannot read'), 'Explanation mentions the fix');
    assert(fix.fixedCode !== fix.originalCode, 'Code was actually modified');
    assert(fix.fixedCode.includes('AUTO-FIX'), 'Fix is marked with AUTO-FIX comment');
  } else {
    console.log('  ⚠️ No error pattern proposal found, skipping fix generation tests');
  }

  // ── Fix Generation (LLM Mock) ──────────────────────────────
  console.log('\n── Fix Generation (LLM Mock) ─────────────────');

  // Create a new engine with a mock LLM
  const mockLLM = async (prompt) => {
    return `EXPLANATION: Fixed the undefined property access by adding a null check before accessing the risk array.

\`\`\`javascript
// Token audit skill - FIXED
const fetch = require('fetch');

async function main() {
  const address = process.argv[2];
  const result = await fetch('https://api.example.com/audit/' + address);
  const data = result.json();
  // [AI-FIX] Added null check
  if (data.risk && data.risk.length > 0) {
    console.log(data.risk[0]);
  } else {
    console.warn('No risk data available');
  }
  return data;
}

main();
\`\`\``;
  };

  const autofixLLM = new AutoFixEngine({
    logger, loop,
    skillsDir: TEST_SKILLS_DIR,
    dataDir: TEST_DIR,
    llmProvider: mockLLM
  });

  // Need a fresh proposal
  loop.recordCorrection('token-audit', { risk: 'low' }, { risk: 'high' }, 'Wrong risk');
  loop.recordCorrection('token-audit', { risk: 'low' }, { risk: 'high' }, 'Wrong risk');
  await loop.analyze(1);

  const correctionProposal = loop.getProposals({ status: PROPOSAL_STATUS.PENDING })
    .find(p => p.action === 'update_skill_logic' || p.action === 'add_error_handling');

  if (correctionProposal) {
    const llmFix = await autofixLLM.generateFix(correctionProposal.id);
    assert(llmFix.status === FIX_STATUS.READY, 'LLM fix generated');
    assert(llmFix.explanation.includes('null check'), 'LLM explanation parsed');
    assert(llmFix.fixedCode.includes('AI-FIX'), 'LLM code parsed');
  }

  // ── Approve / Reject ────────────────────────────────────────
  console.log('\n── Approve / Reject ─────────────────────────');

  const readyFixes = autofix.getFixes({ status: FIX_STATUS.READY });
  if (readyFixes.length > 0) {
    // Reject one
    const rejected = autofix.rejectFix(readyFixes[0].id, 'Not needed');
    assert(rejected.status === FIX_STATUS.REJECTED, 'Fix rejected');
    assert(rejected.rejectionReason === 'Not needed', 'Rejection reason stored');
  }

  if (readyFixes.length > 1) {
    // Approve one
    const approved = autofix.approveFix(readyFixes[1].id);
    assert(approved.status === FIX_STATUS.APPROVED, 'Fix approved');
    assert(approved.approvedAt !== undefined, 'Approval timestamp set');
  }

  // ── Apply Fix ───────────────────────────────────────────────
  console.log('\n── Apply Fix ────────────────────────────────');

  // Create a fresh fixable scenario
  const freshAutofix = new AutoFixEngine({
    logger, loop,
    skillsDir: TEST_SKILLS_DIR,
    dataDir: path.join(TEST_DIR, 'fresh'),
    llmProvider: null
  });

  // Generate and approve
  const freshProposal = loop.getProposals({ status: PROPOSAL_STATUS.PENDING })[0];
  if (freshProposal) {
    const fix = await freshAutofix.generateFix(freshProposal.id);
    freshAutofix.approveFix(fix.id);

    const result = await freshAutofix.applyFix(fix.id);
    assert(result.fix.backupPath !== null, 'Backup created before apply');
    assert(fs.existsSync(result.fix.backupPath), 'Backup file exists');

    if (result.success) {
      assert(result.fix.status === FIX_STATUS.DEPLOYED, 'Fix deployed');
      assert(result.fix.deployedAt !== undefined, 'Deploy timestamp set');
      // Verify the file was actually modified
      const currentCode = fs.readFileSync(fix.sourceFile, 'utf-8');
      assert(currentCode.includes('AUTO-FIX'), 'File was actually patched');
    } else {
      // Fix might fail tests — that's OK, it means safety works
      assert(
        result.fix.status === FIX_STATUS.ROLLED_BACK || result.fix.status === FIX_STATUS.FAILED,
        'Failed fix was rolled back or marked failed'
      );
    }
  }

  // ── Report ──────────────────────────────────────────────────
  console.log('\n── Report ───────────────────────────────────');

  const report = autofix.getReport();
  assert(report.total > 0, 'Report has total fixes');
  assert(typeof report.byStatus === 'object', 'Report has status breakdown');
  assert(report.recentFixes.length > 0, 'Report has recent fixes');

  // ── Events ──────────────────────────────────────────────────
  console.log('\n── Events ───────────────────────────────────');

  let readyEvent = null;
  const eventAutofix = new AutoFixEngine({
    logger, loop,
    skillsDir: TEST_SKILLS_DIR,
    dataDir: path.join(TEST_DIR, 'events'),
    llmProvider: null
  });
  eventAutofix.on('fix-ready', (f) => readyEvent = f);
  eventAutofix.on('fix-generating', () => {});

  const eventProposal = loop.getProposals({ status: PROPOSAL_STATUS.PENDING })[0];
  if (eventProposal) {
    await eventAutofix.generateFix(eventProposal.id);
    assert(readyEvent !== null, 'fix-ready event emitted');
    assert(readyEvent.skill !== undefined, 'Event has skill');
  }

  // ── Persistence ─────────────────────────────────────────────
  console.log('\n── Persistence ──────────────────────────────');

  assert(fs.existsSync(path.join(TEST_DIR, 'fixes.json')), 'Fixes file persisted');
  const reloaded = new AutoFixEngine({ dataDir: TEST_DIR });
  const reloadedFixes = reloaded.getFixes();
  assert(reloadedFixes.length > 0, 'Fixes survive reload');

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
