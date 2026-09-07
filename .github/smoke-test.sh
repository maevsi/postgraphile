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
# A minimal stand-in for the sqitch-managed `vibetype` schema, covering what the healthcheck and the
# smoke test query as well as the shapes the connection filter test asserts on: `event` opts into
# filtering, `account` does not, and `empty_filter` opts in without owning a single filterable
# column.
docker exec -i "$CONTAINER_DB" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgraphile <<'SQL'
CREATE SCHEMA vibetype;

CREATE TYPE vibetype.jwt AS (id uuid, exp bigint);

CREATE TABLE vibetype.account (
  id serial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vibetype.event (
  id serial PRIMARY KEY,
  account_id integer NOT NULL REFERENCES vibetype.account (id),
  name text NOT NULL,
  start timestamptz NOT NULL,
  "end" timestamptz
);
CREATE INDEX ON vibetype.event (start);
COMMENT ON TABLE vibetype.event IS '@behavior +filter';
COMMENT ON COLUMN vibetype.event."end" IS '@behavior +attribute:filterBy';

CREATE FUNCTION vibetype.event_duration(e vibetype.event) RETURNS timestamptz AS $$
  SELECT e.start
$$ LANGUAGE sql STABLE;

CREATE TABLE vibetype.empty_filter (
  id serial PRIMARY KEY,
  label text NOT NULL
);
COMMENT ON TABLE vibetype.empty_filter IS '@behavior +filter';
SQL
echo "Schema ready."
echo "::endgroup::"

echo "::group::Start"
ENV_DIR="$(mktemp -d -p "$(pwd)" smoke-env.XXXXXX)"
chmod 755 "$ENV_DIR"

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

if ! HOST_PORT="$(docker port "$CONTAINER" 5678/tcp | head -1 | awk -F: '{print $NF}')"; then
  echo "Failed to determine host port for container"
  docker logs "$CONTAINER"
  exit 1
fi
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
  -d '{"query":"query health { allAccounts { totalCount } }"}') || {
  echo "Request failed, container logs:"
  docker logs "$CONTAINER"
  exit 1
}
echo "Response: $RESPONSE"
echo "$RESPONSE" | jq -e '(.data.allAccounts.totalCount | type) == "number" and (.errors | not)' || {
  echo "Response assertion failed, container logs:"
  docker logs "$CONTAINER"
  exit 1
}
echo "Smoke test OK."
echo "::endgroup::"

echo "::group::Connection filter test"
# Connection filtering is opt-in and deliberately narrow, and the behavior strings that keep it that
# way break in ways that only show up in the generated schema.
SCHEMA=$(curl -fsS --max-time 10 -X POST "http://localhost:${HOST_PORT}/graphql" \
  -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{"query":"{ queryType: __type(name: \"Query\") { fields { name args { name } } } eventFilter: __type(name: \"EventFilter\") { inputFields { name } } datetimeFilter: __type(name: \"DatetimeFilter\") { inputFields { name } } accountFilter: __type(name: \"AccountFilter\") { name } emptyFilterFilter: __type(name: \"EmptyFilterFilter\") { name } }"}
JSON
) || {
  echo "Introspection request failed, container logs:"
  docker logs "$CONTAINER"
  exit 1
}

assert_schema() {
  local description="$1"
  shift
  if ! echo "$SCHEMA" | jq -e "$@" >/dev/null; then
    echo "Assertion failed: $description"
    echo "Introspection response: $SCHEMA"
    exit 1
  fi
  echo "OK: $description"
}

HAS_ARGUMENT='[.data.queryType.fields[] | select(.name == $field) | .args[].name] | index($argument)'

# A table without the smart comment stays unfilterable, but keeps the built-in `condition` argument
# that an unscoped `-filter` behavior would take away along with it.
assert_schema 'allAccounts has no filter argument' \
  --arg field allAccounts --arg argument filter "$HAS_ARGUMENT == null"
assert_schema 'allAccounts keeps its condition argument' \
  --arg field allAccounts --arg argument condition "$HAS_ARGUMENT"
assert_schema 'AccountFilter is not part of the schema' '.data.accountFilter == null'

# The opted-in table gets both.
assert_schema 'allEvents has a filter argument' \
  --arg field allEvents --arg argument filter "$HAS_ARGUMENT"
assert_schema 'allEvents keeps its condition argument' \
  --arg field allEvents --arg argument condition "$HAS_ARGUMENT"

# Exactly the two datetime columns: no logical operators, no relations, no computed columns, and no
# columns of other types.
assert_schema 'EventFilter exposes only the datetime columns' \
  '[.data.eventFilter.inputFields[].name] | sort == ["end", "start"]'
assert_schema 'DatetimeFilter exposes only the allowed operators' \
  '[.data.datetimeFilter.inputFields[].name] | sort == ["equalTo", "greaterThan", "greaterThanOrEqualTo", "isNull", "lessThan", "lessThanOrEqualTo", "notEqualTo"]'

# Opting a table in without owning a single filterable column must not produce an empty input type,
# which would fail schema validation and take the whole server down.
assert_schema 'EmptyFilterFilter is not part of the schema' '.data.emptyFilterFilter == null'
assert_schema 'allEmptyFilters has no filter argument' \
  --arg field allEmptyFilters --arg argument filter "$HAS_ARGUMENT == null"
echo "::endgroup::"

echo "::group::Container logs"
docker logs "$CONTAINER"
echo "::endgroup::"

echo "Smoke test passed."
