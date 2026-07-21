#!/usr/bin/env bash
set -euo pipefail

IMAGE="${SMOKE_TEST_IMAGE:?SMOKE_TEST_IMAGE not set}"

echo "::group::Environment"
echo "Image: $IMAGE"
echo "Platform: $(uname -m)"
echo "Docker: $(docker --version 2>/dev/null || echo 'not found')"
echo "::endgroup::"

cleanup() {
  echo "::group::Cleanup"
  echo "Removing containers and network..."
  docker rm --force postgraphile-smoke postgraphile-smoke-db >/dev/null 2>&1 || true
  docker network rm postgraphile-smoke >/dev/null 2>&1 || true
  rm -f private.pem public.pem || true
  rm -rf env-vars || true
  echo "Cleanup complete."
  echo "::endgroup::"
}
trap cleanup EXIT

echo "::group::Generate ES256 key pair"
openssl ecparam -genkey -name prime256v1 | \
  openssl pkcs8 -topk8 -nocrypt -outform PEM > private.pem
openssl ec -in private.pem -pubout -outform PEM > public.pem
echo "Key pair generated."
echo "::endgroup::"

echo "::group::Create test network"
docker network create postgraphile-smoke || true
echo "Network ready."
echo "::endgroup::"

echo "::group::Start PostgreSQL"
docker run --detach --name postgraphile-smoke-db \
  --network postgraphile-smoke \
  -e POSTGRES_DB=postgraphile \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  postgres:18-alpine

echo "Waiting for PostgreSQL to be ready..."
until docker exec postgraphile-smoke-db psql -U postgres -d postgraphile \
  -c 'CREATE SCHEMA IF NOT EXISTS postgraphile'; do
  sleep 1
done
echo "PostgreSQL is ready."
echo "::endgroup::"

echo "::group::Start PostGraphile"
mkdir -p env-vars
echo "postgresql://postgres:postgres@postgraphile-smoke-db:5432/postgraphile" > env-vars/POSTGRAPHILE_CONNECTION
echo "postgresql://postgres:postgres@postgraphile-smoke-db:5432/postgraphile" > env-vars/POSTGRAPHILE_OWNER_CONNECTION
echo "true" > env-vars/TURNSTILE_BYPASS
cp private.pem env-vars/POSTGRAPHILE_JWT_SECRET_KEY
cp public.pem env-vars/POSTGRAPHILE_JWT_PUBLIC_KEY

docker run --detach --name postgraphile-smoke \
  --network postgraphile-smoke \
  --volume "$(pwd)/env-vars:/run/environment-variables:ro" \
  -p 5678:5678 \
  "$IMAGE"
echo "PostGraphile container started."
echo "::endgroup::"

echo "::group::Wait for healthy"
for i in $(seq 1 60); do
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' postgraphile-smoke)
  if [ "$STATUS" = "healthy" ]; then
    echo "Container is healthy after ${i}s"
    break
  fi
  if [ "$STATUS" = "unhealthy" ]; then
    echo "Container became unhealthy"
    docker logs postgraphile-smoke
    exit 1
  fi
  if [ "$((i % 10))" -eq 0 ]; then
    echo "Still waiting... (${i}s)"
  fi
  sleep 1
done
if [ "$STATUS" != "healthy" ]; then
  echo "Timeout waiting for healthy status"
  docker logs postgraphile-smoke
  exit 1
fi
echo "::endgroup::"

echo "::group::Smoke test GraphQL endpoint"
RESPONSE=$(curl -fsS -X POST http://localhost:5678/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ __typename }"}') || {
  echo "Request failed, container logs:"
  docker logs postgraphile-smoke
  exit 1
}
echo "Response: $RESPONSE"
echo "$RESPONSE" | jq -e '(.data.__typename // "") != "" and (.errors | not)'
echo "GraphQL endpoint OK."
echo "::endgroup::"

echo "Smoke test passed."