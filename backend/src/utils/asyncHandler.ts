import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Wraps an async route handler so that thrown/rejected errors are forwarded
 * to Express's error middleware instead of crashing the process.
 *
 * The wrapper is generic so that callers can narrow `req.params` /
 * `req.body` / `req.query` with Express's `Request<P, ResBody, ReqBody,
 * ReqQuery>` generics and still line up with `RequestHandler`.
 */
type AsyncRouteHandler<
  P = Record<string, string>,
  ResBody = unknown,
  ReqBody = unknown,
  ReqQuery = Record<string, string | string[] | undefined>,
> = (
  req: Request<P, ResBody, ReqBody, ReqQuery>,
  res: Response<ResBody>,
  next: NextFunction,
) => Promise<unknown>;

const asyncHandler =
  <
    P = Record<string, string>,
    ResBody = unknown,
    ReqBody = unknown,
    ReqQuery = Record<string, string | string[] | undefined>,
  >(
    fn: AsyncRouteHandler<P, ResBody, ReqBody, ReqQuery>,
  ): RequestHandler<P, ResBody, ReqBody, ReqQuery> =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

export default asyncHandler;
