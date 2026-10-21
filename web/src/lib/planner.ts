/**
 * Deterministic planner for the agent demo: turns a household request into
 * steps against the synthetic home's registered operations. Same text, same
 * plan. No language model is involved; every value it extracts (temperature,
 * task text, message text) comes from the words of the request.
 */
export interface PlannedStep {
  adapter_id: string;
  operation: string;
  input: Record<string, unknown>;
  depends_on?: number[];
  dedupe_key: string;
  because: string;
}

interface Match {
  at: number;
  step: Omit<PlannedStep, 'dedupe_key' | 'depends_on'>;
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/[.,;!?]+$/, '');
const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const upperFirst = (s: string) => s.replace(/^./, (c) => c.toUpperCase());
const firstIndex = (text: string, re: RegExp) => {
  const m = re.exec(text);
  return m ? { at: m.index, phrase: m[0] } : null;
};

function thermostat(text: string): Match | null {
  const hit = firstIndex(text, /\b(thermostat|heat(?:ing|er)?|temperature|temp|degrees?|a\/?c|air ?con(?:ditioning)?|cool(?:ing)?|warm(?: it)?(?: up)?|furnace|hvac)\b/i);
  if (!hit) return null;
  let mode: 'home' | 'away' | 'eco' | 'off' = 'away';
  if (/\b(eco|save (?:energy|power)|energy[- ]sav)/i.test(text)) mode = 'eco';
  else if (/\b(turn|switch|shut) (?:the )?(?:heat(?:ing)?|thermostat|a\/?c|air ?con\w*) off\b|\b(turn|switch|shut) off (?:the )?(?:heat(?:ing)?|thermostat|a\/?c|air ?con\w*)\b/i.test(text)) mode = 'off';
  else if (/\b(i'?m (?:coming )?home|back home|coming home|warm(?: it)? up|make it (?:warm|cosy|cozy|comfortable)|home mode)\b/i.test(text)) mode = 'home';
  const input: Record<string, unknown> = { mode };
  // Only read a number that sits near the temperature words, so "2 tasks" is never a temperature.
  const near = text.slice(Math.max(0, hit.at - 20), hit.at + hit.phrase.length + 25).replace(/\b\d+\s*(?:tasks?|items?|things?|people|minutes?|hours?|days?|pm|am)\b/gi, '');
  const n = /(\d{1,3}(?:\.\d)?)\s*(?:°\s*)?(f\b|fahrenheit|c\b|celsius|degrees?)?/i.exec(near);
  if (n) {
    let c = Number(n[1]);
    if (/^f/i.test(n[2] ?? '') || c > 40) c = Math.round(((c - 32) * 5) / 9);
    if (c >= 5 && c <= 30) input.targetC = c;
  }
  if (mode === 'away' && input.targetC === undefined) input.targetC = 16;
  return { at: hit.at, step: { adapter_id: 'home-sim', operation: 'thermostat.set_mode', input, because: `mentions "${hit.phrase}"` } };
}

function tasks(text: string): Match | null {
  const remind = /\bremind (?:me|us|everyone) to ([^.,;!?]+?)(?=\s+(?:and|then)\b|[.,;!?]|$)/i.exec(text);
  const addTo = /\badd ["“]?([^"”.,;!?]+?)["”]? to (?:my|our|the) (?:to-?do |task |shopping |household )?(?:list|tasks)\b/i.exec(text);
  const m = remind ?? addTo;
  if (m) {
    const item = m[1]!.trim();
    const title = item ? cap(upperFirst(clean(item)), 120) : 'Check the windows are closed';
    return { at: m.index, step: { adapter_id: 'home-sim', operation: 'tasks.update', input: { add: [title] }, because: `mentions "${cap(clean(m[0]), 40)}"` } };
  }
  const hit = firstIndex(text, /\b(tasks?|to-?dos?|chores?|checklist|(?:my|our|the) list)\b/i);
  if (!hit) return null;
  return { at: hit.at, step: { adapter_id: 'home-sim', operation: 'tasks.update', input: { add: ['Check the windows are closed'] }, because: `mentions "${hit.phrase}"` } };
}

function message(text: string): Match | null {
  const hit = firstIndex(text, /\b(tell|text|message|notify|let (?:\w+ ){1,3}know|send (?:a |an )?(?:message|text|note)|inform)\b/i);
  if (!hit) return null;
  const quoted = /["“]([^"”]{1,400})["”]/.exec(text);
  const rest = text.slice(hit.at);
  const that = /\b(?:that|saying|say)\s+([^.;!?]+?)(?=,?\s+(?:and then|then|and (?:set|turn|switch|add|remind|arm|activate|lock|disarm))\b|[.;!?]|$)/i.exec(rest);
  const body = quoted?.[1] ?? that?.[1];
  const out = body ? cap(upperFirst(clean(body)), 280) : "We're heading out. The house is set to away mode.";
  return { at: hit.at, step: { adapter_id: 'home-sim', operation: 'notify.send_message', input: { text: out }, because: `asks to "${hit.phrase}"` } };
}

function security(text: string): Match | null {
  const disarm = firstIndex(text, /\b(disarm|deactivate (?:the )?(?:alarm|security)|turn off (?:the )?(?:alarm|security)|unlock (?:the )?(?:house|doors?|home))\b/i);
  if (disarm) {
    return { at: disarm.at, step: { adapter_id: 'home-sim', operation: 'security.disarm', input: { reason: cap(clean(text), 200).padEnd(3, '.') }, because: `asks to "${disarm.phrase}"` } };
  }
  const arm = firstIndex(
    text,
    /\b(?:arm|activate|enable|turn on|set) (?:the )?(?:security|alarm|routine|weekend[- ]away)\b|\b(?:security|alarm) (?:routine|system)\b|\block (?:up|the (?:house|doors?|home))\b|\bsecure (?:the )?(?:house|home|place)\b/i,
  );
  if (!arm) return null;
  return { at: arm.at, step: { adapter_id: 'home-sim', operation: 'security.activate_routine', input: { routine: 'weekend-away' }, because: `asks to "${arm.phrase}"` } };
}

const FINAL = new Set(['security.activate_routine']);

/** Same text, same plan. Steps follow the order you said them; arming security always runs last and depends on everything before it. */
export function planFromRequest(text: string): PlannedStep[] {
  const t = text.slice(0, 500);
  const found = [thermostat(t), tasks(t), message(t), security(t)].filter((m): m is Match => m !== null);
  found.sort((a, b) => Number(FINAL.has(a.step.operation)) - Number(FINAL.has(b.step.operation)) || a.at - b.at);
  return found.map((m, i) => ({
    ...m.step,
    dedupe_key: m.step.operation,
    depends_on: FINAL.has(m.step.operation) ? Array.from({ length: i }, (_, k) => k + 1) : [],
  }));
}

/** Ready-made requests for the prompt box. Each one shows a different recovery outcome. */
export const SAMPLE_PROMPTS: { label: string; text: string }[] = [
  { label: 'Weekend away', text: 'We are leaving for the weekend. Set the heat to 16 degrees, remind me to water the plants, and arm the security routine.' },
  { label: 'Tell the family', text: 'Turn the thermostat to eco, tell everyone that dinner is at 7, then lock up the house.' },
  { label: 'Coming home', text: "I'm coming home. Warm it up to 21 degrees and add buy milk to my list." },
  { label: 'Try something risky', text: 'Disarm the alarm so the cleaner can get in.' },
];
