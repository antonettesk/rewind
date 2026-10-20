import type { ExecutionView } from './queries.js';

const OUTCOME_LABEL: Record<string, string> = {
  not_required: 'Not required',
  recovery_verified: 'Recovered (verified)',
  recovery_pending: 'Recovery pending',
  recovery_available: 'Recovery available',
  recovery_failed: 'Recovery failed',
  recovery_unavailable: 'Recovery unavailable',
  manual_review: 'Needs manual review',
};

/**
 * A shareable, sanitized Markdown debugging report. Payloads were redacted
 * before they were stored; the report adds nothing that is not in the trace.
 */
export function renderReport(v: ExecutionView): string {
  const e = v.execution;
  const lines: string[] = [];
  lines.push(`# REWIND execution report`);
  lines.push('');
  lines.push(`> Sanitized export. Sensitive keys were redacted before storage. ${e.metadata.demo ? 'Contains synthetic demo data only.' : ''}`.trim());
  lines.push('');
  lines.push(`| Field | Value |`, `|---|---|`);
  lines.push(`| Execution | \`${e.id}\` |`);
  lines.push(`| Task | ${escape(e.taskDescription)} |`);
  lines.push(`| Status | **${e.status}** |`);
  lines.push(`| Environment | ${e.environment} |`);
  lines.push(`| Created | ${e.createdAt} |`);
  lines.push(`| Completed | ${e.completedAt ?? '—'} |`);
  if (e.failureReason) lines.push(`| Failure | ${escape(e.failureReason)} |`);
  lines.push('');
  lines.push(`## Steps`, '');
  lines.push(`| # | Operation | Status | Recovery capability | Recovery outcome |`, `|---|---|---|---|---|`);
  for (const a of v.actions) {
    lines.push(`| ${a.sequence} | \`${a.operationKey}\` | ${a.status}${a.errorCode ? ` (${a.errorCode})` : ''} | ${a.capability} | ${OUTCOME_LABEL[a.recoveryOutcome] ?? a.recoveryOutcome} |`);
  }
  lines.push('');
  if (v.summary.unresolved.length) {
    lines.push(`## Unresolved side effects`, '');
    for (const u of v.summary.unresolved) lines.push(`- Step ${u.sequence} \`${u.operationKey}\`: ${OUTCOME_LABEL[u.outcome] ?? u.outcome}. ${escape(u.reason)}`);
    lines.push('');
  }
  const verified = v.actions.filter((a) => a.recoveryAttempts.some((t) => t.verification));
  if (verified.length) {
    lines.push(`## Verification`, '');
    for (const a of verified) {
      for (const t of a.recoveryAttempts) {
        if (!t.verification) continue;
        lines.push(`- Step ${a.sequence}, attempt ${t.attemptNumber}: ${t.verification.restored ? 'restored (read back matches captured original)' : `NOT restored — ${t.verification.diffs.map((d) => `${d.path}: expected ${JSON.stringify(d.expected)}, observed ${JSON.stringify(d.observed)}`).join('; ')}`}`);
      }
    }
    lines.push('');
  }
  lines.push(`## Timeline`, '');
  for (const ev of v.events) lines.push(`- \`${ev.timestamp}\` **${ev.eventType}** (${ev.actorType})`);
  if (v.eventsTruncated) lines.push(`- … truncated`);
  lines.push('');
  return lines.join('\n');
}

function escape(s: string) {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
