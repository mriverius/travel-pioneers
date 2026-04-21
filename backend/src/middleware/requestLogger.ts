import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import morgan from "morgan";
import logger from "../config/logger.js";

/** Attach a request id to every request for correlation in logs. */
export const requestId: RequestHandler = (req, res, next) => {
  const header = req.headers["x-request-id"];
  req.id = typeof header === "string" && header ? header : randomUUID();
  res.setHeader("x-request-id", req.id);
  next();
};

/** Morgan token that exposes the request id. */
morgan.token("id", (req) => (req as { id?: string }).id ?? "-");

/** HTTP access log — uses Winston as the underlying transport. */
export const httpLogger = morgan(
  ":id :remote-addr :method :url :status :res[content-length] - :response-time ms",
  {
    stream: {
      write: (message: string) => {
        logger.info(message.trim());
      },
    },
  },
);
