/**
 * Optional AWS features. Both stay outside the safety path:
 *  - Amazon Nova (Bedrock) proposes which registered operations to call for a
 *    natural-language request. Rewind validates every proposal against the
 *    operation's input schema and decides dependencies itself; execution,
 *    recovery and verification are unchanged and deterministic.
 *  - Amazon Polly reads Rewind's own deterministic outcome aloud. The spoken
 *    text is built from recorded state, never written by a model.
 *
 * Enabled when REWIND_AWS_REGION is set and the default AWS credential chain
 * resolves (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, a role, or a profile).
 */
import { BedrockRuntimeClient, ConverseCommand, type ContentBlock, type Message, type Tool } from '@aws-sdk/client-bedrock-runtime';
import { PollyClient, SynthesizeSpeechCommand, type Engine, type VoiceId } from '@aws-sdk/client-polly';
import type { AdapterRegistry } from '../adapters/registry.js';
import { DomainError } from '../domain/errors.js';
import type { ExecutionView } from './queries.js';

export interface AwsConfig {
  region: string | null;
  novaModelId: string;
  pollyVoice: string;
  pollyEngine: 'neural' | 'generative' | 'standard';
  /** Per workspace per UTC day. */
  dailyPlansPerWorkspace: number;
  dailySpeechPerWorkspace: number;
  /** Across all workspaces, per kind, per UTC day. */
  dailyGlobalLimit: number;
}

export interface NovaPlannedStep {
  adapter_id: string;
  operation: string;
  input: Record<string, unknown>;
  depends_on: number[];
  dedupe_key: string;
  because: string;
}

export interface NovaPlan {
  steps: NovaPlannedStep[];
  /** Proposals Rewind refused, with the reason. Shown to the user, never executed. */
  rejected: { operation: string; reason: string }[];
  model: string;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number } | null;
}

type Send = (command: any) => Promise<any>;

const SYSTEM = [
  'You plan actions for a smart-home assistant. The user speaks one request.',
  'Call the tools needed to fulfil it, once each, in the order they should run. Call every needed tool in a single reply.',
  'Only call a tool when the request clearly asks for that effect. Never disarm security unless explicitly asked.',
  'Fill the "why" field with a short phrase quoting the part of the request that justifies the call.',
  'If nothing applies, reply with one short sentence and call no tools.',
].join(' ');

/** Final routines depend on every earlier step; everything else is independent. Rewind decides this, not the model. */
const FINAL_OPERATIONS = new Set(['security.activate_routine']);
const MAX_STEPS = 8;

/** Bedrock tool names allow [a-zA-Z0-9_-]; operation keys contain ":" and ".". */
const toolName = (adapterId: string, op: string) => `${adapterId}__${op.replace(/\./g, '__')}`.slice(0, 64);

export class AwsFeatures {
  private readonly bedrock: Send | null;
  private readonly polly: Send | null;
  private readonly usage = new Map<string, number>();
  private readonly speechCache = new Map<string, Buffer>();

  constructor(
    readonly config: AwsConfig,
    private readonly registry: AdapterRegistry,
    clients?: { bedrock?: Send; polly?: Send },
  ) {
    const region = config.region;
    const bedrock = !clients?.bedrock && region ? new BedrockRuntimeClient({ region }) : null;
    const polly = !clients?.polly && region ? new PollyClient({ region }) : null;
    this.bedrock = clients?.bedrock ?? (bedrock ? (c) => bedrock.send(c) : null);
    this.polly = clients?.polly ?? (polly ? (c) => polly.send(c) : null);
  }

  status() {
    return {
      region: this.config.region,
      nova: { enabled: Boolean(this.bedrock), model: this.config.novaModelId },
      polly: { enabled: Boolean(this.polly), voice: this.config.pollyVoice, engine: this.config.pollyEngine },
    };
  }

  /** Per-workspace and server-wide daily caps, so a public demo cannot run up the AWS bill. */
  private spend(kind: 'plan' | 'speech', workspaceId: string, limit: number) {
    const day = new Date().toISOString().slice(0, 10);
    const k = `${kind}|${workspaceId}|${day}`;
    const g = `${kind}|*|${day}`;
    const n = (this.usage.get(k) ?? 0) + 1;
    const total = (this.usage.get(g) ?? 0) + 1;
    const label = kind === 'plan' ? 'Amazon Nova planning' : 'voice';
    if (n > limit) throw new DomainError('LIMIT_EXCEEDED', `Daily ${label} limit reached for this workspace. Try again tomorrow.`);
    if (total > this.config.dailyGlobalLimit) throw new DomainError('LIMIT_EXCEEDED', `This server has reached its daily ${label} limit. Try again tomorrow.`);
    if (this.usage.size > 5000) for (const key of this.usage.keys()) if (!key.endsWith(day)) this.usage.delete(key);
    this.usage.set(k, n);
    this.usage.set(g, total);
  }

