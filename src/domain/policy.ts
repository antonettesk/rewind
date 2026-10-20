/**
 * The policy engine: pure functions over persisted policy rows. The HTTP API
 * and MCP tools never evaluate policy themselves; the engine calls these before
 * every mutation and before every recovery.
 */
import { z } from 'zod/v4';

export const POLICY_RULE_TYPES = ['allow_tools', 'require_approval', 'prohibit', 'recovery', 'limits'] as const;
export type PolicyRuleType = (typeof POLICY_RULE_TYPES)[number];

const patterns = z.array(z.string().regex(/^[a-z0-9*-]+:[a-z0-9_.*]+$/, 'Use "adapter:operation", * as wildcard')).min(1).max(50);

export const policyConfigSchemas = {
  allow_tools: z.object({ patterns }),
  require_approval: z.object({ patterns }),
  prohibit: z.object({ patterns }),
  recovery: z.object({
    automatic: z.boolean(),
    allowRetry: z.boolean(),
    maxRecoveryAttempts: z.number().int().min(1).max(5),
  }),
  limits: z.object({
    maxActionsPerExecution: z.number().int().min(1).max(100),
    maxForwardRetries: z.number().int().min(0).max(3),
  }),
} satisfies Record<PolicyRuleType, z.ZodType>;

export interface PolicyRecord {
  id: string;
  name: string;
  ruleType: PolicyRuleType;
  configuration: Record<string, unknown>;
  enabled: boolean;
}

export type PolicyDecision = 'allow' | 'require_approval' | 'deny';

export interface ActionPolicyResult {
  decision: PolicyDecision;
  /** Every rule that influenced the decision, so the trace can show why. */
  matched: { policyId: string; policyName: string; ruleType: PolicyRuleType; pattern?: string; effect: PolicyDecision }[];
  reason: string;
}

export function matchesPattern(pattern: string, key: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^:]*');
  return new RegExp(`^${escaped}$`).test(key);
}

/**
 * Precedence: prohibit > not allowed > require approval > allow.
 * Default deny: an operation no enabled allow rule covers is denied.
 * Reads are subject to prohibit and allow rules but never need approval.
 */
export function evaluateActionPolicy(policies: PolicyRecord[], operationKey: string, kind: 'read' | 'mutation'): ActionPolicyResult {
  const enabled = policies.filter((p) => p.enabled);
  const matched: ActionPolicyResult['matched'] = [];
  const hits = (type: PolicyRuleType, effect: PolicyDecision) =>
    enabled
      .filter((p) => p.ruleType === type)
      .flatMap((p) =>
        ((p.configuration.patterns as string[] | undefined) ?? [])
          .filter((pat) => matchesPattern(pat, operationKey))
          .map((pattern) => ({ policyId: p.id, policyName: p.name, ruleType: type, pattern, effect })),
      );

  const prohibited = hits('prohibit', 'deny');
  if (prohibited.length) {
    matched.push(...prohibited);
    return { decision: 'deny', matched, reason: `Prohibited by policy "${prohibited[0]!.policyName}".` };
  }
  const allowed = hits('allow_tools', 'allow');
  if (!allowed.length) {
    return { decision: 'deny', matched, reason: `No enabled policy allows ${operationKey} (default deny).` };
  }
  matched.push(...allowed);
  if (kind === 'mutation') {
    const approval = hits('require_approval', 'require_approval');
    if (approval.length) {
      matched.push(...approval);
      return { decision: 'require_approval', matched, reason: `Requires human approval under "${approval[0]!.policyName}".` };
    }
  }
  return { decision: 'allow', matched, reason: `Allowed by "${allowed[0]!.policyName}".` };
}

export interface EffectiveRecoveryPolicy {
  automatic: boolean;
  allowRetry: boolean;
  maxRecoveryAttempts: number;
  maxActionsPerExecution: number;
  maxForwardRetries: number;
  sources: string[];
}

/** Most restrictive wins when several rows of the same type are enabled. */
export function effectiveLimits(policies: PolicyRecord[]): EffectiveRecoveryPolicy {
  const out: EffectiveRecoveryPolicy = {
    automatic: false,
    allowRetry: false,
    maxRecoveryAttempts: 1,
    maxActionsPerExecution: 20,
    maxForwardRetries: 0,
    sources: [],
  };
  const recovery = policies.filter((p) => p.enabled && p.ruleType === 'recovery');
  if (recovery.length) {
    out.automatic = recovery.every((p) => p.configuration.automatic === true);
    out.allowRetry = recovery.every((p) => p.configuration.allowRetry === true);
    out.maxRecoveryAttempts = Math.min(...recovery.map((p) => Number(p.configuration.maxRecoveryAttempts)));
    out.sources.push(...recovery.map((p) => p.name));
  }
  const limits = policies.filter((p) => p.enabled && p.ruleType === 'limits');
  if (limits.length) {
    out.maxActionsPerExecution = Math.min(...limits.map((p) => Number(p.configuration.maxActionsPerExecution)));
    out.maxForwardRetries = Math.min(...limits.map((p) => Number(p.configuration.maxForwardRetries)));
    out.sources.push(...limits.map((p) => p.name));
  }
  return out;
}

export function parsePolicyConfig(ruleType: PolicyRuleType, configuration: unknown): Record<string, unknown> {
  return policyConfigSchemas[ruleType].parse(configuration) as Record<string, unknown>;
}
