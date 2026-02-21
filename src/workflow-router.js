/**
 * X1 Vault — Workflow Router
 * 
 * Single entry point for all incoming commands. Routes messages to
 * the correct skill/agent based on pattern matching + context.
 * 
 * Sits between the Telegram bot and your skills:
 * 
 *   User message → Router → Match pattern → Execute skill → Return result
 *                    ↓
 *              ErrorLogger (wraps every execution)
 * 
 * Features:
 *   - Pattern-based routing (regex + keyword matching)
 *   - Priority ordering (high-priority routes checked first)
 *   - Middleware hooks (pre/post execution)
 *   - Fallback handling (no match → default behavior)
 *   - Parallel subagent execution for complex tasks
 *   - Full error logging integration
 *   - Route analytics (which routes fire most, which fail most)
 * 
 * Usage:
 *   const router = new WorkflowRouter({ logger });
 *   
 *   router.addRoute({
 *     name: 'token-audit',
 *     patterns: [/audit\s+(\S+)/i, /check\s+contract\s+(\S+)/i],
 *     agent: 'TokenAuditAgent',
 *     handler: async (match, ctx) => auditToken(match[1]),
 *     priority: 'high'
 *   });
 *   
 *   const result = await router.route('audit 0xabc123');
 */

const { ErrorLogger, SEVERITY_LEVELS } = require('./error-logger');
const { EventEmitter } = require('events');

// ─── Constants ───────────────────────────────────────────────────────

const PRIORITY = {
  CRITICAL: 0,  // Safety checks, emergency stops
  HIGH: 1,      // Token audits, deploys
  NORMAL: 2,    // Standard commands
  LOW: 3,       // Info lookups, help
  FALLBACK: 99  // Catch-all
};

const RISK_LEVEL = {
  NONE: 'none',         // Read-only, no side effects
  LOW: 'low',           // Internal writes (memory, logs)
  MEDIUM: 'medium',     // External reads (API calls)
  HIGH: 'high',         // External writes (deploy, post, send)
  CRITICAL: 'critical'  // Financial ops (transfer, swap)
};

// ─── Route Definition ────────────────────────────────────────────────

/**
 * @typedef {Object} RouteConfig
 * @property {string} name - Unique route identifier
 * @property {(RegExp|string)[]} patterns - Regex or keyword patterns to match
 * @property {string} [agent] - Agent responsible for this route
 * @property {Function} handler - async (match, context) => result
 * @property {number} [priority] - Execution priority (lower = higher priority)
 * @property {string} [risk] - Risk level for verification gate integration
 * @property {boolean} [autoExecute] - Skip confirmation? (default: based on risk)
 * @property {string[]} [preChecks] - Functions to run before execution
 * @property {string[]} [aliases] - Alternative command names
 * @property {string} [description] - Human-readable description
 * @property {boolean} [enabled] - Enable/disable without removing (default: true)
 */

// ─── Workflow Router ─────────────────────────────────────────────────

