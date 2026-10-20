# REWIND container image for Amazon Bedrock AgentCore Runtime, which expects an MCP server at 0.0.0.0:8000/mcp.
# See docs/deploy-aws.md.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    REWIND_HOST=0.0.0.0 \
    REWIND_PORT=8000 \
    REWIND_DB_PATH=/tmp/rewind/rewind.db \
    REWIND_ENVIRONMENT=aws \
    REWIND_TRUST_UPSTREAM_AUTH=agentcore \
    REWIND_ALLOWED_HOSTS=* \
    REWIND_COOKIE_SECURE=true
COPY --from=build /app /app
USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# AgentCore Runtime authenticates callers (SigV4 or JWT) before requests reach this container, so MCP
# calls without an API key are accepted and mapped to the built-in workspace. Never expose this image directly.
CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx/esm", "src/main.ts"]
