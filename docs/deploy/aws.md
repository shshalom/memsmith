# AWS Deployment Guide

This guide covers deploying the claude-mem server backend on AWS: RDS Postgres 16 with pgvector, a Fargate (or EC2) container daemon, and an ALB with TLS.

---

## Prerequisites

- AWS CLI configured (`aws configure`)
- An ACM certificate for your domain (or use `aws acm request-certificate`)
- Docker image for `claude-mem-server` built and pushed to ECR (or use a public image)
- A VPC with private subnets for RDS and Fargate, and public subnets for the ALB

---

## 1. RDS Postgres 16 with pgvector

### 1a. Create a parameter group that allows the `vector` extension

```bash
aws rds create-db-parameter-group \
  --db-parameter-group-name claude-mem-pg16 \
  --db-parameter-group-family postgres16 \
  --description "claude-mem pgvector parameter group"

aws rds modify-db-parameter-group \
  --db-parameter-group-name claude-mem-pg16 \
  --parameters "ParameterName=rds.allowed_extensions,ParameterValue=vector,ApplyMethod=pending-reboot"
```

> `rds.allowed_extensions` is a static parameter — the instance must be rebooted after this change before `CREATE EXTENSION vector` will succeed.

### 1b. Create the RDS instance

```bash
aws rds create-db-instance \
  --db-instance-identifier claude-mem-prod \
  --db-instance-class db.t4g.medium \
  --engine postgres \
  --engine-version 16.3 \
  --master-username cmem \
  --master-user-password YOUR_DB_PASSWORD \
  --db-name claude_mem \
  --db-parameter-group-name claude-mem-pg16 \
  --vpc-security-group-ids sg-XXXXXXXXXXXXXXXXX \
  --db-subnet-group-name your-db-subnet-group \
  --storage-type gp3 \
  --allocated-storage 50 \
  --no-publicly-accessible \
  --backup-retention-period 7
```

Wait for the instance to become available:

```bash
aws rds wait db-instance-available --db-instance-identifier claude-mem-prod
```

Retrieve the endpoint:

```bash
aws rds describe-db-instances \
  --db-instance-identifier claude-mem-prod \
  --query 'DBInstances[0].Endpoint.Address' \
  --output text
# e.g. claude-mem-prod.cabcdefghijk.us-east-1.rds.amazonaws.com
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
psql "postgresql://cmem:YOUR_DB_PASSWORD@claude-mem-prod.cabcdefghijk.us-east-1.rds.amazonaws.com:5432/claude_mem"
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
aws ecr create-repository --repository-name claude-mem-server
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin 123456789012.dkr.ecr.us-east-1.amazonaws.com

docker build -t claude-mem-server .
docker tag claude-mem-server:latest \
  123456789012.dkr.ecr.us-east-1.amazonaws.com/claude-mem-server:latest
docker push 123456789012.dkr.ecr.us-east-1.amazonaws.com/claude-mem-server:latest
```

### 2b. EFS mount for embedder model cache

The `all-MiniLM-L6-v2` model (~90 MB) is downloaded from huggingface.co on first boot and cached in the directory pointed to by `TRANSFORMERS_CACHE`. Use EFS so the download only happens once and persists across task restarts:

