/**
 * Minimal Prometheus metrics (text exposition format 0.0.4). In-process
 * counters plus database gauges computed at scrape time. Single process only.
 */
import type { EngineEvent } from '../engine/engine.js';

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

type Labels = Record<string, string>;
const key = (l: Labels) =>
  Object.entries(l)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, '_')}"`)
    .join(',');

class Counter {
  private readonly values = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}
  inc(labels: Labels = {}, by = 1) {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.values) lines.push(`${this.name}${k ? `{${k}}` : ''} ${v}`);
    return lines.join('\n');
  }
}

class Histogram {
  private readonly series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(readonly name: string, readonly help: string) {}
  observe(labels: Labels, seconds: number) {
    const k = key(labels);
    const s = this.series.get(k) ?? { counts: BUCKETS.map(() => 0), sum: 0, count: 0 };
    BUCKETS.forEach((b, i) => {
      if (seconds <= b) s.counts[i]!++;
    });
    s.sum += seconds;
    s.count++;
    this.series.set(k, s);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.series) {
      const pre = k ? `${k},` : '';
      BUCKETS.forEach((b, i) => lines.push(`${this.name}_bucket{${pre}le="${b}"} ${s.counts[i]}`));
      lines.push(`${this.name}_bucket{${pre}le="+Inf"} ${s.count}`, `${this.name}_sum${k ? `{${k}}` : ''} ${s.sum}`, `${this.name}_count${k ? `{${k}}` : ''} ${s.count}`);
    }
    return lines.join('\n');
  }
}

export class Metrics {
  readonly httpRequests = new Counter('rewind_http_requests_total', 'HTTP requests by route class, method and status.');
  readonly httpDuration = new Histogram('rewind_http_request_duration_seconds', 'HTTP request latency by route class.');
  readonly engineEvents = new Counter('rewind_engine_events_total', 'Audit events recorded by the engine, by type.');
  readonly executionOutcomes = new Counter('rewind_execution_outcomes_total', 'Executions reaching a final or attention status, by status.');
  private readonly started = Date.now();

  onEngineEvent(e: EngineEvent) {
    this.engineEvents.inc({ type: e.eventType });
    if (e.eventType === 'execution.status_changed') {
      const to = String(e.payload.to);
      if (['succeeded', 'recovered', 'partially_recovered', 'recovery_failed', 'failed', 'cancelled', 'awaiting_approval'].includes(to)) this.executionOutcomes.inc({ status: to });
    }
  }

  render(gauges: { name: string; help: string; samples: { labels?: Labels; value: number }[] }[]): string {
    const out = [this.httpRequests.render(), this.httpDuration.render(), this.engineEvents.render(), this.executionOutcomes.render()];
    out.push(`# HELP rewind_uptime_seconds Seconds since the process started.\n# TYPE rewind_uptime_seconds gauge\nrewind_uptime_seconds ${Math.round((Date.now() - this.started) / 1000)}`);
    for (const g of gauges) {
      out.push(`# HELP ${g.name} ${g.help}\n# TYPE ${g.name} gauge\n${g.samples.map((s) => `${g.name}${s.labels && Object.keys(s.labels).length ? `{${key(s.labels)}}` : ''} ${s.value}`).join('\n')}`);
    }
    return `${out.join('\n')}\n`;
  }
}
