# AWS Deployment Guide

This guide covers deploying the memsmith server backend on AWS: RDS Postgres 16 with pgvector, a Fargate (or EC2) container daemon, and an ALB with TLS.

---

## Prerequisites

- AWS CLI configured (`aws configure`)
- An ACM certificate for your domain (or use `aws acm request-certificate`)
- Docker image for `memsmith-server` built and pushed to ECR (or use a public image)
- A VPC with private subnets for RDS and Fargate, and public subnets for the ALB

---

## 1. RDS Postgres 16 with pgvector

### 1a. Create a parameter group that allows the `vector` extension

```bash
aws rds create-db-parameter-group \
  --db-parameter-group-name memsmith-pg16 \
  --db-parameter-group-family postgres16 \
  --description "memsmith pgvector parameter group"

aws rds modify-db-parameter-group \
  --db-parameter-group-name memsmith-pg16 \
  --parameters "ParameterName=rds.allowed_extensions,ParameterValue=vector,ApplyMethod=pending-reboot"
```

> `rds.allowed_extensions` is a static parameter — the instance must be rebooted after this change before `CREATE EXTENSION vector` will succeed.

### 1b. Create the RDS instance

```bash
aws rds create-db-instance \
  --db-instance-identifier memsmith-prod \
  --db-instance-class db.t4g.medium \
  --engine postgres \
  --engine-version 16.3 \
  --master-username cmem \
  --master-user-password YOUR_DB_PASSWORD \
  --db-name memsmith \
  --db-parameter-group-name memsmith-pg16 \
  --vpc-security-group-ids sg-XXXXXXXXXXXXXXXXX \
  --db-subnet-group-name your-db-subnet-group \
  --storage-type gp3 \
  --allocated-storage 50 \
  --no-publicly-accessible \
  --backup-retention-period 7
```

Wait for the instance to become available:

```bash
aws rds wait db-instance-available --db-instance-identifier memsmith-prod
```

Retrieve the endpoint:

```bash
aws rds describe-db-instances \
  --db-instance-identifier memsmith-prod \
  --query 'DBInstances[0].Endpoint.Address' \
  --output text
# e.g. memsmith-prod.cabcdefghijk.us-east-1.rds.amazonaws.com
```

### 1c. Security group

The RDS security group should allow inbound TCP 5432 only from the Fargate task security group. No public access is needed.

```bash
aws ec2 authorize-security-group-ingress \
  --group-id sg-RDS_SG_ID \
  --protocol tcp \
  --port 5432 \
  --source-group sg-FARGATE_TASK_SG_ID
```

### 1d. How bootstrap applies migrations

On first server connect, `bootstrapServerPostgresSchema` runs automatically. It:

1. Creates base tables (`api_keys`, `events`, `observations`, `sessions`, etc.).
2. Applies **migration 002** idempotently: adds `obs_type`, `lifecycle_state`, `supersedes`, `quality` columns to `observations`.
3. Applies **migration 003**: installs pgvector and adds the vector column + HNSW index:
   - `CREATE EXTENSION IF NOT EXISTS vector` — runs **outside** any transaction because DDL for extensions cannot be transactional in Postgres.
   - `ALTER TABLE observations ADD COLUMN embedding_vec vector(384)`
   - `CREATE INDEX CONCURRENTLY observations_embedding_vec_hnsw_idx ON observations USING hnsw (embedding_vec vector_cosine_ops)`

All migrations are guarded by existence checks so re-running the server on an already-initialized database is safe.

### 1e. Verify

Connect to the RDS instance from a bastion host or via RDS Proxy:

```bash
psql "postgresql://cmem:YOUR_DB_PASSWORD@memsmith-prod.cabcdefghijk.us-east-1.rds.amazonaws.com:5432/memsmith"
```

```sql
-- Confirm pgvector is installed
SELECT * FROM pg_extension WHERE extname = 'vector';
--  extname | ...
-- ---------+-----
--  vector  | ...

-- Confirm the embedding column exists
\d observations
-- Column list should include:
--   embedding_vec | vector(384) | ...
```

