import assert from 'node:assert/strict';
import test from 'node:test';

import { matchesRoutingRule, selectRoute } from '../src/router.mjs';

test('matchesRoutingRule returns true when all conditions match', () => {
  const matched = matchesRoutingRule(
    {
      condition: {
        query_source: ['agent:default', 'agent:custom'],
        tool_count_max: 3,
        thinking_enabled: false,
      },
    },
    {
      querySource: 'agent:default',
      toolCount: 2,
      thinking: false,
    },
  );

  assert.equal(matched, true);
});

test('matchesRoutingRule returns false for disabled rule or mismatched condition', () => {
  assert.equal(
    matchesRoutingRule(
      {
        enabled: false,
        condition: { query_source: ['agent:default'] },
      },
      { querySource: 'agent:default', toolCount: 1, thinking: false },
    ),
    false,
  );

  assert.equal(
    matchesRoutingRule(
      {
        condition: {
          query_source: ['agent:default'],
          tool_count_max: 1,
          thinking_enabled: false,
        },
      },
      { querySource: 'agent:default', toolCount: 2, thinking: false },
    ),
    false,
  );
});

test('selectRoute returns first matching rule when routing is enabled', () => {
  const route = selectRoute(
    {
      querySource: 'agent:custom',
      toolCount: 1,
      thinking: false,
    },
    {
      openai: {
        default_model: 'gpt-5.4',
      },
      routing: {
        enabled: true,
        rules: [
          {
            name: 'skip-disabled',
            enabled: false,
            target: 'openai',
            model: 'gpt-4.1',
            condition: { query_source: ['agent:custom'] },
          },
          {
            name: 'agent-worker-to-codex',
            target: 'openai',
            model: 'gpt-5.4',
            condition: {
              query_source: ['agent:custom'],
              tool_count_max: 3,
              thinking_enabled: false,
            },
          },
        ],
      },
    },
  );

  assert.deepEqual(route, {
    name: 'agent-worker-to-codex',
    target: 'openai',
    model: 'gpt-5.4',
  });
});

test('selectRoute returns null when routing is disabled or no rules match', () => {
  assert.equal(
    selectRoute(
      { querySource: 'agent:default', toolCount: 1, thinking: false },
      { routing: { enabled: false, rules: [{ condition: { query_source: ['agent:default'] } }] } },
    ),
    null,
  );

  assert.equal(
    selectRoute(
      { querySource: 'repl_main_thread', toolCount: 1, thinking: false },
      {
        routing: {
          enabled: true,
          rules: [{ condition: { query_source: ['agent:default'] } }],
        },
      },
    ),
    null,
  );
});
