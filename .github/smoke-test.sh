#!/usr/bin/env bash
set -euo pipefail

IMAGE="${SMOKE_TEST_IMAGE:?SMOKE_TEST_IMAGE not set}"
SUFFIX="${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-1}"
CONTAINER_JWT="smoke-jwt-${SUFFIX}"
CONTAINER_PLAIN="smoke-plain-${SUFFIX}"
CONTAINER_DB="smoke-db-${SUFFIX}"
NETWORK="smoke-${SUFFIX}"
SCHEMA_NAME="smoke_test"
CONNECTION="postgresql://postgres:postgres@${CONTAINER_DB}:5432/postgraphile"
ENV_DIR_JWT=""
ENV_DIR_PLAIN=""

echo "::group::Environment"
echo "Image: $IMAGE"
echo "Platform: $(uname -m)"
echo "Docker: $(docker --version 2>/dev/null || echo 'not found')"
echo "Suffix: $SUFFIX"
echo "::endgroup::"

cleanup() {
  echo "::group::Cleanup"
  echo "Removing containers and network..."
  docker rm --force "$CONTAINER_JWT" "$CONTAINER_PLAIN" "$CONTAINER_DB" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -f private.pem public.pem || true
  for env_dir in "$ENV_DIR_JWT" "$ENV_DIR_PLAIN"; do
    if [ -n "$env_dir" ]; then
      rm -rf "$env_dir" || true
    fi
  done
  echo "Cleanup complete."
  echo "::endgroup::"
}
trap cleanup EXIT

fail() {
  local container="$1"
  echo "Assertion failed, container logs:"
  docker logs "$container"
  exit 1
}

start_container() {
  local name="$1"
  local env_dir="$2"
  local port="$3"
  shift 3
  docker run --detach --name "$name" \
    --network "$NETWORK" \
    --volume "$env_dir:/run/environment-variables:ro" \
    -p 0:"$port" \
    "$@" \
    "$IMAGE"
}

host_port() {
  local name="$1"
  local port="$2"
  local mapped
  if ! mapped="$(docker port "$name" "$port"/tcp | head -1 | awk -F: '{print $NF}')"; then
    echo "Failed to determine host port for container"
    docker logs "$name"
    exit 1
  fi
  if [ -z "$mapped" ]; then
    echo "Failed to determine host port for container"
    docker logs "$name"
    exit 1
  fi
  echo "$mapped"
}

wait_healthy() {
  local name="$1"
  local status
  for i in $(seq 1 60); do
    if ! status="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$name")"; then
      echo "Failed to inspect container health status"
      docker logs "$name"
      exit 1
    fi
    if [ "$status" = "no-healthcheck" ]; then
      echo "Image does not define a Docker HEALTHCHECK"
      docker logs "$name"
      exit 1
    fi
    if [ "$status" = "healthy" ]; then
      echo "Container is healthy after ${i}s"
      return 0
    fi
    if [ "$status" = "unhealthy" ]; then
      echo "Container became unhealthy"
      docker logs "$name"
      exit 1
    fi
    if [ "$((i % 10))" -eq 0 ]; then
      echo "Still waiting... (${i}s)"
    fi
    sleep 1
  done
  echo "Timeout waiting for healthy status"
  docker logs "$name"
  exit 1
}

graphql_query() {
  local port="$1"
  local body="$2"
  shift 2
  curl -fsS --max-time 10 -X POST "http://localhost:${port}/graphql" \
    -H 'Content-Type: application/json' \
    "$@" \
    -d "$body"
}

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
# pg_isready alone is not enough: the official postgres image briefly accepts
# connections on a temporary server (used to run init scripts and create
# POSTGRES_DB) before stopping and starting the final server. Querying the
# actual database catches that race instead of just checking the socket.
for i in $(seq 1 60); do
  if docker exec "$CONTAINER_DB" psql -U postgres -d postgraphile -c 'SELECT 1' >/dev/null 2>&1; then
    echo "PostgreSQL is ready after ${i}s"
    break
  fi
  sleep 1