```bash
aws efs create-file-system \
  --performance-mode generalPurpose \
  --throughput-mode bursting \
  --tags Key=Name,Value=claude-mem-model-cache

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

```json
{
  "family": "claude-mem-server",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024",
  "memory": "2048",
  "executionRoleArn": "arn:aws:iam::123456789012:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::123456789012:role/ecsTaskRole",
  "containerDefinitions": [
    {
      "name": "claude-mem-server",
      "image": "123456789012.dkr.ecr.us-east-1.amazonaws.com/claude-mem-server:latest",
      "portMappings": [{ "containerPort": 37777, "protocol": "tcp" }],
      "environment": [
        { "name": "CLAUDE_MEM_RUNTIME",            "value": "server-beta" },
        { "name": "CLAUDE_MEM_QUEUE_ENGINE",        "value": "bullmq" },
        { "name": "CLAUDE_MEM_AUTH_MODE",           "value": "api-key" },
        { "name": "CLAUDE_MEM_SERVER_DATABASE_URL", "value": "postgresql://cmem:YOUR_DB_PASSWORD@claude-mem-prod.cabcdefghijk.us-east-1.rds.amazonaws.com:5432/claude_mem" },
        { "name": "CLAUDE_MEM_REDIS_URL",           "value": "redis://your-valkey-or-elasticache:6379" },
        { "name": "CLAUDE_MEM_GENERATION_DISABLED", "value": "true" },
        { "name": "TRANSFORMERS_CACHE",             "value": "/mnt/model-cache" },
        { "name": "CLAUDE_MEM_FTS_WEIGHT",          "value": "0.3" },
        { "name": "CLAUDE_MEM_VEC_WEIGHT",          "value": "1" },
        { "name": "CLAUDE_MEM_RRF_K",               "value": "60" }
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
          "awslogs-group": "/ecs/claude-mem-server",
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
aws ecs create-cluster --cluster-name claude-mem

aws ecs create-service \
  --cluster claude-mem \
  --service-name claude-mem-server \
  --task-definition claude-mem-server \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-PRIVATE_SUBNET],securityGroups=[sg-FARGATE_TASK_SG_ID],assignPublicIp=DISABLED}" \
  --load-balancers "targetGroupArn=arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/claude-mem/XXXXXXXXXXXXXXXX,containerName=claude-mem-server,containerPort=37777"
```

### 2e. ALB with TLS

```bash
# Create ALB
aws elbv2 create-load-balancer \
  --name claude-mem-alb \
  --subnets subnet-PUBLIC_1 subnet-PUBLIC_2 \
  --security-groups sg-ALB_SG_ID \
  --scheme internet-facing \
  --type application

# Create target group
aws elbv2 create-target-group \
  --name claude-mem \
  --protocol HTTP \
  --port 37777 \
  --vpc-id vpc-XXXXXXXXXXXXXXXXX \
  --target-type ip \
  --health-check-path /healthz

# Create HTTPS listener (ACM cert required)
aws elbv2 create-listener \
  --load-balancer-arn arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/claude-mem-alb/XXXXXXXXXXXXXXXX \
  --protocol HTTPS \
  --port 443 \
  --certificates CertificateArn=arn:aws:acm:us-east-1:123456789012:certificate/XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX \
  --ssl-policy ELBSecurityPolicy-TLS13-1-2-2021-06 \
  --default-actions Type=forward,TargetGroupArn=arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/claude-mem/XXXXXXXXXXXXXXXX
```

The ALB security group should allow inbound TCP 443 from `0.0.0.0/0`. The Fargate task security group should allow inbound TCP 37777 from the ALB security group only.

Your server endpoint is `https://claude-mem-alb-XXXXXXXXXX.us-east-1.elb.amazonaws.com` — map your DNS CNAME to this.

---

## 3. Environment Variable Reference

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_MEM_RUNTIME` | — | Must be `server-beta` in Docker/Fargate |
| `CLAUDE_MEM_QUEUE_ENGINE` | — | Must be `bullmq` when using Valkey/Redis |
| `CLAUDE_MEM_AUTH_MODE` | — | Set to `api-key` in production |
| `CLAUDE_MEM_SERVER_DATABASE_URL` | — | Postgres connection string (required) |
| `CLAUDE_MEM_REDIS_URL` | — | Valkey/Redis URL for BullMQ (required with bullmq) |
| `CLAUDE_MEM_GENERATION_DISABLED` | `false` | Set `true` on HTTP task; set `false` (or omit) on worker task |
| `CLAUDE_MEM_SERVER_PROVIDER` | — | `claude`, `gemini`, `openrouter`, or `ollama` (local, keyless) |
| `CLAUDE_MEM_OLLAMA_URL` | `http://localhost:11434/v1` | Ollama OpenAI-compatible base URL (provider=ollama) |
| `CLAUDE_MEM_OLLAMA_API_KEY` | — | Optional; only when Ollama is behind an auth proxy |
| `CLAUDE_MEM_REFORMAT_RETRIES` | `1` | Bounded (0–3) re-prompts on malformed generation output; `0` disables. Applies to all providers. |
| `ANTHROPIC_API_KEY` | — | Worker only (when provider=claude) |
| `TRANSFORMERS_CACHE` | OS temp | Writable dir for `all-MiniLM-L6-v2` model cache |
| `CLAUDE_MEM_SEARCH_HYBRID` | `on` | `/v1/search` and `/v1/context` rank with hybrid (FTS+vector RRF) by default. Set `0` to force plain FTS — useful if the embedder is unavailable. Hybrid already degrades to FTS automatically when the vector arm fails, so `0` is a policy switch, not a failure mitigation. |
| `CLAUDE_MEM_FTS_WEIGHT` | `0.3` | Weight of full-text search component in hybrid RRF retrieval |
| `CLAUDE_MEM_VEC_WEIGHT` | `1` | Weight of vector similarity component in hybrid RRF retrieval |
| `CLAUDE_MEM_RRF_K` | `60` | RRF rank fusion constant |
| `CLAUDE_MEM_QUERY_EXPANSION` | `off` | Enable deterministic (no-LLM) query expansion before hybrid search |
| `CLAUDE_MEM_TEAM_INJECT` | `off` | Opt-in cross-team memory injection at SessionStart. **Follow-up:** the live fetch is not yet wired (worker vs server-mode bridge); enabling it is currently a no-op. |
| `CLAUDE_MEM_SUPERSEDE_MAX_DEPTH` | `16` | Max supersession-chain walk depth (clamped 1–256); bounds the forward walk and guards malformed cycles when resolving superseded observations. |
| `CLAUDE_MEM_INPUT_RATE_PER_MTOK` | `5` | Input $/million-tokens rate used by the dashboard cost panel to estimate USD |
| `CLAUDE_MEM_GATE_TOOLS` | `Grep,Read,Glob,WebSearch` | Tools that would trigger the PreToolUse discovery gate. **Follow-up:** Grep/Glob/WebSearch gating is not yet wired in `hooks.json` (only `Read` fires today); this var is reserved for that follow-up. |

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