class WorkflowRouter extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.routes = [];
    this.middleware = { pre: [], post: [] };
    this.fallbackHandler = null;
    this.logger = options.logger || new ErrorLogger({ logDir: options.logDir || './errors' });
    this.analytics = new RouteAnalytics();
    
    // Context that's available to all route handlers
    this.globalContext = options.context || {};
  }

  // ── Route Registration ─────────────────────────────────────────

  /**
   * Register a new route.
   */
  addRoute(config) {
    const route = {
      name: config.name,
      patterns: (config.patterns || []).map(p => 
        typeof p === 'string' ? new RegExp(p, 'i') : p
      ),
      agent: config.agent || null,
      handler: config.handler,
      priority: config.priority ?? PRIORITY.NORMAL,
      risk: config.risk || RISK_LEVEL.NONE,
      autoExecute: config.autoExecute ?? (config.risk !== RISK_LEVEL.HIGH && config.risk !== RISK_LEVEL.CRITICAL),
      preChecks: config.preChecks || [],
      aliases: config.aliases || [],
      description: config.description || '',
      enabled: config.enabled !== false
    };

    // Add alias patterns
    for (const alias of route.aliases) {
      route.patterns.push(new RegExp(`^\\/?${alias}\\b`, 'i'));
    }

    this.routes.push(route);
    
    // Keep sorted by priority
    this.routes.sort((a, b) => a.priority - b.priority);

    return this;
  }

  /**
   * Register multiple routes at once.
   */
  addRoutes(configs) {
    for (const config of configs) {
      this.addRoute(config);
    }
    return this;
  }

  /**
   * Set the fallback handler for unmatched messages.
   */
  setFallback(handler) {
    this.fallbackHandler = handler;
    return this;
  }

  /**
   * Add middleware that runs before/after every route.
   */
  use(stage, fn) {
    if (stage === 'pre' || stage === 'post') {
      this.middleware[stage].push(fn);
    }
    return this;
  }

  // ── Routing ────────────────────────────────────────────────────

  /**
   * Route an incoming message to the correct handler.
   * This is the main entry point — call this from your Telegram bot.
   * 
   * @param {string} message - The user's message
   * @param {Object} [context] - Additional context (chatId, userId, etc.)
   * @returns {Object} { matched, route, result, error }
   */
  async route(message, context = {}) {
    const startTime = Date.now();
    const ctx = { ...this.globalContext, ...context, message, timestamp: new Date().toISOString() };

    // Find matching route
    const { route, match } = this._findMatch(message);

    if (!route) {
      this.analytics.trackMiss(message);
      this.emit('no-match', { message, context: ctx });

      if (this.fallbackHandler) {
        const fallbackResult = await this.fallbackHandler(message, ctx);
        return { matched: false, route: null, result: fallbackResult, error: null };
      }
      return { matched: false, route: null, result: null, error: 'No matching route' };
    }

    // Track the hit
    this.analytics.trackHit(route.name);
    this.emit('match', { route: route.name, message, match });

    // Run pre-middleware
    for (const mw of this.middleware.pre) {
      try {
        await mw(route, ctx);
      } catch (err) {
        this.logger.capture(err, { skill: `middleware-pre`, metadata: { route: route.name } });
      }
    }

    // Run pre-checks
    for (const check of route.preChecks) {
      if (typeof check === 'function') {
        const checkResult = await check(ctx);
        if (!checkResult.pass) {
          return { matched: true, route: route.name, result: null, error: `Pre-check failed: ${checkResult.reason}` };
        }
      }
    }

    // Execute the route handler (wrapped with error logger)
    const { success, result, error, entry } = await this.logger.wrapSkill(
      route.name,
      () => route.handler(match, ctx),
      { message, matchGroups: match?.slice(1) },
      { agent: route.agent, severity: this._riskToSeverity(route.risk) }
    );

    // Track execution time
    const duration = Date.now() - startTime;
    this.analytics.trackExecution(route.name, success, duration);

    // Run post-middleware
    for (const mw of this.middleware.post) {
      try {
        await mw(route, ctx, { success, result, error, duration });
      } catch (err) {
        this.logger.capture(err, { skill: `middleware-post`, metadata: { route: route.name } });
      }
    }

    if (!success) {
      this.emit('error', { route: route.name, error, entry });
      return { matched: true, route: route.name, result: null, error: error.message, entry };
    }

    this.emit('success', { route: route.name, result, duration });
    return { matched: true, route: route.name, result, error: null };
  }

  /**
   * Route a message to multiple skills in parallel (for complex tasks).
   * 
   * @param {string[]} skillNames - Which routes to invoke
   * @param {*} input - Shared input for all skills
   * @param {Object} context - Shared context
   * @returns {Object} { results: { skillName: result }, errors: { skillName: error } }
   */
  async routeParallel(skillNames, input, context = {}) {
    const tasks = skillNames.map(name => {
      const route = this.routes.find(r => r.name === name);
      if (!route) return { name, result: null, error: `Route '${name}' not found` };
      
      return this.logger.wrapSkill(
        route.name,
        () => route.handler(null, { ...this.globalContext, ...context, input }),
        input,
        { agent: route.agent }
      ).then(r => ({ name, ...r }));
    });

    const outcomes = await Promise.allSettled(tasks);
    
    const results = {};
    const errors = {};

    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') {
        const { name, success, result, error } = outcome.value;
        if (success) results[name] = result;
        else errors[name] = error?.message || 'Unknown error';
      } else {
        errors['unknown'] = outcome.reason?.message || 'Promise rejected';
      }
    }

    return { results, errors };
  }

  // ── Introspection ──────────────────────────────────────────────

  /**
   * List all registered routes (for /help command).
   */
  listRoutes() {
    return this.routes
      .filter(r => r.enabled)
      .map(r => ({
        name: r.name,
        agent: r.agent,
        risk: r.risk,
        description: r.description,
        patterns: r.patterns.map(p => p.source),
        priority: r.priority
      }));
  }

  /**
   * Get analytics summary.
   */
  getAnalytics() {
    return this.analytics.getSummary();
  }

  /**
   * Enable/disable a route at runtime.
   */
  toggleRoute(name, enabled) {
    const route = this.routes.find(r => r.name === name);
    if (route) route.enabled = enabled;
    return this;
  }

  // ── Private ────────────────────────────────────────────────────

  _findMatch(message) {
    const normalized = message.trim();

    for (const route of this.routes) {
      if (!route.enabled) continue;

      for (const pattern of route.patterns) {
        const match = normalized.match(pattern);
        if (match) {
          return { route, match };
        }
      }
    }

    return { route: null, match: null };
  }

  _riskToSeverity(risk) {
    switch (risk) {
      case RISK_LEVEL.CRITICAL: return SEVERITY_LEVELS.CRITICAL;
      case RISK_LEVEL.HIGH: return SEVERITY_LEVELS.HIGH;
      case RISK_LEVEL.MEDIUM: return SEVERITY_LEVELS.MEDIUM;
      default: return SEVERITY_LEVELS.LOW;
    }
  }
}