done
if ! docker exec "$CONTAINER_DB" psql -U postgres -d postgraphile -c 'SELECT 1' >/dev/null 2>&1; then
  echo "Timeout waiting for PostgreSQL to be ready"
  docker logs "$CONTAINER_DB"
  exit 1
fi
echo "::endgroup::"

echo "::group::Set up database schema"
# A minimal stand-in schema, just enough for the smoke test:
# `account` is readable by `smoke_role`, `secret` is not, so the test can
# prove that POSTGRAPHILE_DEFAULT_ROLE is applied.
# `account` also carries the '@turnstileProtected' tag, so its mutations are
# covered by the Turnstile assertions.
docker exec "$CONTAINER_DB" psql -U postgres -d postgraphile -c '
  CREATE SCHEMA smoke_test;
  CREATE TABLE smoke_test.account (id serial PRIMARY KEY);
  INSERT INTO smoke_test.account DEFAULT VALUES;
  CREATE TABLE smoke_test.secret (id serial PRIMARY KEY);
  INSERT INTO smoke_test.secret DEFAULT VALUES;
  COMMENT ON TABLE smoke_test.account IS $$@turnstileProtected$$;
  CREATE ROLE smoke_role NOLOGIN;
  GRANT USAGE ON SCHEMA smoke_test TO smoke_role;
  GRANT SELECT ON smoke_test.account TO smoke_role;
'
echo "Schema ready."
echo "::endgroup::"

echo "::group::Run 1: JWT authentication and Turnstile enabled"
ENV_DIR_JWT="$(mktemp -d -p "$(pwd)" smoke-jwt.XXXXXX)"
chmod 755 "$ENV_DIR_JWT"

echo "$CONNECTION" > "$ENV_DIR_JWT/POSTGRAPHILE_CONNECTION"
echo "$CONNECTION" > "$ENV_DIR_JWT/POSTGRAPHILE_OWNER_CONNECTION"
echo "$SCHEMA_NAME" > "$ENV_DIR_JWT/POSTGRAPHILE_SCHEMA"
# Cloudflare's documented "always fails" test secret.
# Running with a real secret rather than TURNSTILE_BYPASS is what keeps the verification path covered at all; the token check below rejects before any call to Cloudflare is made, so this needs no network egress.
echo "2x0000000000000000000000000000000AA" > "$ENV_DIR_JWT/TURNSTILE_SECRET_KEY"
cp private.pem "$ENV_DIR_JWT/POSTGRAPHILE_JWT_SECRET_KEY"
cp public.pem "$ENV_DIR_JWT/POSTGRAPHILE_JWT_PUBLIC_KEY"

start_container "$CONTAINER_JWT" "$ENV_DIR_JWT" 5678
HOST_PORT_JWT="$(host_port "$CONTAINER_JWT" 5678)"
wait_healthy "$CONTAINER_JWT"

RESPONSE="$(graphql_query "$HOST_PORT_JWT" '{"query":"query health { __schema { queryType { name } } }"}')"
echo "Introspection: $RESPONSE"
echo "$RESPONSE" | jq -e '.data.__schema.queryType.name == "Query" and (.errors | not)' || fail "$CONTAINER_JWT"

# An unauthenticated request runs as the connection role, which has full access.
RESPONSE="$(graphql_query "$HOST_PORT_JWT" '{"query":"query health { allAccounts { totalCount } }"}')"
echo "Unauthenticated query (connection role): $RESPONSE"
echo "$RESPONSE" | jq -e '(.data.allAccounts.totalCount | type) == "number" and (.errors | not)' || fail "$CONTAINER_JWT"

# An invalid token must be rejected with 401.
STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "http://localhost:${HOST_PORT_JWT}/graphql" \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer invalid-token' \
  -d '{"query":"query health { __schema { queryType { name } } }"}')"
echo "Invalid token status: $STATUS"
if [ "$STATUS" != "401" ]; then
  echo "Expected 401 for an invalid token"
  docker logs "$CONTAINER_JWT"
  exit 1
fi

