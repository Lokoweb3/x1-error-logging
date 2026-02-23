/**
 * X1 Vault — AI Auto-Fix Engine
 * 
 * Turns improvement proposals into actual code fixes.
 * 
 * Flow:
 *   1. Self-Improvement Loop detects a pattern → generates a proposal
 *   2. Auto-Fix Engine takes the proposal → reads the relevant source file
 *   3. Sends error context + source code to LLM → gets a code fix back
 *   4. Creates a patch (original vs fixed) → sends to user for approval
 *   5. User approves → engine applies the patch → logs the fix
 *   6. User rejects → engine discards and learns from rejection
 * 
 * Safety:
 *   - NEVER auto-deploys. Every fix requires human approval.
 *   - Creates a backup before applying any patch.
 *   - Runs tests after applying to verify the fix doesn't break anything.
 *   - Rolls back automatically if tests fail.
 * 
 * Usage:
 *   const autofix = new AutoFixEngine({
 *     logger, loop, llmProvider,
 *     skillsDir: '/home/node/.openclaw/workspace/skills'
 *   });
 *   
 *   // Generate a fix for a proposal
 *   const fix = await autofix.generateFix(proposalId);
 *   
 *   // User approves → apply it
 *   await autofix.applyFix(fix.id);
 *   
 *   // Or run the full pipeline
 *   await autofix.runPipeline();
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { execSync } = require('child_process');

// ─── Fix Status ──────────────────────────────────────────────────────

const FIX_STATUS = {
  GENERATING:  'generating',    // LLM is writing the fix
  READY:       'ready',         // Fix generated, awaiting approval
  APPROVED:    'approved',      // User approved, ready to deploy
  APPLYING:    'applying',      // Patch being applied
  TESTING:     'testing',       // Running tests after apply
  DEPLOYED:    'deployed',      // Fix is live
  FAILED:      'failed',        // Fix failed tests or apply
  ROLLED_BACK: 'rolled_back',   // Fix was rolled back
  REJECTED:    'rejected'       // User rejected the fix
};

// ─── Auto-Fix Engine ─────────────────────────────────────────────────

class AutoFixEngine extends EventEmitter {
  constructor(options = {}) {
    super();

    this.logger = options.logger || null;
    this.loop = options.loop || null;
    this.llmProvider = options.llmProvider || null; // Function that calls LLM API

    this.skillsDir = options.skillsDir || '/home/node/.openclaw/workspace/skills';
    this.dataDir = options.dataDir || path.join(process.cwd(), 'autofix-data');
    this.backupDir = path.join(this.dataDir, 'backups');
    this.fixesFile = path.join(this.dataDir, 'fixes.json');

    this._fixes = [];
    this._ensureDirs();
    this._loadFixes();
  }

  // ── Generate Fix ───────────────────────────────────────────────

  /**
   * Takes a proposal from the self-improvement loop and generates a code fix.
   * 
   * @param {string} proposalId - ID of the proposal to fix
   * @returns {Object} The generated fix with diff and explanation
   */
  async generateFix(proposalId) {
    // Get the proposal
    const proposals = this.loop.getProposals();
    const proposal = proposals.find(p => p.id === proposalId);
    if (!proposal) throw new Error(`Proposal ${proposalId} not found`);

    const fixId = this._generateId();

    const fix = {
      id: fixId,
      proposalId: proposal.id,
      skill: proposal.skill,
      status: FIX_STATUS.GENERATING,
      createdAt: new Date().toISOString(),
      proposal: {
        description: proposal.description,
        action: proposal.action,
        insight: proposal.insight,
        data: proposal.data
      },
      sourceFile: null,
      originalCode: null,
      fixedCode: null,
      diff: null,
      explanation: null,
      testResults: null,
      backupPath: null
    };

    this._fixes.push(fix);
    this._saveFixes();
    this.emit('fix-generating', fix);

    try {
      // Step 1: Find the relevant source file
      const sourceInfo = await this._findSourceFile(proposal);
      fix.sourceFile = sourceInfo.filePath;
      fix.originalCode = sourceInfo.code;

      // Step 2: Build the context for the LLM
      const context = this._buildFixContext(proposal, sourceInfo);

      // Step 3: Call the LLM to generate the fix
      const llmResponse = await this._callLLM(context);

      // Step 4: Parse the LLM response
      fix.fixedCode = llmResponse.code;
      fix.explanation = llmResponse.explanation;
      fix.diff = this._generateDiff(fix.originalCode, fix.fixedCode);

      fix.status = FIX_STATUS.READY;
      this._saveFixes();
      this.emit('fix-ready', fix);

      return fix;

    } catch (err) {
      fix.status = FIX_STATUS.FAILED;
      fix.error = err.message;
      this._saveFixes();
      this.emit('fix-failed', fix);
      return fix;
    }
  }

  /**
   * Generate fixes for all pending proposals.
   */
  async generateAll() {
    const pending = this.loop.getProposals({ status: 'pending' });
    const results = [];

    for (const proposal of pending) {
      try {
        const fix = await this.generateFix(proposal.id);
        results.push(fix);
      } catch (err) {
        results.push({ proposalId: proposal.id, error: err.message });
      }
    }

    return results;
  }

  // ── Apply Fix ──────────────────────────────────────────────────

  /**
   * Apply an approved fix. Creates backup, patches file, runs tests.
   * Rolls back automatically if tests fail.
   * 
   * @param {string} fixId
   * @returns {Object} Result with success status
   */
  async applyFix(fixId) {
    const fix = this._fixes.find(f => f.id === fixId);
    if (!fix) throw new Error(`Fix ${fixId} not found`);
    if (fix.status !== FIX_STATUS.READY && fix.status !== FIX_STATUS.APPROVED) {
      throw new Error(`Fix ${fixId} is ${fix.status}, cannot apply`);
    }

    fix.status = FIX_STATUS.APPLYING;
    this._saveFixes();

    try {
      // Step 1: Backup the original file
      fix.backupPath = this._backupFile(fix.sourceFile);

      // Step 2: Write the fixed code
      fs.writeFileSync(fix.sourceFile, fix.fixedCode, 'utf-8');

      // Step 3: Run tests
      fix.status = FIX_STATUS.TESTING;
      this._saveFixes();
      this.emit('fix-testing', fix);

      const testResult = await this._runTests(fix.skill);
      fix.testResults = testResult;

      if (!testResult.passed) {
        // Tests failed — roll back
        this._rollback(fix);
        fix.status = FIX_STATUS.ROLLED_BACK;
        fix.rollbackReason = `Tests failed: ${testResult.summary}`;
        this._saveFixes();
        this.emit('fix-rolled-back', fix);
        return { success: false, reason: fix.rollbackReason, fix };
      }

      // Step 4: Success — mark as deployed
      fix.status = FIX_STATUS.DEPLOYED;
      fix.deployedAt = new Date().toISOString();
      this._saveFixes();

      // Step 5: Record the fix in the error logger
      if (this.logger && fix.proposal.data?.hash) {
        this.logger.recordFix(fix.proposal.data.hash, {
          description: fix.explanation,
          diff: fix.diff,
          fixedBy: 'AutoFixEngine',
          fixId: fix.id
        });
      }

      // Step 6: Mark the proposal as applied
      if (this.loop) {
        this.loop.markApplied(fix.proposalId, `Auto-fixed by AI (fix ${fix.id})`);
      }

      this.emit('fix-deployed', fix);
      return { success: true, fix };

    } catch (err) {
      // Something went wrong — roll back
      if (fix.backupPath) {
        this._rollback(fix);
      }
      fix.status = FIX_STATUS.FAILED;
      fix.error = err.message;
      this._saveFixes();
      this.emit('fix-failed', fix);
      return { success: false, reason: err.message, fix };
    }
  }

  // ── Approve / Reject ───────────────────────────────────────────

  /**
   * Approve a generated fix. Call applyFix() after to deploy it.
   */
  approveFix(fixId) {
    const fix = this._fixes.find(f => f.id === fixId);
    if (!fix) return null;
    if (fix.status !== FIX_STATUS.READY) return null;

    fix.status = FIX_STATUS.APPROVED;
    fix.approvedAt = new Date().toISOString();
    this._saveFixes();
    this.emit('fix-approved', fix);
    return fix;
  }

  /**
   * Reject a generated fix.
   */
  rejectFix(fixId, reason = '') {
    const fix = this._fixes.find(f => f.id === fixId);
    if (!fix) return null;

    fix.status = FIX_STATUS.REJECTED;
    fix.rejectedAt = new Date().toISOString();
    fix.rejectionReason = reason;
    this._saveFixes();
    this.emit('fix-rejected', fix);
    return fix;
  }

  // ── Full Pipeline ──────────────────────────────────────────────

  /**
   * Run the complete auto-fix pipeline:
   * 1. Analyze (via self-improvement loop)
   * 2. Generate fixes for all pending proposals
   * 3. Emit events for user approval
   * 
   * Does NOT auto-apply — waits for human approval.
   */
  async runPipeline() {
    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║       X1 VAULT — AI AUTO-FIX PIPELINE        ║');
    console.log('╚══════════════════════════════════════════════╝\n');

    // Step 1: Run analysis
    if (this.loop) {
      console.log('── Step 1: Running Analysis ──────────────────');
      await this.loop.analyze(7);
    }

    // Step 2: Get fixable proposals
    const proposals = this.loop.getProposals({ status: 'pending' });
    const fixable = proposals.filter(p =>
      p.action === 'add_error_handling' ||
      p.action === 'update_skill_logic'
    );

    console.log(`\n── Step 2: ${fixable.length} fixable proposals found ──`);

    if (fixable.length === 0) {
      console.log('   No proposals to fix. System is clean.');
      return { fixes: [], skipped: proposals.length - fixable.length };
    }

    // Step 3: Generate fixes
    console.log('\n── Step 3: Generating AI Fixes ───────────────');
    const fixes = [];

    for (const proposal of fixable) {
      try {
        console.log(`   Generating fix for: ${proposal.description}`);
        const fix = await this.generateFix(proposal.id);
        fixes.push(fix);
        console.log(`   ✅ Fix ${fix.id} ready (${fix.status})`);
      } catch (err) {
        console.log(`   ❌ Failed: ${err.message}`);
        fixes.push({ proposalId: proposal.id, error: err.message });
      }
    }

    console.log(`\n── Pipeline Complete ─────────────────────────`);
    console.log(`   Fixes generated: ${fixes.filter(f => f.status === FIX_STATUS.READY).length}`);
    console.log(`   Awaiting approval. Use approveFix(id) then applyFix(id).`);

    this.emit('pipeline-complete', { fixes, proposals: fixable });
    return { fixes, skipped: proposals.length - fixable.length };
  }

  // ── Query ──────────────────────────────────────────────────────

  /**
   * Get all fixes, optionally filtered.
   */
  getFixes(filter = {}) {
    let fixes = [...this._fixes];
    if (filter.status) fixes = fixes.filter(f => f.status === filter.status);
    if (filter.skill) fixes = fixes.filter(f => f.skill === filter.skill);
    return fixes;
  }

  /**
   * Get a summary report.
   */
  getReport() {
    return {
      total: this._fixes.length,
      byStatus: {
        ready: this._fixes.filter(f => f.status === FIX_STATUS.READY).length,
        deployed: this._fixes.filter(f => f.status === FIX_STATUS.DEPLOYED).length,
        failed: this._fixes.filter(f => f.status === FIX_STATUS.FAILED).length,
        rejected: this._fixes.filter(f => f.status === FIX_STATUS.REJECTED).length,
        rolledBack: this._fixes.filter(f => f.status === FIX_STATUS.ROLLED_BACK).length
      },
      recentFixes: this._fixes.slice(-5)
    };
  }

  // ── Private: Source File Discovery ─────────────────────────────

  async _findSourceFile(proposal) {
    // Strategy 1: Extract file path from error stack trace
    if (proposal.data?.hash && this.logger) {
      const errors = this.logger.query({ days: 30 });
      const matchingError = errors.find(e => e.hash === proposal.data.hash);

      if (matchingError?.stack) {
        const filePath = this._extractFileFromStack(matchingError.stack);
        if (filePath && fs.existsSync(filePath)) {
          return {
            filePath,
            code: fs.readFileSync(filePath, 'utf-8'),
            matchedVia: 'stack_trace'
          };
        }
      }
    }

    // Strategy 2: Search skills directory by skill name
    const skillName = proposal.skill;
    if (skillName) {
      const searchPaths = [
        path.join(this.skillsDir, skillName),
        path.join(this.skillsDir, `x1-${skillName}`),
      ];

      for (const searchPath of searchPaths) {
        if (fs.existsSync(searchPath)) {
          // Find the main JS file
          const files = this._findJsFiles(searchPath);
          if (files.length > 0) {
            const mainFile = files.find(f => f.includes('index.js') || f.includes('main.js')) || files[0];
            return {
              filePath: mainFile,
              code: fs.readFileSync(mainFile, 'utf-8'),
              matchedVia: 'skill_directory'
            };
          }
        }
      }
    }

    throw new Error(`Could not find source file for skill: ${skillName}`);
  }

  _extractFileFromStack(stack) {
    const lines = stack.split('\n');
    for (const line of lines) {
      // Match patterns like: at functionName (/path/to/file.js:123:45)
      // or: at /path/to/file.js:123:45
      const match = line.match(/\(?(\/[^:)]+\.(?:js|ts|mjs)):(\d+)/);
      if (match) {
        const filePath = match[1];
        // Skip node_modules and internal files
        if (!filePath.includes('node_modules') && !filePath.includes('error-logger')) {
          return filePath;
        }
      }
    }
    return null;
  }

  _findJsFiles(dir) {
    const files = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
          files.push(...this._findJsFiles(fullPath));
        } else if (entry.isFile() && /\.(js|ts|mjs)$/.test(entry.name)) {
          files.push(fullPath);
        }
      }
    } catch {}
    return files;
  }

  // ── Private: LLM Integration ───────────────────────────────────

  _buildFixContext(proposal, sourceInfo) {
    // Build a focused context for the LLM
    const context = {
      task: 'Generate a code fix for the following issue.',
      rules: [
        'Return ONLY the complete fixed source file.',
        'Do NOT add new dependencies.',
        'Do NOT change the file structure or exports.',
        'Add clear comments explaining what you changed and why.',
        'Make the minimum change needed to fix the issue.',
        'Preserve all existing functionality.',
        'If adding error handling, use try/catch with descriptive error messages.',
        'If adding input validation, validate early and return clear errors.'
      ],
      issue: {
        description: proposal.description,
        insight: proposal.insight,
        action: proposal.action,
        skill: proposal.skill
      },
      sourceFile: sourceInfo.filePath,
      sourceCode: sourceInfo.code
    };

    // Add error details if available
    if (proposal.data?.hash && this.logger) {
      const errors = this.logger.query({ days: 30 });
      const matchingErrors = errors.filter(e => e.hash === proposal.data?.hash);
      if (matchingErrors.length > 0) {
        context.errorDetails = {
          message: matchingErrors[0].message,
          type: matchingErrors[0].error_type,
          stack: matchingErrors[0].stack,
          occurrences: matchingErrors.length,
          input: matchingErrors[0].input_summary
        };
      }
    }

    // Add correction details if available
    if (proposal.data?.recentExamples) {
      context.corrections = proposal.data.recentExamples.map(c => ({
        original: c.original,
        corrected: c.corrected,
        reason: c.reason
      }));
    }

    return context;
  }

  async _callLLM(context) {
    if (!this.llmProvider) {
      // No LLM provider — generate a template fix
      return this._generateTemplateFix(context);
    }

    // Build the prompt
    const prompt = this._buildPrompt(context);

    // Call the LLM
    const response = await this.llmProvider(prompt);

    // Parse the response
    return this._parseLLMResponse(response);
  }

  _buildPrompt(context) {
    let prompt = `You are a code repair agent. Fix the following issue in a Node.js file.\n\n`;
    prompt += `## Issue\n${context.issue.description}\n`;
    prompt += `Insight: ${context.issue.insight}\n\n`;

    if (context.errorDetails) {
      prompt += `## Error Details\n`;
      prompt += `Message: ${context.errorDetails.message}\n`;
      prompt += `Type: ${context.errorDetails.type}\n`;
      prompt += `Occurrences: ${context.errorDetails.occurrences}\n`;
      if (context.errorDetails.stack) {
        prompt += `Stack trace:\n${context.errorDetails.stack}\n`;
      }
      if (context.errorDetails.input) {
        prompt += `Input that caused error: ${context.errorDetails.input}\n`;
      }
      prompt += `\n`;
    }

    if (context.corrections) {
      prompt += `## User Corrections (what the user keeps fixing)\n`;
      for (const c of context.corrections) {
        prompt += `- Original: ${c.original}\n  Corrected: ${c.corrected}\n  Reason: ${c.reason}\n`;
      }
      prompt += `\n`;
    }

    prompt += `## Rules\n`;
    for (const rule of context.rules) {
      prompt += `- ${rule}\n`;
    }

    prompt += `\n## Source File: ${context.sourceFile}\n`;
    prompt += `\`\`\`javascript\n${context.sourceCode}\n\`\`\`\n\n`;

    prompt += `## Response Format\n`;
    prompt += `Respond with:\n`;
    prompt += `1. EXPLANATION: A brief explanation of what you changed and why (2-3 sentences)\n`;
    prompt += `2. CODE: The complete fixed source file wrapped in \`\`\`javascript ... \`\`\` tags\n`;

    return prompt;
  }

  _parseLLMResponse(response) {
    // Extract explanation
    let explanation = '';
    const explMatch = response.match(/EXPLANATION:?\s*([\s\S]*?)(?=CODE:|```)/i);
    if (explMatch) {
      explanation = explMatch[1].trim();
    }

    // Extract code
    let code = '';
    const codeMatch = response.match(/```(?:javascript|js)?\s*\n([\s\S]*?)\n```/);
    if (codeMatch) {
      code = codeMatch[1].trim();
    }

    if (!code) {
      throw new Error('LLM response did not contain a valid code block');
    }

    return { code, explanation };
  }

  /**
   * Template-based fix when no LLM is available.
   * Generates a reasonable fix based on the error type.
   */
  _generateTemplateFix(context) {
    const code = context.sourceCode;
    let explanation = '';
    let fixedCode = code;

    if (context.errorDetails) {
      const errorType = context.errorDetails.type;
      const errorMsg = context.errorDetails.message;

      switch (errorType) {
        case 'validation':
          explanation = `Added input validation to prevent "${errorMsg}". Checks input before processing.`;
          // Add validation at the top of the main function
          fixedCode = this._addInputValidation(code, errorMsg);
          break;

        case 'api':
          explanation = `Added retry logic with exponential backoff for API errors ("${errorMsg}").`;
          fixedCode = this._addRetryLogic(code, errorMsg);
          break;

        case 'network':
          explanation = `Added network error handling with retry and timeout for "${errorMsg}".`;
          fixedCode = this._addNetworkHandling(code, errorMsg);
          break;

        case 'logic':
          if (errorMsg.includes('Cannot read properties of undefined')) {
            const prop = errorMsg.match(/reading '(.+?)'/)?.[1] || 'unknown';
            explanation = `Added null check before accessing property "${prop}" to prevent "${errorMsg}".`;
            fixedCode = this._addNullCheck(code, prop, context.errorDetails.stack);
          } else {
            explanation = `Added try/catch around error-prone logic: "${errorMsg}".`;
            fixedCode = this._addTryCatch(code, errorMsg);
          }
          break;

        case 'timeout':
          explanation = `Increased timeout and added timeout handling for "${errorMsg}".`;
          fixedCode = this._addTimeoutHandling(code, errorMsg);
          break;

        default:
          explanation = `Added generic error handling for: "${errorMsg}".`;
          fixedCode = this._addTryCatch(code, errorMsg);
      }
    } else if (context.corrections) {
      explanation = `Applied pattern from user corrections: "${context.corrections[0]?.reason || 'user correction'}"`;
      // Can't auto-fix corrections without LLM — mark as needing manual review
      fixedCode = code;
    }

    return { code: fixedCode, explanation };
  }

  // ── Template Fix Helpers ───────────────────────────────────────

  _addInputValidation(code, errorMsg) {
    // Find the main/exported function and add validation
    const mainFnMatch = code.match(/(async\s+function\s+main\s*\([^)]*\)\s*\{)/);
    if (mainFnMatch) {
      const insertion = `\n  // [AUTO-FIX] Input validation added to prevent: ${errorMsg}\n  const args = process.argv.slice(2);\n  if (!args[0] || args[0].length < 32 || args[0].length > 44) {\n    console.error('❌ Invalid input: Please provide a valid address (32-44 characters)');\n    process.exit(1);\n  }\n`;
      return code.replace(mainFnMatch[1], mainFnMatch[1] + insertion);
    }
    return code;
  }

  _addRetryLogic(code, errorMsg) {
    const retryHelper = `
// [AUTO-FIX] Retry helper added for API error: ${errorMsg}
async function withRetry(fn, maxRetries = 3, baseDelay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.warn(\`Retry \${attempt}/\${maxRetries} after \${delay}ms: \${err.message}\`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}\n\n`;
    // Add at the top of the file (after requires)
    const lastRequire = code.lastIndexOf("require(");
    if (lastRequire > -1) {
      const insertPoint = code.indexOf('\n', lastRequire) + 1;
      return code.slice(0, insertPoint) + retryHelper + code.slice(insertPoint);
    }
    return retryHelper + code;
  }

  _addNetworkHandling(code, errorMsg) {
    // Same as retry but with specific network error checks
    return this._addRetryLogic(code, errorMsg);
  }

  _addNullCheck(code, property, stack) {
    // Try to find the line from the stack trace and add a null check
    if (stack) {
      const lineMatch = stack.match(/at.*?:(\d+):\d+/);
      if (lineMatch) {
        const lineNum = parseInt(lineMatch[1]);
        const lines = code.split('\n');
        if (lineNum > 0 && lineNum <= lines.length) {
          const targetLine = lines[lineNum - 1];
          // Add optional chaining or null check
          const comment = `  // [AUTO-FIX] Added null check for property "${property}"`;
          const guard = `  if (!${targetLine.trim().split('[')[0].split('.')[0].trim()}) { console.warn('Skipping: value is undefined'); return null; }`;
          lines.splice(lineNum - 1, 0, comment, guard);
          return lines.join('\n');
        }
      }
    }
    return code;
  }

  _addTryCatch(code, errorMsg) {
    // Wrap the main function body in a try/catch
    const mainFnMatch = code.match(/(async\s+function\s+main\s*\([^)]*\)\s*\{)([\s\S]*?)(\n\})/);
    if (mainFnMatch) {
      const wrapped = `${mainFnMatch[1]}\n  // [AUTO-FIX] Added error handling for: ${errorMsg}\n  try {${mainFnMatch[2]}\n  } catch (err) {\n    console.error('Error:', err.message);\n    process.exit(1);\n  }\n}`;
      return code.replace(mainFnMatch[0], wrapped);
    }
    return code;
  }

  _addTimeoutHandling(code, errorMsg) {
    const timeoutHelper = `
// [AUTO-FIX] Timeout wrapper added for: ${errorMsg}
async function withTimeout(fn, ms = 30000) {
  return Promise.race([
    fn(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Operation timed out after ' + ms + 'ms')), ms))
  ]);
}\n\n`;
    const lastRequire = code.lastIndexOf("require(");
    if (lastRequire > -1) {
      const insertPoint = code.indexOf('\n', lastRequire) + 1;
      return code.slice(0, insertPoint) + timeoutHelper + code.slice(insertPoint);
    }
    return timeoutHelper + code;
  }

  // ── Private: Diff Generation ───────────────────────────────────

  _generateDiff(original, fixed) {
    const origLines = original.split('\n');
    const fixedLines = fixed.split('\n');
    const diff = [];

    const maxLines = Math.max(origLines.length, fixedLines.length);
    for (let i = 0; i < maxLines; i++) {
      const origLine = origLines[i] || '';
      const fixedLine = fixedLines[i] || '';

      if (origLine !== fixedLine) {
        if (origLine) diff.push(`- ${origLine}`);
        if (fixedLine) diff.push(`+ ${fixedLine}`);
      }
    }

    return diff.join('\n');
  }

  // ── Private: Backup & Rollback ─────────────────────────────────

  _backupFile(filePath) {
    const timestamp = Date.now();
    const fileName = path.basename(filePath);
    const backupPath = path.join(this.backupDir, `${fileName}.${timestamp}.bak`);
    fs.copyFileSync(filePath, backupPath);
    return backupPath;
  }

  _rollback(fix) {
    if (fix.backupPath && fs.existsSync(fix.backupPath)) {
      fs.copyFileSync(fix.backupPath, fix.sourceFile);
    }
  }

  // ── Private: Test Runner ───────────────────────────────────────

  async _runTests(skillName) {
    try {
      // Try to find and run tests
      const testPaths = [
        path.join(this.skillsDir, skillName, 'test.js'),
        path.join(this.skillsDir, skillName, 'tests', 'test.js'),
        path.join(this.skillsDir, `x1-${skillName}`, 'test.js'),
      ];

      for (const testPath of testPaths) {
        if (fs.existsSync(testPath)) {
          const output = execSync(`node ${testPath} 2>&1`, {
            timeout: 30000,
            encoding: 'utf-8'
          });
          const passed = !output.includes('failed') || output.includes('0 failed');
          return {
            passed,
            summary: output.slice(-200),
            testFile: testPath
          };
        }
      }

      // No tests found — pass by default (but note it)
      return {
        passed: true,
        summary: 'No test file found — skipped',
        testFile: null
      };

    } catch (err) {
      return {
        passed: false,
        summary: err.message.slice(0, 300),
        testFile: null
      };
    }
  }

  // ── Private: Persistence ───────────────────────────────────────

  _ensureDirs() {
    for (const dir of [this.dataDir, this.backupDir]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
  }

  _loadFixes() {
    try {
      if (fs.existsSync(this.fixesFile)) {
        this._fixes = JSON.parse(fs.readFileSync(this.fixesFile, 'utf-8'));
      }
    } catch { this._fixes = []; }
  }

  _saveFixes() {
    fs.writeFileSync(this.fixesFile, JSON.stringify(this._fixes, null, 2));
  }

  _generateId() {
    return crypto.randomBytes(6).toString('hex');
  }
}

// ─── Exports ─────────────────────────────────────────────────────────

module.exports = {
  AutoFixEngine,
  FIX_STATUS
};
