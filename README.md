# 🚀 @maevsi/postgraphile

> A blazing-fast GraphQL API layer for PostgreSQL, powering the [Vibetype](https://github.com/maevsi/vibetype) event community platform and other deployments.

## Overview

This is a production-ready **PostGraphile v5** server that automatically generates a powerful GraphQL API directly from any PostgreSQL schema. The schema, port, default role, and optional features (JWT authentication, Turnstile verification) are configured entirely via environment variables, so the same image serves different platforms: [Vibetype](https://github.com/maevsi/vibetype) runs it with JWT and Turnstile enabled, other stacks run it in plain mode.

### ✨ Key Features

- **🔄 Auto-Generated GraphQL API**: Full CRUD operations from your PostgreSQL schema
- **🎛️ Environment-Driven**: Schema, port, and roles via environment variables
- **🌍 PostGIS Support**: Built-in geospatial capabilities with `@graphile/postgis`
- **🔐 Optional JWT Authentication**: ES256 ECDSA-signed tokens with claim-based authorization
- **🧩 Optional Turnstile Verification**: Bot protection for `@turnstileProtected` mutations via Cloudflare
- **⚡ Grafast Optimizations**: Deep SQL query optimization and N+1 prevention
- **🎨 Amber Preset**: Sensible defaults for a modern development experience
- **🐳 Docker Native**: Containerized with automatic pnpm setup

## Quick Start

### Prerequisites

**Node.js**, **PostgreSQL** with your schema applied, and **pnpm**.

### Development

```bash
pnpm install    # Install dependencies
pnpm run lint   # Lint code

# Docker
docker build -t maevsi/postgraphile .
```

## Configuration

All configuration is done via environment variables; secrets can be delivered as files in `/run/environment-variables` (loaded by `docker-entrypoint.sh`).

| Variable                        | Required | Default | Description                                                                                                                                                                                                      |
| ------------------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRAPHILE_CONNECTION`       | yes      | -       | PostgreSQL connection string of the service role                                                                                                                                                                 |
| `POSTGRAPHILE_OWNER_CONNECTION` | yes      | -       | PostgreSQL connection string of a superuser (used to install watch fixtures)                                                                                                                                     |
| `POSTGRAPHILE_SCHEMA`           | yes      | -       | Name of the PostgreSQL schema to expose over GraphQL                                                                                                                                                             |
| `POSTGRAPHILE_PORT`             | no       | `5678`  | HTTP port of the GraphQL server; set this as a container-level environment variable, because the image `HEALTHCHECK` only sees the container environment, not variables loaded from `/run/environment-variables` |
| `POSTGRAPHILE_DEFAULT_ROLE`     | no       | -       | Role for requests that resolve no role of their own: every request when JWT authentication is disabled; the fallback for a valid token without a `role` claim when it is enabled                                 |
| `POSTGRAPHILE_JWT_PUBLIC_KEY`   | no       | -       | SPKI public key; with the secret key present, enables JWT authentication                                                                                                                                         |
| `POSTGRAPHILE_JWT_SECRET_KEY`   | no       | -       | PKCS#8 secret key; both keys must be present together, one alone fails startup                                                                                                                                   |
| `TURNSTILE_SECRET_KEY`          | no       | -       | Cloudflare Turnstile secret key; when set (or `TURNSTILE_BYPASS` is `true`), enables Turnstile verification for mutations on resources tagged `@turnstileProtected`                                              |
| `TURNSTILE_BYPASS`              | no       | -       | When set to the exact string `true`, skips Turnstile verification entirely (development convenience)                                                                                                             |
| `SENTRY_DSN`                    | no       | -       | When set, initializes Sentry error tracking                                                                                                                                                                      |

### Roles

- **No JWT authentication**: every request runs as `POSTGRAPHILE_DEFAULT_ROLE` (or as the connection role when it is not set).
- **JWT authentication enabled**: a valid token's `role` claim determines the role; a valid token without a `role` claim falls back to `POSTGRAPHILE_DEFAULT_ROLE`; requests without a token keep running as the connection role. An invalid token is rejected with HTTP 401.

### Authentication

When JWT authentication is enabled, ES256 (ECDSA) is used for verifying tokens; tokens use `postgraphile` as both issuer and audience and are represented in PostgreSQL by the composite type `<POSTGRAPHILE_SCHEMA>.jwt`.

The signing keys and related secrets are best configured via environment variables in [maevsi/stack](https://github.com/maevsi/stack).

## Architecture

```
┌─────────────────────────────────────────────┐
│     Frontend (Nuxt)                         │
└──────────────┬──────────────────────────────┘
               │ GraphQL
┌──────────────▼──────────────────────────────┐
│     GraphQL API (PostGraphile)              │
└──────────────┬──────────────────────────────┘
               │ SQL queries and mutations
┌──────────────▼──────────────────────────────┐
│     Database (PostgreSQL)                   │
└──────────────▲──────────────────────────────┘
               │ SQL schema
┌──────────────┴──────────────────────────────┐
│     Migrations (Sqitch)                     │
└─────────────────────────────────────────────┘
```

See [maevsi/stack](https://github.com/maevsi/stack) for the full Docker setup.

## Project Structure

```
src/
├── graphile.config.ts    # Main PostGraphile configuration
├── graphile.ts           # Scripted logic (JWT verification, default role)
├── environment.ts        # Type-safe environment utilities
├── instrument.ts         # Sentry initialization
└── presets/
    └── turnstile.ts      # Turnstile verification preset
```

### Docker

The included `docker-entrypoint.sh` automatically:

- Loads environment variables from `/run/environment-variables` (Docker secrets)
- Installs dependencies in development mode
- Passes control to the `postgraphile` command

## Resources

- 📖 [PostGraphile Documentation](https://www.graphile.org/postgraphile/)
- 🗺️ [PostGIS Reference](https://postgis.net/)
- 🐘 [PostgreSQL Docs](https://www.postgresql.org/docs/)
- 🎪 [Vibetype Platform](https://github.com/maevsi/vibetype)
- 🏗️ [Full Stack (Docker Compose)](https://github.com/maevsi/stack)

---

**Questions or Issues?** [Open an issue](https://github.com/maevsi/postgraphile/issues), we're here to help!
