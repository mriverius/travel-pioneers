import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { requestId, httpLogger } from "./middleware/requestLogger.js";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import supplierIntelligenceRoutes from "./routes/supplierIntelligence.js";

const app: Express = express();

// Behind a proxy (Vercel, Render, Nginx…) so req.ip is accurate and rate
// limiting works correctly.
app.set("trust proxy", 1);

app.use(helmet());
app.use(
  cors({
    origin: (process.env.CORS_ORIGIN ?? "*")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    credentials: true,
  }),
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use(requestId);
app.use(httpLogger);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/auth", authRoutes);
app.use("/users", userRoutes);
// Supplier Intelligence agent — isolated under its own prefix so other
// agents can be added alongside without namespace collisions.
app.use("/api/supplier-intelligence", supplierIntelligenceRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
