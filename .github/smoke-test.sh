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
# `event` holds one row per combination of a past or future end, with and
# without an explicit end, for the event condition assertions.
# The past rows have fixed timestamps, so the range bounds can hit them exactly.
# `contact` and `guest` let account 1, the stubbed invoker, accept events 1 and 4 and cancel event 2, while account 2 accepts event 3, for the attendance and invitation assertions; `guest_claim_array` holds no claims.
docker exec "$CONTAINER_DB" psql -U postgres -d postgraphile -c '
  CREATE SCHEMA smoke_test;
  CREATE TABLE smoke_test.account (id serial PRIMARY KEY);
  INSERT INTO smoke_test.account DEFAULT VALUES;
  CREATE TABLE smoke_test.event (id integer PRIMARY KEY, start timestamptz NOT NULL, "end" timestamptz, effective_end timestamptz GENERATED ALWAYS AS (COALESCE("end", start)) STORED);
  INSERT INTO smoke_test.event (id, start, "end") VALUES
    (1, $$2020-01-01T00:00:00Z$$, $$2020-01-05T00:00:00Z$$),
    (2, now() - $$1 day$$::interval, now() + $$1 day$$::interval),
    (3, $$2020-01-03T00:00:00Z$$, NULL),
    (4, now() + $$1 day$$::interval, NULL);
  CREATE TABLE smoke_test.contact (id integer PRIMARY KEY, account_id integer);
  INSERT INTO smoke_test.contact (id, account_id) VALUES (1, 1), (2, 2);
  CREATE TABLE smoke_test.guest (id integer PRIMARY KEY, contact_id integer NOT NULL, event_id integer NOT NULL, feedback text);
  INSERT INTO smoke_test.guest (id, contact_id, event_id, feedback) VALUES
    (1, 1, 1, $$accepted$$),
    (2, 1, 2, $$canceled$$),
    (3, 1, 4, $$accepted$$),
    (4, 2, 3, $$accepted$$);
  CREATE FUNCTION smoke_test.invoker_account_id() RETURNS integer LANGUAGE sql STABLE AS $$SELECT 1$$;
  COMMENT ON FUNCTION smoke_test.invoker_account_id() IS $$@behavior -*$$;
  CREATE FUNCTION smoke_test.guest_claim_array() RETURNS integer[] LANGUAGE sql STABLE AS $$SELECT ARRAY[]::integer[]$$;
  COMMENT ON FUNCTION smoke_test.guest_claim_array() IS $$@behavior -*$$;
  CREATE TABLE smoke_test.secret (id serial PRIMARY KEY);
  INSERT INTO smoke_test.secret DEFAULT VALUES;
  COMMENT ON COLUMN smoke_test.event.effective_end IS $$@behavior -*$$;
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

# Event 2 would count as ended when judged by `start` alone, and event 3 would
# never count as ended when judged by `"end"` alone.
RESPONSE="$(graphql_query "$HOST_PORT_JWT" '{"query":"{ allEvents(condition: {hasEnded: false}) { nodes { rowId } } }"}')"
echo "Events not ended: $RESPONSE"
echo "$RESPONSE" | jq -e '([.data.allEvents.nodes[].rowId] | sort) == [2, 4] and (.errors | not)' || fail "$CONTAINER_JWT"

RESPONSE="$(graphql_query "$HOST_PORT_JWT" '{"query":"{ allEvents(condition: {hasEnded: true}) { nodes { rowId } } }"}')"
echo "Events ended: $RESPONSE"
echo "$RESPONSE" | jq -e '([.data.allEvents.nodes[].rowId] | sort) == [1, 3] and (.errors | not)' || fail "$CONTAINER_JWT"

RESPONSE="$(graphql_query "$HOST_PORT_JWT" '{"query":"{ allEvents { nodes { rowId } } }"}')"
echo "Events unconditioned: $RESPONSE"
echo "$RESPONSE" | jq -e '([.data.allEvents.nodes[].rowId] | sort) == [1, 2, 3, 4] and (.errors | not)' || fail "$CONTAINER_JWT"

# Each bound equals a fixed row instant, so `From` must include it and `Before` must exclude it.
# Event 3 has no end, so it ends at its start.
assert_events() {
  local condition="$1"
  local expected="$2"
  RESPONSE="$(graphql_query "$HOST_PORT_JWT" "{\"query\":\"{ allEvents(condition: {${condition}}) { nodes { rowId } } }\"}")"
  echo "Events ${condition}: $RESPONSE"
  echo "$RESPONSE" | jq -e --argjson expected "$expected" '([.data.allEvents.nodes[].rowId] | sort) == $expected and (.errors | not)' || fail "$CONTAINER_JWT"
}
assert_events 'endsBefore: \"2020-01-05T00:00:00Z\"' '[3]'
assert_events 'endsFrom: \"2020-01-05T00:00:00Z\"' '[1, 2, 4]'
assert_events 'startsBefore: \"2020-01-03T00:00:00Z\"' '[1]'
assert_events 'startsFrom: \"2020-01-03T00:00:00Z\"' '[2, 3, 4]'
# Everything overlapping the window from 2020-01-04 until now: event 3 ended before it, event 4 starts after it.
assert_events "startsBefore: \\\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\\\", endsFrom: \\\"2020-01-04T00:00:00Z\\\"" '[1, 2]'
# Event 2 was canceled and event 3 belongs to another account, so only 1 and 4 count as attended.
assert_events 'isAttending: true' '[1, 4]'
assert_events 'isAttending: false' '[2, 3]'
assert_events 'isAttending: true, hasEnded: false' '[4]'
# Invited counts event 2 despite its cancellation, while event 3 stays out because only another account was invited to it.
assert_events 'isInvited: true' '[1, 2, 4]'
assert_events 'isInvited: false' '[3]'

RESPONSE="$(graphql_query "$HOST_PORT_JWT" '{"query":"{ __type(name: \"EventCondition\") { inputFields { name type { name } } } }"}')"
echo "EventCondition fields: $RESPONSE"
echo "$RESPONSE" | jq -e 'any(.data.__type.inputFields[]; .name == "hasEnded" and .type.name == "Boolean")' || fail "$CONTAINER_JWT"
echo "$RESPONSE" | jq -e '[.data.__type.inputFields[] | [.name, .type.name]] | sort == [["endsBefore", "Datetime"], ["endsFrom", "Datetime"], ["hasEnded", "Boolean"], ["isAttending", "Boolean"], ["isInvited", "Boolean"], ["rowId", "Int"], ["startsBefore", "Datetime"], ["startsFrom", "Datetime"]]' || fail "$CONTAINER_JWT"

# `effective_end` is tagged `@behavior -*`, so it must stay out of the schema.
RESPONSE="$(graphql_query "$HOST_PORT_JWT" '{"query":"{ __type(name: \"Event\") { fields { name } } }"}')"
echo "Event fields: $RESPONSE"
echo "$RESPONSE" | jq -e '[.data.__type.fields[].name] | (index("start") != null) and (index("effectiveEnd") | not)' || fail "$CONTAINER_JWT"

# The condition replaces a `filter` argument, so none may exist on any field.
RESPONSE="$(graphql_query "$HOST_PORT_JWT" '{"query":"{ __schema { types { fields { args { name } } } } }"}')"
echo "$RESPONSE" | jq -e '[.data.__schema.types[].fields // [] | .[].args[].name] | (length > 0) and (index("filter") | not)' || fail "$CONTAINER_JWT"
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
