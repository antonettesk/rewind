/**
 * Deterministic, keyword-based planner for the browser agent simulation.
 * Same text, same plan. No language model is involved.
 */
export interface PlannedStep {
  adapter_id: string;
  operation: string;
  input: Record<string, unknown>;
  depends_on?: number[];
  dedupe_key: string;
  because: string;
}

const RULES: { test: RegExp; step: Omit<PlannedStep, 'dedupe_key' | 'depends_on'> }[] = [
  {
    test: /\b(thermostat|heating|temperature)\b/i,
    step: { adapter_id: 'home-sim', operation: 'thermostat.set_mode', input: { mode: 'away', targetC: 16 }, because: 'mentions the thermostat / away mode' },
  },
  {
    test: /\b(task|tasks|to-?do|chores?)\b/i,
    step: { adapter_id: 'home-sim', operation: 'tasks.update', input: { add: ['Weekend away: check windows before leaving'], complete: ['t2'] }, because: 'mentions the household task list' },
  },
  {
    test: /\b(tell|message|notify|let .* know)\b/i,
    step: { adapter_id: 'home-sim', operation: 'notify.send_message', input: { text: 'Leaving for the weekend. Thermostat set to away.' }, because: 'asks to message the household' },
  },
  {
    test: /\bdisarm\b/i,
    step: { adapter_id: 'home-sim', operation: 'security.disarm', input: { reason: 'requested by user' }, because: 'asks to disarm security' },
  },
  {
    test: /\b(activate|arm|enable)\b.*\b(security|alarm|routine)\b|\b(security|alarm) routine\b/i,
    step: { adapter_id: 'home-sim', operation: 'security.activate_routine', input: { routine: 'weekend-away' }, because: 'asks to activate the security routine' },
  },
];

/** Deterministic planner: same text, same plan. Final security step depends on all earlier ones. */
export function planFromRequest(text: string): PlannedStep[] {
  const steps: PlannedStep[] = [];
  for (const rule of RULES) {
    if (!rule.test.test(text)) continue;
    const isFinal = rule.step.operation === 'security.activate_routine';
    steps.push({
      ...rule.step,
      dedupe_key: rule.step.operation,
      depends_on: isFinal ? steps.map((_, i) => i + 1) : [],
    });
  }
  // Keep the security routine last regardless of phrase order.
  steps.sort((a, b) => Number(a.operation === 'security.activate_routine') - Number(b.operation === 'security.activate_routine'));
  return steps.map((s, i) => (s.operation === 'security.activate_routine' ? { ...s, depends_on: Array.from({ length: i }, (_, k) => k + 1) } : s));
}
