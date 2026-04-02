# 🚀 @maevsi/postgraphile

> A blazing-fast GraphQL API layer for PostgreSQL, powering the Vibetype event community platform.

## Overview

This is a production-ready **PostGraphile v5** server that automatically generates a powerful GraphQL API directly from your PostgreSQL schema. It's a core service of the [Vibetype](https://github.com/maevsi/vibetype) platform, seamlessly converting database changes into a secure, performant GraphQL interface.

### ✨ Key Features

- **🔄 Auto-Generated GraphQL API**: Full CRUD operations from your PostgreSQL schema
- **🌍 PostGIS Support**: Built-in geospatial capabilities with `@graphile/postgis`
- **🔐 JWT Authentication**: ES256 ECDSA-signed tokens with claim-based authorization
- **⚡ Grafast Optimizations**: Deep SQL query optimization and N+1 prevention
- **🎨 Amber Preset**: Sensible defaults for a modern development experience
- **📦 TypeScript Ready**: Full type safety from database to API
- **🐳 Docker Native**: Containerized with automatic pnpm setup

## Quick Start

### Prerequisites

**Node.js**, **PostgreSQL** with Vibetype schema migrations applied via [sqitch](https://github.com/maevsi/sqitch), and **pnpm**.

### Development

```bash
pnpm install    # Install dependencies
pnpm run lint   # Lint code

# Docker
docker build -t maevsi/postgraphile .
```

## Architecture

This service is part of the **Vibetype platform**, an event community ecosystem:

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
├── graphile.ts           # Scripted logic
└── environment.ts        # Type-safe environment utilities
```

### Authentication

Authentication uses ES256 (ECDSA) for signing JWTs; tokens use `postgraphile` as both issuer and audience and are represented in PostgreSQL by the composite type `vibetype.jwt`.

The signing keys and related secrets are best configured via environment variables in [maevsi/stack](https://github.com/maevsi/stack).


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