# smoke_test.account carries the '@turnstileProtected' tag, so its mutations
# must be rejected outright when no Turnstile token is presented, while
# queries (asserted above) stay unaffected.
RESPONSE="$(curl -sS --max-time 10 -w '\n%{http_code}' -X POST "http://localhost:${HOST_PORT_JWT}/graphql" \
  -H 'Content-Type: application/json' \
  -d '{"query":"mutation { createAccount(input: {account: {}}) { clientMutationId } }"}')"
STATUS_CODE="$(echo "$RESPONSE" | tail -1)"
BODY="$(echo "$RESPONSE" | sed '$d')"
echo "Protected mutation: $STATUS_CODE $BODY"
if [ "$STATUS_CODE" != "422" ]; then
  echo "Expected HTTP 422 for a protected mutation without a Turnstile token"
  docker logs "$CONTAINER_JWT"
  exit 1
fi
echo "$BODY" | jq -e '.errors[0].message == "Turnstile token not provided"' || fail "$CONTAINER_JWT"
echo "Run 1 OK."
echo "::endgroup::"

echo "::group::Run 2: no JWT, default role, custom port"
ENV_DIR_PLAIN="$(mktemp -d -p "$(pwd)" smoke-plain.XXXXXX)"
chmod 755 "$ENV_DIR_PLAIN"

echo "$CONNECTION" > "$ENV_DIR_PLAIN/POSTGRAPHILE_CONNECTION"
echo "$CONNECTION" > "$ENV_DIR_PLAIN/POSTGRAPHILE_OWNER_CONNECTION"
echo "$SCHEMA_NAME" > "$ENV_DIR_PLAIN/POSTGRAPHILE_SCHEMA"
echo "smoke_role" > "$ENV_DIR_PLAIN/POSTGRAPHILE_DEFAULT_ROLE"

# POSTGRAPHILE_PORT is a container-level environment variable, because the
# image HEALTHCHECK only sees the container environment, not the variables
# the entrypoint loads from /run/environment-variables.
start_container "$CONTAINER_PLAIN" "$ENV_DIR_PLAIN" 5000 -e POSTGRAPHILE_PORT=5000
HOST_PORT_PLAIN="$(host_port "$CONTAINER_PLAIN" 5000)"
wait_healthy "$CONTAINER_PLAIN"

RESPONSE="$(graphql_query "$HOST_PORT_PLAIN" '{"query":"query health { __schema { queryType { name } } }"}')"
echo "Introspection: $RESPONSE"
echo "$RESPONSE" | jq -e '.data.__schema.queryType.name == "Query" and (.errors | not)' || fail "$CONTAINER_PLAIN"

# smoke_role can read smoke_test.account, so the query succeeds as that role.
RESPONSE="$(graphql_query "$HOST_PORT_PLAIN" '{"query":"query health { allAccounts { totalCount } }"}')"
echo "Default role query: $RESPONSE"
echo "$RESPONSE" | jq -e '(.data.allAccounts.totalCount | type) == "number" and (.errors | not)' || fail "$CONTAINER_PLAIN"

# smoke_role cannot read smoke_test.secret, so the query must fail.
# If the default role were not applied, the query would run as postgres and succeed.
RESPONSE="$(curl -sS --max-time 10 -X POST "http://localhost:${HOST_PORT_PLAIN}/graphql" \
  -H 'Content-Type: application/json' \
  -d '{"query":"query health { allSecrets { totalCount } }"}')"
echo "Forbidden table query: $RESPONSE"
echo "$RESPONSE" | jq -e '(.errors | type) == "array" and (.errors | length > 0)' || fail "$CONTAINER_PLAIN"

# A stale Authorization header is ignored when JWT authentication is disabled.
RESPONSE="$(graphql_query "$HOST_PORT_PLAIN" '{"query":"query health { allAccounts { totalCount } }"}' -H 'Authorization: Bearer stale-token')"
echo "Stale token ignored: $RESPONSE"
echo "$RESPONSE" | jq -e '(.data.allAccounts.totalCount | type) == "number" and (.errors | not)' || fail "$CONTAINER_PLAIN"
echo "Run 2 OK."
echo "::endgroup::"

echo "::group::Container logs"
docker logs "$CONTAINER_JWT"
docker logs "$CONTAINER_PLAIN"
echo "::endgroup::"

echo "Smoke test passed."