---

## 2. Server Daemon on Fargate (behind ALB + TLS)

### 2a. ECR image

```bash
aws ecr create-repository --repository-name memsmith-server
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin 123456789012.dkr.ecr.us-east-1.amazonaws.com

docker build -t memsmith-server .
docker tag memsmith-server:latest \
  123456789012.dkr.ecr.us-east-1.amazonaws.com/memsmith-server:latest
docker push 123456789012.dkr.ecr.us-east-1.amazonaws.com/memsmith-server:latest
```

### 2b. EFS mount for embedder model cache

The `all-MiniLM-L6-v2` model (~90 MB) is downloaded from huggingface.co on first boot and cached in the directory pointed to by `TRANSFORMERS_CACHE`. Use EFS so the download only happens once and persists across task restarts:

```bash
aws efs create-file-system \
  --performance-mode generalPurpose \
  --throughput-mode bursting \
  --tags Key=Name,Value=memsmith-model-cache

aws efs create-mount-target \
  --file-system-id fs-XXXXXXXXXXXXXXXXX \
  --subnet-id subnet-PRIVATE_SUBNET \
  --security-groups sg-EFS_SG_ID
```

Mount point in the task definition: `/mnt/model-cache`
Set `TRANSFORMERS_CACHE=/mnt/model-cache` in the task environment.

On first run the task needs **outbound HTTPS (port 443) to huggingface.co** to download the model. Ensure the Fargate task's security group allows egress 0.0.0.0/0:443, or open specifically to `huggingface.co` via a NAT gateway.

### 2c. Fargate task definition

Save as `task-def.json`:

**The database URL must not be inlined here.** A value in `environment` is
plaintext in the task definition and readable by anyone with
`ecs:DescribeTaskDefinition`. Put it in Secrets Manager and reference it from
`secrets` — ECS resolves `valueFrom` at task start and injects it as an ordinary
environment variable, so the application sees exactly what it would have seen
either way. No code change is required.

Create the secret and grant access first:

```bash
aws secretsmanager create-secret \
  --name memsmith/db-url \
  --secret-string 'postgresql://cmem:YOUR_DB_PASSWORD@memsmith-prod.abcdefghijk.us-east-1.rds.amazonaws.com:5432/memsmith'
```

