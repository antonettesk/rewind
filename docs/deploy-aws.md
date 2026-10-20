# AWS deployment (prepared, not performed)

**Status:** not deployed. The AgentCore-compatible image and the upstream-trust mode are implemented and tested locally (`tests/mcp.test.ts`, "AgentCore mode"). The development machine has no AWS CLI or Docker CLI, and the AWS connector was not signed in, so nothing was built, pushed or invoked on AWS. Nothing in this repository claims a live AWS deployment.

## Target: Amazon Bedrock AgentCore Runtime

According to the current AgentCore developer guide ("Deploy MCP servers in AgentCore Runtime"), an MCP container must:

- serve the MCP endpoint at `0.0.0.0:8000/mcp`;
- speak Streamable HTTP. Stateless mode is recommended, and the platform adds an `Mcp-Session-Id` header when one is missing;
- sit behind inbound auth configured on the runtime (for example `CUSTOM_JWT` with a Cognito or Auth0 discovery URL), with `Authorization` allow-listed if the container needs to see it.

REWIND already matches the transport side: a stateless Streamable HTTP server at `/mcp`. The [Dockerfile](../Dockerfile) sets `REWIND_HOST=0.0.0.0` and `REWIND_PORT=8000`.

## Gaps to close before a real deployment

1. **Authentication handoff (implemented).** The image sets `REWIND_TRUST_UPSTREAM_AUTH=agentcore`: AgentCore authenticates callers (IAM SigV4 by default, or `CUSTOM_JWT`), and MCP calls that reach the container without a REWIND key are mapped to the built-in workspace. Do not allow-list `Authorization` unless you also send a REWIND key. Verifying the platform JWT inside REWIND (defence in depth) is not implemented.
2. **Host validation.** The image sets `REWIND_ALLOWED_HOSTS=*` because the container is reachable only through AgentCore. Tighten it to the observed host after a first invocation.
3. **Durability.** AgentCore sessions run in isolated, ephemeral environments, so SQLite on local disk would not persist history across sessions. Durable history needs the PostgreSQL repository (for example on Amazon RDS or Aurora). The repository port is ready; the implementation is not.
4. **Architecture.** Check the current guide for the required image architecture (it has historically been ARM64) and build with `docker buildx --platform linux/arm64` if so.
5. **Console.** AgentCore exposes the MCP invocation endpoint, not a website. The web console would be hosted separately (for example ECS/Fargate or App Runner) against the same database.

## Commands, once credentials are available

```bash
# 1. Build and smoke-test locally
docker build -t rewind:local .
docker run --rm -p 8000:8000 rewind:local
curl -s localhost:8000/api/health

# 2. Scaffold and deploy with the AgentCore CLI (see the AWS guide for current flags)
npm install -g @aws/agentcore
agentcore create --project-name RewindMcp --no-agent
#    add an MCP agent with --protocol MCP and your CUSTOM_JWT discovery URL / client id,
#    pointing the runtime at this container image
agentcore deploy
```

Verify with the MCP Inspector against `https://bedrock-agentcore.<region>.amazonaws.com/runtimes/<encoded-arn>/invocations?qualifier=DEFAULT` and a bearer token, as the AWS guide describes. Record the real ARN and results here only after they exist.
