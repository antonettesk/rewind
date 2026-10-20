/**
 * Reproducible demo scenarios. Each one is a fixed plan plus a fixed set of
 * injected faults, so it behaves identically on every run, with or without a
 * model. Faults are armed in the adapter's store; nothing is faked in the UI.
 */
import type { FaultMode } from '../adapters/home-sim/store.js';
import type { StepInput } from '../engine/engine.js';

export interface Scenario {
  id: string;
  title: string;
  summary: string;
  request: string;
  steps: StepInput[];
  faults: { operation: string; mode: FaultMode; count?: number }[];
  expected: string;
}

export const WEEKEND_REQUEST =
  'Prepare the house for the weekend. Switch the thermostat to away mode, update the household task list, and activate the security routine.';

// Thermostat and task list are independent of each other; the security routine
// is the final step and depends on both.
const weekendSteps: StepInput[] = [
  { adapterId: 'home-sim', operation: 'thermostat.set_mode', input: { mode: 'away', targetC: 16 }, dependsOn: [], dedupeKey: 'thermostat' },
  { adapterId: 'home-sim', operation: 'tasks.update', input: { add: ['Weekend away: check windows before leaving'], complete: ['t2'] }, dependsOn: [], dedupeKey: 'tasks' },
  { adapterId: 'home-sim', operation: 'security.activate_routine', input: { routine: 'weekend-away' }, dependsOn: [1, 2], dedupeKey: 'security' },
];

export const SCENARIOS: Scenario[] = [
  {
    id: 'weekend-failure',
    title: 'Weekend prep, security hub fails',
    summary: 'Two steps succeed, the third is rejected. REWIND compensates both and verifies them.',
    request: WEEKEND_REQUEST,
    steps: weekendSteps,
    faults: [{ operation: 'security.activate_routine', mode: 'error' }],
    expected: 'recovered: thermostat and task list restored and verified; security routine never activated, so nothing to reverse.',
  },
  {
    id: 'weekend-success',
    title: 'Weekend prep, no faults',
    summary: 'All three steps succeed. No recovery runs.',
    request: WEEKEND_REQUEST,
    steps: weekendSteps,
    faults: [],
    expected: 'succeeded',
  },
  {
    id: 'compensation-fails',
    title: 'Compensation rejected once',
    summary: 'The thermostat restore is rejected on the first attempt. Retrying is safe because the restore is idempotent.',
    request: WEEKEND_REQUEST,
    steps: weekendSteps,
    faults: [
      { operation: 'security.activate_routine', mode: 'error' },
      { operation: 'thermostat.set_mode', mode: 'compensation_error' },
    ],
    expected: 'partially_recovered, then recovered after a retry.',
  },
  {
    id: 'state-drift',
    title: 'Someone edits the task list',
    summary: 'Another household member changes the task list after REWIND did. REWIND refuses to overwrite their change.',
    request: WEEKEND_REQUEST,
    steps: weekendSteps,
    faults: [
      { operation: 'tasks.update', mode: 'drift' },
      { operation: 'security.activate_routine', mode: 'error' },
    ],
    expected: 'partially_recovered: thermostat verified; task list needs manual review.',
  },
  {
    id: 'unknown-outcome',
    title: 'Task update times out',
    summary: 'The task update applies but its response is lost. REWIND does not retry; it reads the list back, sees the change, and compensates.',
    request: WEEKEND_REQUEST,
    steps: weekendSteps,
    faults: [{ operation: 'tasks.update', mode: 'timeout' }],
    expected: 'recovered: outcome reconciled as applied, then compensated and verified.',
  },
  {
    id: 'irreversible-message',
    title: 'A message was already sent',
    summary: 'An approved household message goes out before the failure. It cannot be unsent, and REWIND says so.',
    request: 'Set the thermostat to away, tell the household we are leaving, then activate the security routine.',
    steps: [
      { adapterId: 'home-sim', operation: 'thermostat.set_mode', input: { mode: 'away', targetC: 16 } },
      { adapterId: 'home-sim', operation: 'notify.send_message', input: { text: 'Leaving for the weekend. Thermostat set to away.' } },
      { adapterId: 'home-sim', operation: 'security.activate_routine', input: { routine: 'weekend-away' } },
    ],
    faults: [{ operation: 'security.activate_routine', mode: 'error' }],
    expected: 'awaiting_approval, then partially_recovered: thermostat verified; message unresolved.',
  },
  {
    id: 'faulty-compensation',
    title: 'Compensation lies',
    summary: 'The thermostat restore handler reports success but writes the wrong value. Verification catches it.',
    request: WEEKEND_REQUEST,
    steps: weekendSteps,
    faults: [
      { operation: 'security.activate_routine', mode: 'error' },
      { operation: 'thermostat.set_mode', mode: 'silent_compensation_failure' },
    ],
    expected: 'partially_recovered: task list verified; thermostat recovery failed verification.',
  },
  {
    id: 'transient-retry',
    title: 'Transient error, safe retry',
    summary: 'The security hub is briefly unavailable and reports that nothing changed, so one retry is allowed and succeeds.',
    request: WEEKEND_REQUEST,
    steps: weekendSteps,
    faults: [{ operation: 'security.activate_routine', mode: 'transient' }],
    expected: 'succeeded after one forward retry.',
  },
  {
    id: 'first-step-fails',
    title: 'First step fails',
    summary: 'The thermostat is unreachable. Nothing changed, so there is nothing to recover.',
    request: WEEKEND_REQUEST,
    steps: weekendSteps,
    faults: [{ operation: 'thermostat.set_mode', mode: 'error' }],
    expected: 'failed: no recovery needed.',
  },
];

export function getScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
