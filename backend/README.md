# Travel Pioneers — Backend

Node.js + **TypeScript** + Express API backing the Travel Pioneers portal.
Authentication is handled here (registration and login), with bcrypt-hashed
passwords, JWT session tokens, request logging, input validation, and rate
limiting. All database access goes through **Prisma 7** (the typed ORM),
which connects to the **Supabase** Postgres instance via the `pg` driver
adapter.

## Stack

- **TypeScript 5** — strict mode, ES2023 target, ESM modules
- **Express 4** — HTTP server
- **Prisma 7** — typed database client against Supabase Postgres
  (with `@prisma/adapter-pg` driver adapter, as required by v7)
- **Supabase** — managed Postgres
- **bcryptjs** — password hashing (pure JS; configurable cost factor)
- **jsonwebtoken** — session tokens returned to the frontend
- **express-validator** — input validation
- **express-rate-limit** — brute-force protection on `/auth/*`
- **helmet** + **cors** — security headers and CORS
- **winston** + **morgan** — structured logging & HTTP access logs
- **tsx** — dev runner with watch mode

## Setup

Prerequisites: Node `>=20.19` (Prisma 7 requires it).

1. Copy `.env.example` to `.env` and fill in the values. In Supabase, go to
   **Project Settings → Database → Connection string** and grab both URLs:
   - `DATABASE_URL` — the pooled connection (port `6543`, Supavisor).
     Used at runtime by the driver adapter.
   - `DIRECT_URL` — the direct connection (port `5432`). Used by
     `prisma migrate` (configured in `prisma.config.ts`).
2. Install dependencies and provision the schema:

   ```bash
   npm install
   npx prisma generate                     # generate the typed client into src/generated/prisma
   npx prisma migrate deploy               # apply migrations to Supabase
   ```

   If you'd rather provision the schema by hand, `supabase/schema.sql` has
   an equivalent bootstrap script you can paste into Supabase's SQL editor.

3. Start the server:

   ```bash
   npm run dev               # tsx watch
   # or
   npm run build && npm run start
   ```

The server listens on `http://localhost:4000` by default.

## Prisma 7 notes

Prisma 7 is a big shift from 5.x. The key things this project does to line
up with it:

- `"type": "module"` in `package.json`; `module: ESNext`, `moduleResolution:
  bundler`, `target: ES2023` in `tsconfig.json`.
- The `datasource` block in `prisma/schema.prisma` no longer carries
  connection strings. They live in `prisma.config.ts` (for `prisma migrate`)
  and in `process.env.DATABASE_URL` (read by the driver adapter at runtime).
- The generator is `prisma-client` (the new Rust-free client), with an
  explicit `output = "../src/generated/prisma"`. `@prisma/client` no longer
  emits into `node_modules`; imports point at the generated folder instead.
- `PrismaClient` is constructed with `{ adapter: new PrismaPg(...) }`.
- Migrations live under `prisma/migrations/` — Prisma manages this directory.

## Routes

### `POST /auth/register`

Request body:

```json
{
  "name": "Juan Pérez",
  "email": "juan@empresa.com",
  "password": "Supersecret1!"
}
```

Password must contain:
- at least 8 characters (max 128)
- at least one lowercase letter
- at least one uppercase letter
- at least one digit
- at least one special (non-alphanumeric) character

- Password is hashed with bcrypt (`BCRYPT_SALT_ROUNDS`, default `12`).
- Returns `201` with `{ user, token }`.
- `409` if the email is already registered (Prisma `P2002`).
- `400` on validation errors with a `details` array.

### `POST /auth/login`

Request body:

```json
{
  "email": "juan@empresa.com",
  "password": "Supersecret1!"
}
```

- Verifies the bcrypt hash with `bcrypt.compare`.
- Returns `200` with `{ user, token }` on success.
- `401` with a generic "Invalid email or password" message on any failure —
  the same message whether the email exists or not, so we don't leak
  account existence.
- Updates `lastLoginAt` in the background (never blocks the response).

### `GET /health`

Liveness probe. Returns `{ status: "ok", timestamp }`.

### `POST /api/supplier-intelligence/extract`

Supplier Intelligence agent — steps 1 & 2 of the contract-onboarding flow.
Accepts a single contract document (PDF, Word, Excel), sends it to Claude
(`claude-sonnet-4-5`) with a forced `tool_use` schema, and returns the 9
target fields plus confidence / traceability metadata.

Request:

- `Content-Type: multipart/form-data`
- Single form field: `file`
- Accepted types: `application/pdf`, `.docx`, `.doc`, `.xlsx`, `.xls`
- Max size: **20 MB**

PDFs are forwarded to Claude verbatim as a `document` block (no local
parsing — Claude reads layout and page numbers natively). Word files are
converted to plain text with `mammoth`, Excel files with SheetJS
(CSV-per-sheet). The `ANTHROPIC_API_KEY` env var must be set.

#### Example — curl

```bash
curl -X POST http://localhost:4000/api/supplier-intelligence/extract \
  -F "file=@./contrato-parador.pdf;type=application/pdf"
```

#### Example — Postman

1. Method: `POST`  →  URL: `http://localhost:4000/api/supplier-intelligence/extract`
2. Body tab → `form-data`
3. Add key `file`, set the type dropdown to **File**, pick the contract.
4. `Send`.