  /** Ask Amazon Nova which operations fulfil the request, then validate every proposal. */
  async plan(workspaceId: string, request: string, adapterId = 'home-sim'): Promise<NovaPlan> {
    if (!this.bedrock) throw new DomainError('FORBIDDEN', 'Amazon Nova planning is not configured on this server.');
    this.spend('plan', workspaceId, this.config.dailyPlansPerWorkspace);

    const ops = this.registry.describe().filter((o) => o.adapterId === adapterId);
    const byTool = new Map(ops.map((o) => [toolName(o.adapterId, o.name), o]));
    const tools: Tool[] = ops.map((o) => {
      const schema = { ...(o.inputJsonSchema as Record<string, any>) };
      delete schema.$schema;
      const properties = { ...(schema.properties ?? {}), why: { type: 'string', description: 'Short quote from the request that justifies this call.' } };
      return {
        toolSpec: {
          name: toolName(o.adapterId, o.name),
          description: `${o.title}. ${o.description} Recovery: ${o.recovery.capability}.`.slice(0, 900),
          inputSchema: { json: { ...schema, type: 'object', properties, required: [...(schema.required ?? []), 'why'], additionalProperties: false } as any },
        },
      };
    });

    const started = Date.now();
    const messages: Message[] = [{ role: 'user', content: [{ text: request }] }];
    const proposals: { tool: string; input: Record<string, unknown> }[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    // Nova may return several tool calls at once or one per turn; acknowledge each as "planned" until it stops.
    for (let turn = 0; turn < 4 && proposals.length < MAX_STEPS; turn++) {
      let out: any;
      try {
        out = await this.bedrock(
          new ConverseCommand({
            modelId: this.config.novaModelId,
            system: [{ text: SYSTEM }],
            messages,
            toolConfig: { tools },
            inferenceConfig: { maxTokens: 800, temperature: 0 },
          }),
        );
      } catch (e) {
        throw new DomainError('INTERNAL', `Amazon Nova request failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      inputTokens += out.usage?.inputTokens ?? 0;
      outputTokens += out.usage?.outputTokens ?? 0;
      const content: ContentBlock[] = out.output?.message?.content ?? [];
      const uses = content.filter((c) => c.toolUse).map((c) => c.toolUse!);
      if (!uses.length) break;
      messages.push({ role: 'assistant', content });
      for (const u of uses) proposals.push({ tool: u.name ?? '', input: (u.input ?? {}) as Record<string, unknown> });
      messages.push({
        role: 'user',
        content: uses.map((u) => ({ toolResult: { toolUseId: u.toolUseId!, content: [{ text: 'Planned. It will run after planning; do not repeat it.' }] } })),
      });
      if (out.stopReason !== 'tool_use') break;
    }

    const steps: NovaPlannedStep[] = [];
    const rejected: NovaPlan['rejected'] = [];
    const seen = new Set<string>();
    for (const p of proposals.slice(0, MAX_STEPS)) {
      const op = byTool.get(p.tool);
      if (!op) {
        rejected.push({ operation: p.tool, reason: 'not a registered operation' });
        continue;
      }
      if (seen.has(op.name)) {
        rejected.push({ operation: op.name, reason: 'duplicate call' });
        continue;
      }
      const { why, ...input } = p.input;
      const parsed = this.registry.resolve(op.adapterId, op.name).inputSchema.safeParse(input);
      if (!parsed.success) {
        rejected.push({ operation: op.name, reason: `input does not match the operation schema` });
        continue;
      }
      seen.add(op.name);
      steps.push({
        adapter_id: op.adapterId,
        operation: op.name,
        input: parsed.data as Record<string, unknown>,
        depends_on: [],
        dedupe_key: op.name,
        because: typeof why === 'string' && why.trim() ? why.trim().slice(0, 160) : 'proposed by Amazon Nova',
      });
    }
    // Rewind, not the model, orders final routines last and makes them depend on every earlier step.
    steps.sort((a, b) => Number(FINAL_OPERATIONS.has(a.operation)) - Number(FINAL_OPERATIONS.has(b.operation)));
    steps.forEach((s, i) => {
      s.depends_on = FINAL_OPERATIONS.has(s.operation) ? Array.from({ length: i }, (_, k) => k + 1) : [];
    });
    return { steps, rejected, model: this.config.novaModelId, latencyMs: Date.now() - started, usage: { inputTokens, outputTokens } };
  }

  /** Synthesize Rewind's deterministic summary of an execution as MP3. */
  async speak(workspaceId: string, view: ExecutionView): Promise<Buffer> {
    return this.speakText(workspaceId, spokenSummary(view, (key) => this.registry.describe().find((o) => o.key === key)?.title ?? key));
  }

  /** Synthesize a short assistant line (confirmations, prompts). Same caps and cache as outcome reports. */
  async speakText(workspaceId: string, text: string): Promise<Buffer> {
    if (!this.polly) throw new DomainError('FORBIDDEN', 'Amazon Polly is not configured on this server.');
    const cacheKey = `${workspaceId}|${text}`;
    const hit = this.speechCache.get(cacheKey);
    if (hit) return hit;
    this.spend('speech', workspaceId, this.config.dailySpeechPerWorkspace);
    let out: any;
    try {
      out = await this.polly(
        new SynthesizeSpeechCommand({
          Text: text,
          OutputFormat: 'mp3',
          VoiceId: this.config.pollyVoice as VoiceId,
          Engine: this.config.pollyEngine as Engine,
        }),
      );
    } catch (e) {
      throw new DomainError('INTERNAL', `Amazon Polly request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const bytes: Uint8Array = await out.AudioStream.transformToByteArray();
    const buf = Buffer.from(bytes);
    this.speechCache.set(cacheKey, buf);
    if (this.speechCache.size > 200) this.speechCache.delete(this.speechCache.keys().next().value!);
    return buf;
  }
}

/** A short, plain-spoken account of what happened. Built only from recorded state. */
export function spokenSummary(v: ExecutionView, title: (operationKey: string) => string): string {
  const s = v.summary;
  const parts: string[] = [];
  const n = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`;
  const status = v.execution.status;
  if (status === 'awaiting_approval') {
    const waiting = v.actions.find((a) => a.status === 'awaiting_approval');
    parts.push(`${n(s.succeeded, 'step')} done so far. ${waiting ? title(waiting.operationKey) : 'The next step'} is waiting for a person to approve it in the Rewind console.`);
  } else if (status === 'pending' || status === 'running') {
    parts.push(`This run is still in progress: ${n(s.succeeded, 'step')} done so far.`);
  } else if (s.failedAt === null) {
    parts.push(`All ${n(s.succeeded, 'step')} completed. Nothing needed to be undone.`);
  } else {
    const failed = v.actions.find((a) => a.sequence === s.failedAt);
    parts.push(`Step ${s.failedAt}, ${failed ? title(failed.operationKey) : 'a step'}, failed, so I stopped before doing anything else.`);
    if (s.verified > 0) parts.push(`I undid ${n(s.verified, 'earlier step')} and read ${s.verified === 1 ? 'it' : 'each one'} back: ${s.verified === 1 ? 'it matches' : 'they match'} how things were before.`);
    else if (s.recoveryStatus === 'not_needed') parts.push('No earlier step had changed anything, so there was nothing to undo.');
    for (const u of s.unresolved.slice(0, 3)) {
      const what = title(u.operationKey);
      if (u.outcome === 'recovery_unavailable') parts.push(`${what} cannot be taken back. Please check it yourself.`);
      else if (u.outcome === 'manual_review') parts.push(`${what} changed since I touched it, so I left it alone for you to review.`);
      else if (u.outcome === 'recovery_failed') parts.push(`Undoing ${what} did not work. It needs your attention.`);
      else parts.push(`${what} is still waiting to be undone.`);
    }
    if (s.recoveryStatus === 'verified') parts.push('Everything is back the way it was.');
  }
  return parts.join(' ').slice(0, 1500);
}

export function awsConfigFromEnv(env: NodeJS.ProcessEnv): AwsConfig {
  const engine = env.REWIND_POLLY_ENGINE;
  return {
    region: env.REWIND_AWS_REGION?.trim() || null,
    novaModelId: env.REWIND_NOVA_MODEL_ID?.trim() || 'us.amazon.nova-lite-v1:0',
    pollyVoice: env.REWIND_POLLY_VOICE?.trim() || 'Ruth',
    pollyEngine: engine === 'generative' || engine === 'standard' ? engine : 'neural',
    dailyPlansPerWorkspace: Number(env.REWIND_NOVA_DAILY_LIMIT) || 60,
    dailySpeechPerWorkspace: Number(env.REWIND_POLLY_DAILY_LIMIT) || 60,
    dailyGlobalLimit: Number(env.REWIND_AWS_GLOBAL_DAILY_LIMIT) || 2000,
  };
}
