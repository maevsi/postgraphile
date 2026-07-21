#!/usr/bin/env bash
set -euo pipefail

IMAGE="${SMOKE_TEST_IMAGE:?SMOKE_TEST_IMAGE not set}"
ENV_DIR=""
SUFFIX="${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-1}"
CONTAINER="smoke-${SUFFIX}"
CONTAINER_DB="smoke-db-${SUFFIX}"
NETWORK="smoke-${SUFFIX}"

echo "::group::Environment"
echo "Image: $IMAGE"
echo "Platform: $(uname -m)"
echo "Docker: $(docker --version 2>/dev/null || echo 'not found')"
echo "Suffix: $SUFFIX"
echo "::endgroup::"

cleanup() {
  echo "::group::Cleanup"
  echo "Removing containers and network..."
  docker rm --force "$CONTAINER" "$CONTAINER_DB" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -f private.pem public.pem || true
  if [ -n "${ENV_DIR:-}" ]; then
    rm -rf "$ENV_DIR" || true
  fi
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
docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK"
echo "Network ready."
echo "::endgroup::"

echo "::group::Start PostgreSQL"
docker run --detach --name "$CONTAINER_DB" \
  --network "$NETWORK" \
  -e POSTGRES_DB=postgraphile \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  postgres:18-alpine

echo "Waiting for PostgreSQL to be ready..."
until docker exec "$CONTAINER_DB" psql -U postgres -d postgraphile \
  -c 'CREATE SCHEMA IF NOT EXISTS postgraphile'; do
  sleep 1
done
echo "PostgreSQL is ready."
echo "::endgroup::"

echo "::group::Start"
ENV_DIR="$(mktemp -d -p "$(pwd)" smoke-env.XXXXXX)"
echo "postgresql://postgres:postgres@${CONTAINER_DB}:5432/postgraphile" > "$ENV_DIR/POSTGRAPHILE_CONNECTION"
echo "postgresql://postgres:postgres@${CONTAINER_DB}:5432/postgraphile" > "$ENV_DIR/POSTGRAPHILE_OWNER_CONNECTION"
echo "true" > "$ENV_DIR/TURNSTILE_BYPASS"
cp private.pem "$ENV_DIR/POSTGRAPHILE_JWT_SECRET_KEY"
cp public.pem "$ENV_DIR/POSTGRAPHILE_JWT_PUBLIC_KEY"

docker run --detach --name "$CONTAINER" \
  --network "$NETWORK" \
  --volume "$ENV_DIR:/run/environment-variables:ro" \
  -p 0:5678 \
  "$IMAGE"
echo "Container started."
echo "::endgroup::"

HOST_PORT="$(docker port "$CONTAINER" 5678/tcp | head -1 | awk -F: '{print $NF}')"
if [ -z "$HOST_PORT" ]; then
  echo "Failed to determine host port for container"
  docker logs "$CONTAINER"
  exit 1
fi

echo "::group::Wait for healthy"
for i in $(seq 1 60); do
  if ! STATUS=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$CONTAINER"); then
    echo "Failed to inspect container health status"
    docker logs "$CONTAINER"
    exit 1
  fi
  if [ "$STATUS" = "no-healthcheck" ]; then
    echo "Image does not define a Docker HEALTHCHECK"
    docker logs "$CONTAINER"
    exit 1
  fi
  if [ "$STATUS" = "healthy" ]; then
    echo "Container is healthy after ${i}s"
    break
  fi
  if [ "$STATUS" = "unhealthy" ]; then
    echo "Container became unhealthy"
    docker logs "$CONTAINER"
    exit 1
  fi
  if [ "$((i % 10))" -eq 0 ]; then
    echo "Still waiting... (${i}s)"
  fi
  sleep 1
done
if [ "$STATUS" != "healthy" ]; then
  echo "Timeout waiting for healthy status"
  docker logs "$CONTAINER"
  exit 1
fi
echo "::endgroup::"

echo "::group::Smoke test"
RESPONSE=$(curl -fsS --max-time 10 -X POST "http://localhost:${HOST_PORT}/graphql" \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ __typename }"}') || {
  echo "Request failed, container logs:"
  docker logs "$CONTAINER"
  exit 1
}
echo "Response: $RESPONSE"
echo "$RESPONSE" | jq -e '(.data.__typename // "") != "" and (.errors | not)' || {
  echo "Response assertion failed, container logs:"
  docker logs "$CONTAINER"
  exit 1
}
echo "Smoke test OK."
echo "::endgroup::"

echo "::group::Container logs"
docker logs "$CONTAINER"
echo "::endgroup::"

echo "Smoke test passed."
