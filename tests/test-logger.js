/**
 * X1 Vault — Error Logger Tests
 * 
 * Run: node tests/test-logger.js
 * 
 * Validates all core functionality and generates sample error data
 * so you can see what the logs and reports look like.
 */

const { ErrorLogger, ERROR_TYPES, SEVERITY_LEVELS, hashStackTrace, classifyError } = require('../src/error-logger');
const { runAudit } = require('../src/self-audit');
const fs = require('fs');
const path = require('path');

const TEST_LOG_DIR = path.join(__dirname, '../errors-test');
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ ${message}`);
    failed++;
  }
}

function cleanup() {
  if (fs.existsSync(TEST_LOG_DIR)) {
    fs.rmSync(TEST_LOG_DIR, { recursive: true });
  }
}

// ─── Tests ───────────────────────────────────────────────────────────

async function runTests() {
  cleanup();

  console.log('\n── Error Classification ──────────────────────');
  
  assert(classifyError(new SyntaxError('Unexpected token')) === ERROR_TYPES.SYNTAX, 'Classifies SyntaxError');
  assert(classifyError(new TypeError('x is not a function')) === ERROR_TYPES.LOGIC, 'Classifies TypeError as logic');
  assert(classifyError(new Error('ECONNREFUSED')) === ERROR_TYPES.NETWORK, 'Classifies network errors');
  assert(classifyError(new Error('Request timeout')) === ERROR_TYPES.TIMEOUT, 'Classifies timeout errors');
  assert(classifyError(new Error('401 Unauthorized')) === ERROR_TYPES.PERMISSION, 'Classifies permission errors');
  assert(classifyError(new Error('Rate limit exceeded 429')) === ERROR_TYPES.API, 'Classifies API errors');
  assert(classifyError(new Error('Cannot find module "xyz"')) === ERROR_TYPES.DEPENDENCY, 'Classifies dependency errors');
  assert(classifyError(new Error('Field is required')) === ERROR_TYPES.VALIDATION, 'Classifies validation errors');
  assert(classifyError(new Error('Something weird happened')) === ERROR_TYPES.UNKNOWN, 'Classifies unknown errors');

  console.log('\n── Stack Trace Hashing ──────────────────────');

  const hash1 = hashStackTrace('Error: test\n    at foo (/a/b/c.js:10:5)\n    at bar (/a/b/d.js:20:10)');
  const hash2 = hashStackTrace('Error: test\n    at foo (/x/y/c.js:99:1)\n    at bar (/x/y/d.js:50:3)');
  assert(hash1 === hash2, 'Same functions at different lines produce same hash');

  const hash3 = hashStackTrace('Error: test\n    at differentFn (/a/b/c.js:10:5)');
  assert(hash1 !== hash3, 'Different functions produce different hash');

  assert(hashStackTrace(null) === 'no-stack', 'Handles null stack');
  assert(hashStackTrace('') === 'no-stack', 'Handles empty stack');

  console.log('\n── Error Capture ────────────────────────────');

  const logger = new ErrorLogger({ logDir: TEST_LOG_DIR });

  const entry1 = logger.capture(new Error('Rate limit exceeded 429'), {
    skill: 'token-audit',
    agent: 'TokenAuditAgent',
    input: { contractAddress: '0xabc123' }
  });

  assert(entry1.type === 'error', 'Entry type is error');
  assert(entry1.error_type === ERROR_TYPES.API, 'Auto-classified as API error');
  assert(entry1.skill === 'token-audit', 'Skill recorded');
  assert(entry1.agent === 'TokenAuditAgent', 'Agent recorded');
  assert(entry1.hash.length === 12, 'Hash generated (12 chars)');
  assert(entry1.occurrence_count === 1, 'First occurrence');

  // Capture same error again
  const entry2 = logger.capture(new Error('Rate limit exceeded 429'), {
    skill: 'token-audit',
    agent: 'TokenAuditAgent'
  });
  assert(entry2.occurrence_count === 2, 'Second occurrence tracked');

  console.log('\n── Severity Inference ───────────────────────');

  const deployError = logger.capture(new Error('Build failed'), {
    skill: 'deploy-bot',
    input: { version: '1.0.0' }
  });
  assert(deployError.severity === SEVERITY_LEVELS.CRITICAL, 'Deploy errors are critical');

  const apiError = logger.capture(new Error('ECONNREFUSED 127.0.0.1'), {
    skill: 'token-audit'
  });
  assert(apiError.severity === SEVERITY_LEVELS.HIGH, 'Network errors are high severity');

  const validationError = logger.capture(new Error('Field name is required'), {
    skill: 'vault-sync'
  });
  assert(validationError.severity === SEVERITY_LEVELS.MEDIUM, 'Validation errors are medium severity');

  console.log('\n── Skill Wrapping ──────────────────────────');

  // Test successful execution
  const successResult = await logger.wrapSkill('test-skill', async () => {
    return { data: 'success' };
  }, { testInput: true });

  assert(successResult.success === true, 'Successful skill returns success');
  assert(successResult.result.data === 'success', 'Result data preserved');
  assert(successResult.error === null, 'No error on success');

  // Test failed execution
  const failResult = await logger.wrapSkill('test-skill', async () => {
    throw new Error('Something broke');
  }, { testInput: true }, { agent: 'TestAgent' });

  assert(failResult.success === false, 'Failed skill returns failure');
  assert(failResult.error.message === 'Something broke', 'Error preserved');
  assert(failResult.entry !== null, 'Error entry created');

  console.log('\n── Query System ────────────────────────────');

  // Add some more varied errors
  logger.capture(new TypeError('Cannot read property x of undefined'), {
    skill: 'vault-sync', agent: 'VaultSyncAgent'
  });
  logger.capture(new Error('Module not found: crypto-utils'), {
    skill: 'vault-sync', agent: 'VaultSyncAgent'
  });

  const allErrors = logger.query({ days: 1 });
  assert(allErrors.length > 0, 'Query returns results');

  const tokenErrors = logger.query({ skill: 'token-audit', days: 1 });
  assert(tokenErrors.every(e => e.skill === 'token-audit'), 'Skill filter works');

  const apiErrors = logger.query({ type: 'api', days: 1 });
  assert(apiErrors.every(e => e.error_type === 'api'), 'Type filter works');

  console.log('\n── Recurring Errors ────────────────────────');

  const recurring = logger.getRecurringErrors(5);
  assert(recurring.length > 0, 'Recurring errors detected');
  assert(recurring[0].count >= 2, 'Most recurring has count >= 2');

  console.log('\n── Report Generation ───────────────────────');

  const report = logger.generateReport(1);
  assert(report.totals.errors > 0, 'Report has error count');
  assert(typeof report.totals.error_rate === 'number', 'Report has error rate');
  assert(Object.keys(report.by_skill).length > 0, 'Report has skill breakdown');
  assert(Object.keys(report.by_type).length > 0, 'Report has type breakdown');

  console.log('\n── Fix Recording ───────────────────────────');

  const errorHash = entry1.hash;
  const fixEntry = logger.recordFix(errorHash, {
    description: 'Added retry with exponential backoff',
    diff: '+ await retry(apiCall, 3);',
    fixedBy: 'user'
  });
  assert(fixEntry.type === 'fix', 'Fix entry type correct');
  assert(fixEntry.error_hash === errorHash, 'Fix linked to error hash');

  console.log('\n── Self-Audit Report ───────────────────────');

  // Run the self-audit against test data
  await runAudit({ days: 1, output: null });

  // ── Summary ──
  console.log('\n══════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════\n');

  // Show what the log files look like
  console.log('── Sample Log File ──────────────────────────');
  const dateStr = new Date().toISOString().split('T')[0];
  const logFile = path.join(TEST_LOG_DIR, `${dateStr}.json`);
  if (fs.existsSync(logFile)) {
    const lines = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);
    console.log(`  File: errors-test/${dateStr}.json`);
    console.log(`  Entries: ${lines.length}`);
    console.log(`  Sample entry:`);
    console.log(JSON.stringify(JSON.parse(lines[0]), null, 2).split('\n').map(l => '    ' + l).join('\n'));
  }

  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner failed:', err);
  cleanup();
  process.exit(1);
});
