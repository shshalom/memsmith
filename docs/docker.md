# Docker

The root `docker-compose.yml` starts MemSmith Server beta with a persistent Valkey sidecar.

```sh
docker compose up --build
curl http://127.0.0.1:37777/healthz
```

The server container uses:

- `MEMSMITH_WORKER_HOST=0.0.0.0`
- `MEMSMITH_DATA_DIR=/data/memsmith`
- `MEMSMITH_QUEUE_ENGINE=bullmq`
- `MEMSMITH_REDIS_URL=redis://valkey:6379`
- `MEMSMITH_AUTH_MODE=api-key`

Create an API key inside the container before using protected V1 write routes.