The grant goes on the **task execution role** (the role ECS itself uses to start
the task), not the task role — a common mix-up that surfaces as
`ResourceInitializationError` at startup:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["secretsmanager:GetSecretValue"],
    "Resource": "arn:aws:secretsmanager:us-east-1:ACCOUNT_ID:secret:memsmith/db-url-*"
  }]
}
```

Rotation is deliberately out of scope: env-var injection is the smallest change
that removes the plaintext password, and rotation can be added later without
touching application code.

```json
{
  "family": "memsmith-server",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024",
  "memory": "2048",
  "executionRoleArn": "arn:aws:iam::123456789012:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::123456789012:role/ecsTaskRole",
  "containerDefinitions": [
    {
      "name": "memsmith-server",
      "image": "123456789012.dkr.ecr.us-east-1.amazonaws.com/memsmith-server:latest",
      "portMappings": [{ "containerPort": 37777, "protocol": "tcp" }],
      "environment": [
        { "name": "MEMSMITH_RUNTIME",            "value": "server-beta" },
        { "name": "MEMSMITH_QUEUE_ENGINE",        "value": "bullmq" },
        { "name": "MEMSMITH_AUTH_MODE",           "value": "api-key" },
        { "name": "MEMSMITH_REDIS_URL",           "value": "redis://your-valkey-or-elasticache:6379" },
        { "name": "MEMSMITH_GENERATION_DISABLED", "value": "true" },
        { "name": "TRANSFORMERS_CACHE",             "value": "/mnt/model-cache" },
        { "name": "MEMSMITH_FTS_WEIGHT",          "value": "0.3" },
        { "name": "MEMSMITH_VEC_WEIGHT",          "value": "1" },
        { "name": "MEMSMITH_RRF_K",               "value": "60" }
      ],
      "secrets": [
        {
          "name": "MEMSMITH_SERVER_DATABASE_URL",
          "valueFrom": "arn:aws:secretsmanager:us-east-1:ACCOUNT_ID:secret:memsmith/db-url"
        }
      ],
      "mountPoints": [
        {
          "sourceVolume": "model-cache",
          "containerPath": "/mnt/model-cache",
          "readOnly": false
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/memsmith-server",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ],
  "volumes": [
    {
      "name": "model-cache",
      "efsVolumeConfiguration": {
        "fileSystemId": "fs-XXXXXXXXXXXXXXXXX",
        "rootDirectory": "/model-cache",
        "transitEncryptionEnabled": "ENABLED"
      }
    }
  ]
}
```

Register the task definition:

```bash
aws ecs register-task-definition --cli-input-json file://task-def.json
```

### 2d. ECS cluster and service

```bash
aws ecs create-cluster --cluster-name memsmith

aws ecs create-service \
  --cluster memsmith \
  --service-name memsmith-server \
  --task-definition memsmith-server \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-PRIVATE_SUBNET],securityGroups=[sg-FARGATE_TASK_SG_ID],assignPublicIp=DISABLED}" \
  --load-balancers "targetGroupArn=arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/memsmith/XXXXXXXXXXXXXXXX,containerName=memsmith-server,containerPort=37777"
```

### 2e. ALB with TLS

```bash
# Create ALB
aws elbv2 create-load-balancer \
  --name memsmith-alb \
  --subnets subnet-PUBLIC_1 subnet-PUBLIC_2 \
  --security-groups sg-ALB_SG_ID \
  --scheme internet-facing \
  --type application

# Create target group
aws elbv2 create-target-group \
  --name memsmith \
  --protocol HTTP \
  --port 37777 \
  --vpc-id vpc-XXXXXXXXXXXXXXXXX \
  --target-type ip \
  --health-check-path /healthz

# Create HTTPS listener (ACM cert required)
aws elbv2 create-listener \
  --load-balancer-arn arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/memsmith-alb/XXXXXXXXXXXXXXXX \
  --protocol HTTPS \
  --port 443 \
  --certificates CertificateArn=arn:aws:acm:us-east-1:123456789012:certificate/XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX \
  --ssl-policy ELBSecurityPolicy-TLS13-1-2-2021-06 \
  --default-actions Type=forward,TargetGroupArn=arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/memsmith/XXXXXXXXXXXXXXXX
```

The ALB security group should allow inbound TCP 443 from `0.0.0.0/0`. The Fargate task security group should allow inbound TCP 37777 from the ALB security group only.

Your server endpoint is `https://memsmith-alb-XXXXXXXXXX.us-east-1.elb.amazonaws.com` — map your DNS CNAME to this.

### 2f. Set the team's server URL explicitly — do NOT let it be derived

**This is the one AWS-specific footgun in the whole deployment.** Your API is now on
the ALB hostname above. Your database is on a *completely different* hostname (RDS).
Those two facts are the problem.

`deriveServerUrl` (`src/server/convert/convert-context.ts:25-32`) computes a server
URL from a database URL when nothing better is available, and for any non-localhost
host it returns `https://<database-host>` — dropping the port and keeping the *database*
hostname:

```
postgres://cmem:pw@memsmith-prod.abc123.us-east-1.rds.amazonaws.com:5432/memsmith
  ->  https://memsmith-prod.abc123.us-east-1.rds.amazonaws.com     # WRONG: that's RDS
```

Nothing serves `/v1` there. A convert run that falls back to this will write a marker
pointing at the database host, and every subsequent request from that project fails.

**There is currently NO supported override, and that is a real gap — not a
configuration step you can work around.** Verified in the code:

- `deriveServerUrl`'s first branch returns an `existingServerUrl` argument verbatim,
  which would be exactly the right escape hatch.
- But its only consumer, `makeResolveConvertContext` (`convert-context.ts:34`), has
  **zero call sites**.
- And the live convert path calls `deriveServerUrl(input.databaseUrl)` with **one
  argument** (`ServerV1PostgresRoutes.ts:1866`), so branch 1 is unreachable.
- `MEMSMITH_SERVER_URL` exists as a setting but is **not** wired into this path. It
  feeds the hook/client transports, not convert's URL derivation.

**What this means for an AWS deployment:** running the owner's convert against RDS will
stamp a marker pointing at the RDS hostname, and that project's requests will fail
until the marker is corrected by hand. Editing `.memsmith/project.json`'s `serverUrl`
after the convert is the current manual remedy.

**Who is affected:**

| Path | Exposed? |
|---|---|
| Owner's **convert** (`ServerV1PostgresRoutes.ts:1866`) | **Yes** — always passes a `postgres://` URL |
| Retained `postgres://` **join fallback** (`join-service.ts:201`) | **Yes** |
| **HTTPS join** (the new path) | **No** — uses the invite URL verbatim, never calls `deriveServerUrl` |

So teammates joining over HTTPS are safe; the owner converting is not.

The exact behaviour of all three branches, including this hazard, is pinned in
`tests/server/convert/derive-server-url-production.test.ts`.

---

## 3. Environment Variable Reference

| Variable | Default | Purpose |
|---|---|---|
| `MEMSMITH_RUNTIME` | — | Must be `server-beta` in Docker/Fargate |
| `MEMSMITH_QUEUE_ENGINE` | — | Must be `bullmq` when using Valkey/Redis |
| `MEMSMITH_AUTH_MODE` | — | Set to `api-key` in production |
| `MEMSMITH_SERVER_DATABASE_URL` | — | Postgres connection string (required). In AWS, inject from Secrets Manager via the task definition's `secrets`/`valueFrom` — never inline it in `environment`. |
| `MEMSMITH_REDIS_URL` | — | Valkey/Redis URL for BullMQ (required with bullmq) |
| `MEMSMITH_GENERATION_DISABLED` | `false` | Set `true` on HTTP task; set `false` (or omit) on worker task |
| `MEMSMITH_SERVER_PROVIDER` | — | `claude`, `gemini`, `openrouter`, or `ollama` (local, keyless) |
| `MEMSMITH_OLLAMA_URL` | `http://localhost:11434/v1` | Ollama OpenAI-compatible base URL (provider=ollama) |
| `MEMSMITH_OLLAMA_API_KEY` | — | Optional; only when Ollama is behind an auth proxy |
| `MEMSMITH_REFORMAT_RETRIES` | `1` | Bounded (0–3) re-prompts on malformed generation output; `0` disables. Applies to all providers. |
| `ANTHROPIC_API_KEY` | — | Worker only (when provider=claude) |
| `TRANSFORMERS_CACHE` | OS temp | Writable dir for `all-MiniLM-L6-v2` model cache |
| `MEMSMITH_SEARCH_HYBRID` | `on` | `/v1/search` and `/v1/context` rank with hybrid (FTS+vector RRF) by default. Set `0` to force plain FTS — useful if the embedder is unavailable. Hybrid already degrades to FTS automatically when the vector arm fails, so `0` is a policy switch, not a failure mitigation. |
| `MEMSMITH_FTS_WEIGHT` | `0.3` | Weight of full-text search component in hybrid RRF retrieval |
| `MEMSMITH_VEC_WEIGHT` | `1` | Weight of vector similarity component in hybrid RRF retrieval |
| `MEMSMITH_RRF_K` | `60` | RRF rank fusion constant |
| `MEMSMITH_QUERY_EXPANSION` | `off` | Enable deterministic (no-LLM) query expansion before hybrid search |
| `MEMSMITH_TIERING` | `on` | SessionStart/discovery-gate memory injection renders lower-ranked observations at reduced detail (L0 title → L1 +facts → L2 +why → L3 full) to fit more signal into the char budget instead of dropping whole items. Deterministic, no LLM. Set `0`/`off` to restore whole-item-drop. |
| `MEMSMITH_TEAM_INJECT` | `off` | Master opt-in for team-memory injection. When `true` **and** `MEMSMITH_TEAM_SERVER_URL` + `MEMSMITH_TEAM_API_KEY` are set, the worker bridges to the server's scoped `/v1/search` (hybrid RRF + L0–L3 tiering) at **both** SessionStart **and** per-prompt (`UserPromptSubmit`, query = the prompt text). Off (or missing url/key) → per-prompt falls back to the worker SQLite `/api/context/semantic` path and SessionStart injects nothing extra. Any missing piece disables the server path; never breaks the hook. |
| `MEMSMITH_TEAM_SERVER_URL` | — | Server base URL the worker calls for team memory (with `MEMSMITH_TEAM_INJECT=true` + `MEMSMITH_TEAM_API_KEY`). |
| `MEMSMITH_TEAM_API_KEY` | — | Scoped read key (`memories:read`) for the team-memory bridge. Bearer header only; never in URL/logs. |
| `MEMSMITH_SUPERSEDE_MAX_DEPTH` | `16` | Max supersession-chain walk depth (clamped 1–256); bounds the forward walk and guards malformed cycles when resolving superseded observations. |
| `MEMSMITH_INPUT_RATE_PER_MTOK` | `5` | Input $/million-tokens rate used by the dashboard cost panel to estimate USD |
| `MEMSMITH_REDISCOVERY_LOG` | `false` | Opt-in: log (Layer-C signal) when memory already held an answer for a discovery-tool query. Runs in the install-active observation path, so it is **off by default** (safe-by-default); a team can set `true` server-side to surface the re-discovery metric. |
| `MEMSMITH_GATE_TOOLS` | `Grep,Read,Glob,WebSearch` | Tools that would trigger the PreToolUse discovery gate. **Follow-up:** Grep/Glob/WebSearch gating is not yet wired in `hooks.json` (only `Read` fires today); this var is reserved for that follow-up. |

---

## 4. Smoke Test

After the service is healthy (`/healthz` returns 200), run these steps against your ALB endpoint.

### 4a. Mint an API key

```bash
curl -s -X POST https://mem.example.com/v1/keys \
  -H "Authorization: Bearer YOUR_WRITE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "smoke-test",
    "teamId": "team-acme",
    "projectId": "proj-smoke",
    "scopes": ["memories:read", "memories:write"]
  }'
# Returns: { "key": "cmem_...", "id": "...", ... }
# The raw key is shown ONCE — save it immediately.
```

### 4b. Ingest an observation

```bash
export CMEM_KEY="cmem_YOUR_RAW_KEY_HERE"

curl -s -X POST https://mem.example.com/v1/observations \
  -H "Authorization: Bearer $CMEM_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Smoke test: pgvector deployment verified",
    "content": "The AWS Fargate deployment successfully bootstrapped RDS Postgres 16 with pgvector 0.8.4. Migration 003 applied the HNSW index on embedding_vec(384).",
    "teamId": "team-acme",
    "projectId": "proj-smoke"
  }'
# Returns: { "id": "obs_...", ... }
```

### 4c. Recall via hybridSearch

```bash
curl -s -X POST https://mem.example.com/v1/search \
  -H "Authorization: Bearer $CMEM_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "pgvector deployment Fargate",
    "teamId": "team-acme",
    "projectId": "proj-smoke",
    "limit": 5
  }'
# The smoke-test observation should appear in the top results.
```

### 4d. Retrieve the MCP connect command

```bash
curl -s https://mem.example.com/v1/connect \
  -H "Authorization: Bearer $CMEM_KEY"
# Returns the paste-ready MCP config block for claude_desktop_config.json
```
