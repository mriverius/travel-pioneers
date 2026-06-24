import "dotenv/config";
import app from "./app.js";
import logger from "./config/logger.js";
import prisma from "./config/prisma.js";

const PORT = Number(process.env.PORT ?? 4000);

/** 15 min — alineado con Railway (máx HTTP) y el timeout del cliente en `api.ts`. */
const HTTP_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

const server = app.listen(PORT, () => {
  logger.info(`Backend listening on port ${PORT}`, {
    env: process.env.NODE_ENV ?? "development",
  });
});

// Node 20+ default requestTimeout = 300s. Las extracciones Opus (Paso 3) pueden
// superar 5 min; sin esto el socket se corta, el browser ve "Failed to fetch"
// y el frontend muestra "No pudimos conectar con el servidor".
server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
server.headersTimeout = HTTP_REQUEST_TIMEOUT_MS + 60_000;
server.keepAliveTimeout = 75_000;

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal} — shutting down`);
  server.close(async (err) => {
    if (err) {
      logger.error("Error while closing HTTP server", { error: err.message });
    }
    try {
      await prisma.$disconnect();
    } catch (disconnectErr) {
      logger.error("Error while disconnecting Prisma", {
        error:
          disconnectErr instanceof Error
            ? disconnectErr.message
            : String(disconnectErr),
      });
    }
    process.exit(err ? 1 : 0);
  });
  // Force-exit if the server doesn't close cleanly in time.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});

process.on("unhandledRejection", (reason: unknown) => {
  logger.error("Unhandled promise rejection", {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", { error: err.message, stack: err.stack });
  void gracefulShutdown("uncaughtException");
});
