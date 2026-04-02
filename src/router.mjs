const DEFAULT_OPENAI_TARGET = 'openai';
const DEFAULT_OPENAI_MODEL = 'gpt-5.4';

function matchesQuerySource(querySource, allowedSources) {
  if (!Array.isArray(allowedSources) || allowedSources.length === 0) {
    return true;
  }

  return allowedSources.includes(querySource);
}

function matchesToolCount(toolCount, maxToolCount) {
  if (typeof maxToolCount !== 'number' || !Number.isFinite(maxToolCount)) {
    return true;
  }

  return toolCount <= maxToolCount;
}

function matchesThinking(thinking, thinkingEnabled) {
  if (typeof thinkingEnabled !== 'boolean') {
    return true;
  }

  return Boolean(thinking) === thinkingEnabled;
}

export function matchesRoutingRule(rule, classification = {}) {
  if (!rule || typeof rule !== 'object' || rule.enabled === false) {
    return false;
  }

  const condition = rule.condition ?? {};

  return (
    matchesQuerySource(classification.querySource ?? null, condition.query_source) &&
    matchesToolCount(classification.toolCount ?? 0, condition.tool_count_max) &&
    matchesThinking(classification.thinking ?? false, condition.thinking_enabled)
  );
}

export function selectRoute(classification = {}, config = {}) {
  if (!config?.routing?.enabled) {
    return null;
  }

  const rules = Array.isArray(config.routing.rules) ? config.routing.rules : [];

  for (const rule of rules) {
    if (!matchesRoutingRule(rule, classification)) {
      continue;
    }

    return {
      name: rule.name ?? null,
      target: rule.target ?? DEFAULT_OPENAI_TARGET,
      model: rule.model ?? config?.openai?.default_model ?? DEFAULT_OPENAI_MODEL,
    };
  }

  return null;
}
