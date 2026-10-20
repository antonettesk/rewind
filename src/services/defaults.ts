import type { PolicyRuleType } from '../domain/policy.js';

/** Default policies seeded into a new workspace. Readable, editable, enforced server-side. */
export const DEFAULT_POLICIES: { id: string; name: string; description: string; ruleType: PolicyRuleType; configuration: Record<string, unknown>; enabled: boolean }[] = [
  {
    id: 'pol_allow_home_sim',
    name: 'Allow home simulation tools',
    description: 'Agents may call operations on the local home-sim adapter. Anything not allowed by a rule is denied.',
    ruleType: 'allow_tools',
    configuration: { patterns: ['home-sim:*'] },
    enabled: true,
  },
  {
    id: 'pol_approve_irreversible',
    name: 'Approve irreversible messages',
    description: 'Sending a household message cannot be undone, so a person must approve it first.',
    ruleType: 'require_approval',
    configuration: { patterns: ['home-sim:notify.send_message'] },
    enabled: true,
  },
  {
    id: 'pol_prohibit_disarm',
    name: 'Never disarm security',
    description: 'Agents may never disarm the security routine, with or without approval.',
    ruleType: 'prohibit',
    configuration: { patterns: ['home-sim:security.disarm'] },
    enabled: true,
  },
  {
    id: 'pol_recovery',
    name: 'Automatic recovery',
    description: 'On failure, compensate eligible steps automatically. People may retry a failed recovery up to the attempt limit.',
    ruleType: 'recovery',
    configuration: { automatic: true, allowRetry: true, maxRecoveryAttempts: 3 },
    enabled: true,
  },
  {
    id: 'pol_limits',
    name: 'Execution limits',
    description: 'Bound the size of an execution and the number of safe forward retries per step.',
    ruleType: 'limits',
    configuration: { maxActionsPerExecution: 20, maxForwardRetries: 1 },
    enabled: true,
  },
];

export const LOCAL_WORKSPACE = { id: 'ws_local', name: 'Local workspace' };
