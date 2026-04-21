import type { RequestHandler } from "express";
import { validationResult, type ValidationChain } from "express-validator";
import ApiError from "../utils/ApiError.js";

/**
 * Runs express-validator chains and converts their result into a single
 * 400 ApiError so the global error handler can format it consistently.
 */
export default function validate(chains: ValidationChain[]): RequestHandler {
  return async (req, _res, next) => {
    for (const chain of chains) {
      // eslint-disable-next-line no-await-in-loop
      await chain.run(req);
    }
    const result = validationResult(req);
    if (result.isEmpty()) {
      next();
      return;
    }

    const details = result.array().map((err) => {
      const field = "path" in err ? err.path : "unknown";
      const base: { field: string; message: string; value?: unknown } = {
        field,
        message: err.msg as string,
      };
      // Never echo password values back.
      if (field !== "password" && "value" in err) {
        base.value = err.value;
      }
      return base;
    });

    next(ApiError.badRequest("Validation failed", details));
  };
}
