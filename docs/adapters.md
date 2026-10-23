# Writing an adapter

An adapter is the only way Rewind touches the outside world. It is a TypeScript object implementing `Adapter` from [src/adapters/types.ts](../src/adapters/types.ts), registered in [src/services/app.ts](../src/services/app.ts).

## The contract

```ts
interface Adapter {
  id: string;                 // kebab-case, unique
  name: string;
  type: 'local-simulation' | 'http' | 'database' | 'saas';
  version: string;
  description: string;
  disclosure: string;         // shown verbatim in the console, e.g. "Writes to the production CRM."
  operations: OperationDefinition[];
  health(): Promise<AdapterHealth>;   // a real check against the backing system
}

interface OperationDefinition<I, O> {
  name: string;               // e.g. "contact.set_owner"
  title: string; description: string;
  kind: 'read' | 'mutation';
  inputSchema: ZodType<I>;    // strict; validated before anything is stored
  permissions: string[];      // least-privilege labels, shown in the registry
  recovery: {
    capability: 'compensatable' | 'rollback' | 'irreversible' | 'none';
    idempotentCompensation: boolean;  // gates recovery retries
    summary: string;                  // human explanation, shown in the console
  };
  timeoutMs: number;          // 1–60000
  resource(input): { type, id };      // what this call touches (snapshots + leases)
  read(ref, signal): Promise<{ version: number; data: object }>;
  execute(input, ctx): Promise<O>;
  writtenVersion?(result: O): number | undefined;      // version produced by this write
  expectedAfter?(before, input): object;                // enables timeout reconciliation
  compensate?({ input, before, after, writtenVersion, signal }): Promise<void>;
  restorationView?(state): object;                      // what "restored" compares (default: data)
}
```

## Rules enforced at registration (`validateAdapter`)

- Reads declare `capability: "none"`. Mutations must declare something else.
- `compensatable` and `rollback` require a `compensate` handler. `irreversible` must not have one.
- Names are validated; duplicates are rejected; timeouts are bounded.

## Writing a good compensation

1. **Compare-and-set.** Write only if the resource is still at `writtenVersion`. Otherwise throw `new AdapterError('STATE_CONFLICT', message, 'none')`. Rewind also checks this before calling you, but only you can close the race atomically.
2. **Restore business state, not history.** Write `before.data` (or the subset you own) back as a new version.
3. **Classify errors.** Throw `AdapterError(code, message, effect, retryable)`:
   - `effect: 'none'` when nothing changed. Retrying is then safe even for non-idempotent compensations.
   - `effect: 'unknown'` when you cannot tell. Any other thrown error is treated as unknown.
4. **Be idempotent if you can,** and say so with `idempotentCompensation: true`. People can then retry recovery safely.
5. **Report what you wrote.** Return the new version from `execute` and implement `writtenVersion`.
6. **Implement `expectedAfter`** so that a timeout can be reconciled by read-back instead of going to manual review.

## Example

The demo adapter [src/adapters/home-sim/adapter.ts](../src/adapters/home-sim/adapter.ts) implements all of the above against a SQLite-backed store with compare-and-set writes ([store.ts](../src/adapters/home-sim/store.ts)), plus deterministic fault injection:

| Fault mode | Effect |
|---|---|
| `error` | The forward call fails, `effect: none`. |
| `transient` | The forward call fails once, `effect: none`, `retryable`. |
| `timeout` | The write lands, then the call hangs past its timeout (unknown outcome). |
| `drift` | Another "household member" changes the resource right after Rewind's write. |
| `compensation_error` | The compensation is rejected, `effect: none`. |
| `silent_compensation_failure` | The compensation "succeeds" but writes the wrong state. Verification catches it. |

## Testing an adapter

Add an integration test that runs a plan through `app.engine`, arms a fault, and asserts on state read back from your backing system, not only on engine return values.
