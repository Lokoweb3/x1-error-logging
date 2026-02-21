/**
 * X1 Vault — Verification Gate Tests
 * 
 * Run: node tests/test-gates.js
 */

const { VerificationGates, GATE_STATUS, GATE_POLICY } = require('../src/verification-gates');
const { ErrorLogger } = require('../src/error-logger');
const fs = require('fs');
const path = require('path');

const TEST_LOG_DIR = path.join(__dirname, '../errors-test');
const TEST_AUDIT_DIR = path.join(__dirname, '../audit-test');
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) { console.log(`  ✅ ${message}`); passed++; }
  else { console.log(`  ❌ ${message}`); failed++; }
}

function cleanup() {
  if (fs.existsSync(TEST_LOG_DIR)) fs.rmSync(TEST_LOG_DIR, { recursive: true });
  if (fs.existsSync(TEST_AUDIT_DIR)) fs.rmSync(TEST_AUDIT_DIR, { recursive: true });
}

async function runTests() {
  cleanup();

  const logger = new ErrorLogger({ logDir: TEST_LOG_DIR });

  // ── Gate Policy ─────────────────────────────────────────────
  console.log('\n── Gate Policy ──────────────────────────────');

  assert(GATE_POLICY.none.gate1 === false, 'No risk: no gates');
  assert(GATE_POLICY.low.gate1 === false, 'Low risk: no gates');
  assert(GATE_POLICY.medium.gate2 === true, 'Medium risk: gate2 only');
  assert(GATE_POLICY.high.gate1 === true && GATE_POLICY.high.gate2 === true, 'High risk: both gates');
  assert(GATE_POLICY.critical.cooldown === 30, 'Critical risk: has cooldown');
  assert(GATE_POLICY.critical.auditTrail === true, 'Critical risk: audit trail enabled');

  // ── Gate Skipping (Low Risk) ────────────────────────────────
  console.log('\n── Gate Skipping (Low Risk) ──────────────────');

  const gates = new VerificationGates({ logger, auditDir: TEST_AUDIT_DIR, timeout: 5000 });

  const skipResult1 = await gates.planGate('vault-backup', {
    description: 'Backup memory to vault'
  }, { risk: 'none' });
  assert(skipResult1.status === GATE_STATUS.SKIPPED, 'Gate 1 skipped for none risk');

  const skipResult2 = await gates.planGate('vault-backup', {
    description: 'Backup memory'
  }, { risk: 'low' });
  assert(skipResult2.status === GATE_STATUS.SKIPPED, 'Gate 1 skipped for low risk');

  const skipResult3 = await gates.verifyGate('research', { data: 'result' }, { risk: 'none' });
  assert(skipResult3.status === GATE_STATUS.SKIPPED, 'Gate 2 skipped for none risk');

  const skipResult4 = await gates.verifyGate('research', { data: 'result' }, { risk: 'low' });
  assert(skipResult4.status === GATE_STATUS.SKIPPED, 'Gate 2 skipped for low risk');

  // ── Gate 2 Auto-Pass (Medium Risk) ──────────────────────────
  console.log('\n── Gate 2 Auto-Pass (Medium Risk) ───────────');

  const autoResult = await gates.verifyGate('token-audit', {
    address: '0xabc',
    status: 'audited',
    score: 85
  }, { risk: 'medium', originalInput: { address: '0xabc' } });

  assert(autoResult.status === GATE_STATUS.AUTO, 'Gate 2 auto-passes when all checks pass for medium risk');
  assert(autoResult.checks.length > 0, 'Checks were run');
  assert(autoResult.checks.every(c => c.pass), 'All checks passed');

  // ── Gate 2 Rejection (Failed Checks, Medium Risk) ──────────
  console.log('\n── Gate 2 Rejection (Failed Checks) ─────────');

  const rejectResult = await gates.verifyGate('token-audit', null, { risk: 'medium' });
  assert(rejectResult.status === GATE_STATUS.REJECTED, 'Null output rejected by verification');
  assert(rejectResult.checks.some(c => !c.pass), 'Failed checks recorded');

  const errorOutput = await gates.verifyGate('deploy', {
    error: true,
    status: 'failed',
    message: 'Build broke'
  }, { risk: 'medium' });
  assert(errorOutput.status === GATE_STATUS.REJECTED, 'Error-flagged output rejected');

  // ── Custom Rules ────────────────────────────────────────────
  console.log('\n── Custom Rules ─────────────────────────────');

  gates.addRule('deploy', {
    name: 'version-present',
    description: 'Deploy output must include a version number',
    check: (output) => ({
      pass: output && typeof output.version === 'string' && output.version.length > 0,
      reason: 'Missing version in deploy output'
    })
  });

  const noVersionResult = await gates.verifyGate('deploy', {
    status: 'deployed'
    // Missing version!
  }, { risk: 'medium' });
  assert(noVersionResult.status === GATE_STATUS.REJECTED, 'Custom rule catches missing version');
  assert(noVersionResult.checks.some(c => c.rule === 'version-present' && !c.pass), 'Custom rule appears in checks');

  const withVersionResult = await gates.verifyGate('deploy', {
    status: 'deployed',
    version: '1.2.3'
  }, { risk: 'medium', originalInput: { version: '1.2.3' } });
  assert(withVersionResult.status === GATE_STATUS.AUTO, 'Custom rule passes with version present');

  // ── Global Rules ────────────────────────────────────────────
  console.log('\n── Global Rules ─────────────────────────────');

  gates.addGlobalRule({
    name: 'max-response-size',
    description: 'Output must not exceed 10KB',
    check: (output) => {
      const size = JSON.stringify(output || '').length;
      return {
        pass: size < 10240,
        reason: `Output is ${size} bytes, exceeds 10KB limit`
      };
    }
  });

  const smallOutput = await gates.verifyGate('research', { summary: 'Small result' }, { risk: 'medium' });
  assert(smallOutput.checks.some(c => c.rule === 'max-response-size' && c.pass), 'Global rule passes for small output');

  // ── Approve/Reject API ──────────────────────────────────────
  console.log('\n── Approve/Reject API ───────────────────────');

  // Gate 1 for high risk requires approval
  let gate1Promise = gates.planGate('deploy', {
    description: 'Deploy v2.0 to production',
    steps: ['Build', 'Test', 'Deploy']
  }, { risk: 'high', userId: 'test-user' });

  // Get the pending gate
  let pending = gates.getPending();
  assert(pending.length > 0, 'Gate 1 creates pending entry');
  assert(pending[0].gate === 'gate1', 'Pending entry is gate1');
  assert(pending[0].skill === 'deploy', 'Pending entry has correct skill');

  // Approve it
  const gateId = pending[0].gateId;
  const approveSuccess = gates.approve(gateId);
  assert(approveSuccess === true, 'Approve returns true');

  const gate1Result = await gate1Promise;
  assert(gate1Result.status === GATE_STATUS.APPROVED, 'Gate 1 approved after user action');

  // Test rejection
  gate1Promise = gates.planGate('deploy', {
    description: 'Deploy risky thing'
  }, { risk: 'high', userId: 'test-user' });

  pending = gates.getPending();
  const rejectGateId = pending[0].gateId;
  const rejectSuccess = gates.reject(rejectGateId, 'Too risky');
  assert(rejectSuccess === true, 'Reject returns true');

  const rejectedGate = await gate1Promise;
  assert(rejectedGate.status === GATE_STATUS.REJECTED, 'Gate 1 rejected after user action');

  // ── Expiration ──────────────────────────────────────────────
  console.log('\n── Expiration ───────────────────────────────');

  // Create a gate with very short timeout
  const shortGates = new VerificationGates({ logger, auditDir: TEST_AUDIT_DIR, timeout: 500 });
  
  const expireResult = await shortGates.planGate('deploy', {
    description: 'This will expire'
  }, { risk: 'high' });

  assert(expireResult.status === GATE_STATUS.EXPIRED, 'Gate expires after timeout');
  shortGates.destroy();

  // ── Event Emission ──────────────────────────────────────────
  console.log('\n── Events ───────────────────────────────────');

  let pendingEvent = null;
  gates.on('gate-pending', (data) => pendingEvent = data);

  const eventPromise = gates.planGate('deploy', {
    description: 'Test event emission'
  }, { risk: 'high' });

  // Small delay for event to fire
  await new Promise(r => setTimeout(r, 50));
  assert(pendingEvent !== null, 'gate-pending event emitted');
  assert(pendingEvent.skill === 'deploy', 'Event has correct skill');
  assert(pendingEvent.gateId !== undefined, 'Event has gateId');

  // Approve to unblock
  gates.approve(pendingEvent.gateId);
  await eventPromise;

  // ── Auto-Approval (Pattern Learning) ────────────────────────
  console.log('\n── Auto-Approval (Pattern Learning) ─────────');

  // Approve the same pattern 3 times
  for (let i = 0; i < 3; i++) {
    const p = gates.planGate('deploy', {
      description: 'Identical deploy pattern'
    }, { risk: 'high', userId: 'test-user' });

    await new Promise(r => setTimeout(r, 10));
    const pend = gates.getPending();
    if (pend.length > 0) gates.approve(pend[0].gateId);
    await p;
  }

  // 4th time should auto-approve
  const autoApproveResult = await gates.planGate('deploy', {
    description: 'Identical deploy pattern'
  }, { risk: 'high', userId: 'test-user' });

  assert(autoApproveResult.status === GATE_STATUS.AUTO, 'Auto-approves after 3 identical approvals');

  // ── Stats ───────────────────────────────────────────────────
  console.log('\n── Stats ────────────────────────────────────');

  const stats = gates.getStats(1);
  assert(stats.gate1.approved > 0, 'Stats track gate1 approvals');
  assert(typeof stats.gate2.auto === 'number', 'Stats track gate2 auto-passes');
  assert(typeof stats.bySkill === 'object', 'Stats have per-skill breakdown');

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
