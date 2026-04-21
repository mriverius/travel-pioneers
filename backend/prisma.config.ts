// Prisma 7 configuration.
//
// In Prisma 7 the datasource block in `schema.prisma` no longer carries the
// connection strings — they move here. The URL we expose as `datasource.url`
// is the one the Prisma CLI uses for migrations, so we point it at the
// DIRECT Supabase connection (port 5432). The runtime driver adapter reads
// `DATABASE_URL` (the pooled Supavisor connection on port 6543) from the
// environment in `src/config/prisma.ts`.
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Direct connection — required by `prisma migrate`.
    url: env("DIRECT_URL"),
  },
});
