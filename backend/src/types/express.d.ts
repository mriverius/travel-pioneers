// Augments Express's Request type with fields we attach in middleware.
import "express";
import type { Role } from "./domain.js";

declare global {
  namespace Express {
    interface Request {
      /** Correlation id set by the requestId middleware. */
      id: string;
      /**
       * The authenticated caller. Populated by `requireAuth`; always
       * defined on routes mounted behind that middleware.
       */
      auth?: AuthenticatedUser;
    }

    interface AuthenticatedUser {
      id: string;
      email: string;
      role: Role;
    }
  }
}

export {};
