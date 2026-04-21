/**
 * Winston logger configuration.
 *
 * In development we print colored human-readable logs to the console.
 * In production we output JSON so logs can be shipped to any aggregator.
 */
import winston from "winston";

const { combine, timestamp, printf, colorize, errors, json, splat } =
  winston.format;

const isProd = process.env.NODE_ENV === "production";

const devFormat = printf(({ level, message, timestamp: ts, stack, ...meta }) => {
  const rest = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  return `${ts as string} [${level}] ${(stack as string) || (message as string)}${rest}`;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? (isProd ? "info" : "debug"),
  format: combine(
    errors({ stack: true }),
    splat(),
    timestamp(),
    isProd ? json() : combine(colorize(), devFormat),
  ),
  transports: [new winston.transports.Console()],
  exitOnError: false,
});

export default logger;
