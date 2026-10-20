# AWS features: Amazon Nova planning and Amazon Polly voice

Both are optional and both sit outside the safety path. With them off, REWIND
behaves exactly as before.

| Feature | What it does | What it never does |
| --- | --- | --- |
| **Amazon Nova** (Bedrock Converse) | Turns a natural-language request into proposed calls to registered operations. | Execute anything, decide ordering or dependencies, judge recovery. |
| **Amazon Polly** | Reads REWIND's outcome for an execution aloud. | Speak model-written text. The words come from `spokenSummary()`, built from recorded state. |

## How Nova planning stays safe

1. The agent demo posts the request to `POST /api/agent/plan` (member role).
2. REWIND sends Nova one tool per registered operation, using that operation's
   own JSON Schema plus a required `why` field. Temperature is 0.
3. Each proposal is checked: unknown tools, duplicates and inputs that fail the
   operation's Zod schema are **refused** and shown to the user as refused.
4. REWIND, not the model, orders final routines last and sets their
   dependencies.
5. The browser agent then runs the validated plan over MCP, the same path as
   every other client. Policy, approvals, compensation and read-back
   verification are unchanged.

## Turning it on

Set on the server (Render: Environment):

```
REWIND_AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=…        # from the IAM user below
AWS_SECRET_ACCESS_KEY=…
```

Optional: `REWIND_NOVA_MODEL_ID` (default `us.amazon.nova-lite-v1:0`, a
cross-region inference profile), `REWIND_POLLY_VOICE` (default `Ruth`),
`REWIND_POLLY_ENGINE` (`neural`, `generative` or `standard`).

### Least-privilege IAM policy

Create a dedicated IAM user (programmatic access only) with only this policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "NovaLiteViaInferenceProfile",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": [
        "arn:aws:bedrock:us-east-1:<ACCOUNT_ID>:inference-profile/us.amazon.nova-lite-v1:0",
        "arn:aws:bedrock:*::foundation-model/amazon.nova-lite-v1:0"
      ]
    },
    { "Sid": "Voice", "Effect": "Allow", "Action": "polly:SynthesizeSpeech", "Resource": "*" }
  ]
}
```

Converse uses `bedrock:InvokeModel`. The foundation-model ARN uses a wildcard
region because the US inference profile routes across US regions.

## Cost controls

- Per workspace per UTC day: `REWIND_NOVA_DAILY_LIMIT` and
  `REWIND_POLLY_DAILY_LIMIT` (default 60 each).
- Server-wide per UTC day: `REWIND_AWS_GLOBAL_DAILY_LIMIT` (default 2000 per
  kind).
- Voice reports are cached per execution outcome, so replaying is free.
- A plan is at most 4 model turns and 800 output tokens per turn.

Nova Lite and Polly neural voices cost fractions of a cent per demo run, and
new AWS accounts can use their free-tier credits. Set an AWS Budgets alert
anyway.