#### Example — successful response

```json
{
  "success": true,
  "data": {
    "fecha": "2025-02-13",
    "proveedor": "Hotel Parador Quepos S.A.",
    "nombre_comercial": "Hotel Parador Resort & Spa",
    "cedula": "3-101-118200",
    "direccion": "Punta Quepos, Manuel Antonio, Costa Rica",
    "telefono": "+506 2777-1414",
    "tipo_moneda": "USD",
    "numero_cuenta": "CR39 0151 0221 0026 0000 48",
    "banco": "Banco Nacional de Costa Rica",
    "confianza": "media",
    "campos_faltantes": [],
    "paginas_origen": {
      "fecha": 8,
      "proveedor": 1,
      "nombre_comercial": 1,
      "cedula": 1,
      "direccion": "multiple",
      "telefono": 1,
      "tipo_moneda": "inferido",
      "numero_cuenta": 6,
      "banco": 6
    }
  },
  "validation": {
    "valid": true,
    "warnings": []
  },
  "meta": {
    "filename": "contrato-parador.pdf",
    "size_bytes": 245678,
    "model": "claude-sonnet-4-5",
    "processed_at": "2026-04-23T15:30:00Z"
  }
}
```

#### Error responses

All failures on this route follow a dedicated envelope:

```json
{
  "success": false,
  "error": {
    "code": "file_too_large",
    "message": "El archivo excede el límite de 20 MB.",
    "requestId": "…"
  }
}
```

| Status | `code`                  | Trigger                                              |
|--------|-------------------------|------------------------------------------------------|
| 400    | `bad_request`           | Missing `file` field, malformed upload.              |
| 413    | `file_too_large`        | Upload > 20 MB.                                      |
| 415    | `unsupported_file_type` | Not a PDF / Word / Excel document.                   |
| 422    | `validation_failed`     | Validation (e.g. IBAN checksum) rejected the data.   |
| 429    | `rate_limited`          | 20 requests/minute cap hit.                          |
| 502    | `upstream_unavailable`  | Anthropic timed out, rate-limited us, or returned no `tool_use`. |

#### Agent layout

The agent is isolated under `src/agents/supplier-intelligence/` so more
agents can be added alongside without collisions:

```
src/agents/supplier-intelligence/
├── prompts/
│   ├── systemPrompt.ts     # the extraction rules, verbatim from spec
│   ├── toolSchema.ts       # JSON Schema for `extraer_datos_contrato`
│   └── index.ts
├── extractors/
│   ├── pdf.ts              # base64 passthrough for Claude
│   ├── docx.ts             # mammoth → plain text
│   ├── xlsx.ts             # SheetJS → CSV per sheet
│   └── index.ts            # detect kind + dispatch
├── anthropicClient.ts      # lazy singleton Anthropic client
├── service.ts              # calls Claude with forced tool_use
├── validators.ts           # IBAN mod-97, cédula, phone E.164 checks
├── uploadMiddleware.ts     # multer memoryStorage, 20 MB, mime filter
├── errorHandler.ts         # scoped {success:false, error:{code,message}}
├── controller.ts           # POST handler
└── types.ts
```

## Roles

Only two roles are supported: `admin` and `member`. Enforced in the Prisma
`Role` enum, the database schema, and the controller defaults.

## Logging

Every request gets a correlation id (`x-request-id`), included in the HTTP
access log and in every application log line for that request. In
development logs are pretty-printed; in production (`NODE_ENV=production`)
they are JSON for ingestion by any log aggregator. Prisma errors and
warnings are forwarded to the same Winston logger.

## Error handling

All errors funnel through a single middleware (`src/middleware/errorHandler.ts`)
that:

- Converts thrown `ApiError`s to their declared status and message.
- Treats anything else as a `500` with a generic message (the stack is
  logged but never sent to the client).
- Logs 4xx as `warn` and 5xx as `error`.
- Always echoes the request id so errors can be traced.

An `asyncHandler` wrapper (`src/utils/asyncHandler.ts`) catches rejected
promises from route handlers and forwards them to the error middleware.

## Project layout

```
backend/
├── prisma/
│   ├── schema.prisma                # source of truth for the DB schema
│   └── migrations/                  # managed by `prisma migrate`
├── prisma.config.ts                 # Prisma 7 CLI configuration
├── src/
│   ├── server.ts                    # bootstrap + graceful shutdown
│   ├── app.ts                       # Express app + middleware wiring
│   ├── config/
│   │   ├── logger.ts
│   │   └── prisma.ts                # singleton PrismaClient with PrismaPg adapter
│   ├── controllers/
│   │   └── authController.ts
│   ├── middleware/
│   │   ├── errorHandler.ts
│   │   ├── requestLogger.ts
│   │   └── validate.ts
│   ├── routes/
│   │   └── auth.ts
│   ├── types/
│   │   ├── domain.ts                # UserRow, Role, Prisma error guard
│   │   └── express.d.ts             # augments Request with `id`
│   ├── utils/
│   │   ├── ApiError.ts
│   │   └── asyncHandler.ts
│   └── generated/prisma/            # ← produced by `prisma generate` (gitignored)
├── supabase/
│   └── schema.sql                   # hand-run bootstrap (optional)
├── .env.example
├── package.json
└── tsconfig.json
```
