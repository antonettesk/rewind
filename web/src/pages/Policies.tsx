import { useState } from 'react';
import { api, ApiError, type StoredPolicy } from '../lib/api';
import { useRole } from '../lib/auth';
import { fmtRelative } from '../lib/format';
import { Badge, Button, ErrorState, LoadingRows, PageHeader, Section, useAsync, useToast } from '../components/ui';

const TYPE_LABEL: Record<string, string> = {
  allow_tools: 'Allow',
  require_approval: 'Require approval',
  prohibit: 'Prohibit',
  recovery: 'Recovery',
  limits: 'Limits',
};

export function PoliciesPage() {
  const { data, error, loading, reload } = useAsync(() => api.policies(), []);
  return (
    <>
      <PageHeader
        title="Policies"
        description="Rules the engine checks on the server before every step and every recovery. Precedence: prohibit, then default deny, then require approval, then allow. When rules of the same kind disagree, the most restrictive one wins."
      />
      {error ? <ErrorState error={error} onRetry={() => void reload()} /> : null}
      {loading && !data ? <LoadingRows /> : null}
      <div className="space-y-4">
        {data?.policies.map((p) => (
          <PolicyCard key={p.id} policy={p} onSaved={() => void reload({ quiet: true })} />
        ))}
      </div>
    </>
  );
}

function PolicyCard({ policy, onSaved }: { policy: StoredPolicy; onSaved: () => void }) {
  const toast = useToast();
  const admin = useRole().can('admin');
  const [draft, setDraft] = useState(() => toDraft(policy));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(policy));

  async function save(patch: { enabled?: boolean; configuration?: Record<string, unknown> }) {
    setBusy(true);
    setErr(null);
    try {
      await api.updatePolicy(policy.id, { version: policy.version, ...patch });
      toast.push({ tone: 'ok', title: 'Policy saved', body: policy.name });
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError && e.issues?.length ? e.issues.map((i) => `${i.path || 'value'}: ${i.message}`).join('; ') : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const fieldId = `p-${policy.id}`;
  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          {policy.name}
          <Badge tone={policy.ruleType === 'prohibit' ? 'bad' : policy.ruleType === 'require_approval' ? 'warn' : policy.ruleType === 'allow_tools' ? 'ok' : 'neutral'} dot={false}>
            {TYPE_LABEL[policy.ruleType]}
          </Badge>
        </span>
      }
      description={policy.description}
      actions={
        <label className="flex items-center gap-2 text-sm">
          <span className="text-fg-2">{policy.enabled ? 'Enabled' : 'Disabled'}</span>
          <input
            type="checkbox"
            role="switch"
            aria-checked={policy.enabled}
            aria-label={`Enable ${policy.name}`}
            checked={policy.enabled}
            disabled={busy || !admin}
            onChange={(e) => save({ enabled: e.target.checked })}
            className="size-4 accent-[var(--accent)]"
          />
        </label>
      }
    >
      <form
        className="space-y-3 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save({ configuration: fromDraft(policy.ruleType, draft) });
        }}
      >
        {isPatterns(draft) ? (
          <label className="block" htmlFor={fieldId}>
            <span className="text-xs font-medium text-fg-2">Operation patterns, one per line (adapter:operation, * matches within a segment)</span>
            <textarea
              id={fieldId}
              rows={Math.max(2, draft.patterns.split('\n').length)}
              value={draft.patterns}
              onChange={(e) => setDraft({ patterns: e.target.value })}
              className="mt-1 w-full rounded-md border border-border-strong bg-surface px-3 py-2 font-mono text-sm outline-none focus:border-accent"
              aria-invalid={Boolean(err)}
              aria-describedby={err ? `${fieldId}-err` : undefined}
            />
          </label>
        ) : (
          <div className="flex flex-wrap gap-6">
            {Object.entries(draft).map(([k, v]) => (
              <label key={k} className="flex items-center gap-2 text-sm">
                {typeof v === 'boolean' ? (
                  <input type="checkbox" checked={v} onChange={(e) => setDraft({ ...draft, [k]: e.target.checked })} className="size-4 accent-[var(--accent)]" />
                ) : (
                  <input
                    type="number"
                    value={String(v)}
                    onChange={(e) => setDraft({ ...draft, [k]: e.target.value === '' ? '' : Number(e.target.value) })}
                    className="h-8 w-20 rounded-md border border-border-strong bg-surface px-2 text-sm tabular outline-none focus:border-accent"
                  />
                )}
                <span className="text-fg-2">{LABELS[k] ?? k}</span>
              </label>
            ))}
          </div>
        )}
        {err && (
          <p id={`${fieldId}-err`} role="alert" className="rounded bg-bad-soft px-3 py-2 text-xs text-bad">
            {err}
          </p>
        )}
        <div className="flex items-center justify-between">
          <p className="text-xs text-fg-3">
            v{policy.version} · updated {fmtRelative(policy.updatedAt)} · changes are recorded in the audit log
          </p>
          <div className="flex gap-2">
            {dirty && (
              <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(toDraft(policy))}>
                Discard
              </Button>
            )}
            <Button type="submit" size="sm" variant="primary" disabled={!dirty || !admin} loading={busy}>
              Save
            </Button>
          </div>
        </div>
      </form>
    </Section>
  );
}

const LABELS: Record<string, string> = {
  automatic: 'Recover automatically on failure',
  allowRetry: 'Allow people to retry a failed recovery',
  maxRecoveryAttempts: 'Max recovery attempts per step',
  maxActionsPerExecution: 'Max steps per execution',
  maxForwardRetries: 'Max safe forward retries per step',
};

type PatternDraft = { patterns: string };
type Draft = PatternDraft | Record<string, boolean | number | ''>;
const isPatterns = (d: Draft): d is PatternDraft => typeof (d as PatternDraft).patterns === 'string';

function toDraft(p: StoredPolicy): Draft {
  if (Array.isArray(p.configuration.patterns)) return { patterns: (p.configuration.patterns as string[]).join('\n') };
  return { ...(p.configuration as Record<string, boolean | number>) };
}

function fromDraft(ruleType: string, d: Draft): Record<string, unknown> {
  if (isPatterns(d) && ['allow_tools', 'require_approval', 'prohibit'].includes(ruleType)) {
    return { patterns: d.patterns.split('\n').map((s) => s.trim()).filter(Boolean) };
  }
  return d as Record<string, unknown>;
}