// ─── Route Analytics ─────────────────────────────────────────────────

class RouteAnalytics {
  constructor() {
    this.hits = {};       // route → count
    this.misses = [];     // unmatched messages
    this.executions = {}; // route → { total, successes, failures, avgDuration }
  }

  trackHit(routeName) {
    this.hits[routeName] = (this.hits[routeName] || 0) + 1;
  }

  trackMiss(message) {
    this.misses.push({
      message: message.slice(0, 100),
      timestamp: new Date().toISOString()
    });
    // Keep last 50 misses
    if (this.misses.length > 50) this.misses.shift();
  }

  trackExecution(routeName, success, durationMs) {
    if (!this.executions[routeName]) {
      this.executions[routeName] = { total: 0, successes: 0, failures: 0, totalDuration: 0 };
    }
    const ex = this.executions[routeName];
    ex.total++;
    if (success) ex.successes++;
    else ex.failures++;
    ex.totalDuration += durationMs;
  }

  getSummary() {
    const routeStats = {};
    for (const [name, ex] of Object.entries(this.executions)) {
      routeStats[name] = {
        hits: this.hits[name] || 0,
        executions: ex.total,
        successRate: ex.total > 0 ? (ex.successes / ex.total * 100).toFixed(1) + '%' : 'N/A',
        avgDuration: ex.total > 0 ? Math.round(ex.totalDuration / ex.total) + 'ms' : 'N/A'
      };
    }

    return {
      totalRouted: Object.values(this.hits).reduce((a, b) => a + b, 0),
      totalMisses: this.misses.length,
      recentMisses: this.misses.slice(-5),
      routeStats
    };
  }
}

// ─── Exports ─────────────────────────────────────────────────────────

module.exports = {
  WorkflowRouter,
  RouteAnalytics,
  PRIORITY,
  RISK_LEVEL
};
