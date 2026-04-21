import { Router } from "express";
import { body } from "express-validator";
import rateLimit from "express-rate-limit";
import validate from "../middleware/validate.js";
import asyncHandler from "../utils/asyncHandler.js";
import { login, register } from "../controllers/authController.js";

const router = Router();

/** Limit bursts against the auth endpoints to slow credential stuffing. */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      message: "Too many authentication attempts. Please try again later.",
    },
  },
});

/**
 * Password policy — keep the regexes in sync with the frontend rules in
 * `frontend/src/lib/passwordRules.ts`. Anything that's rejected here must
 * also be rejected client-side so the user isn't surprised by a 400.
 */
const registerValidators = [
  body("name")
    .trim()
    .isLength({ min: 2, max: 120 })
    .withMessage("Name must be between 2 and 120 characters"),
  body("email")
    .trim()
    .isEmail()
    .withMessage("A valid email is required")
    .normalizeEmail(),
  body("password")
    .isString()
    .isLength({ min: 8, max: 128 })
    .withMessage("Password must be at least 8 characters")
    .matches(/[a-z]/)
    .withMessage("Password must contain a lowercase letter")
    .matches(/[A-Z]/)
    .withMessage("Password must contain an uppercase letter")
    .matches(/[0-9]/)
    .withMessage("Password must contain a number")
    .matches(/[^A-Za-z0-9]/)
    .withMessage("Password must contain a special character"),
];

const loginValidators = [
  body("email")
    .trim()
    .isEmail()
    .withMessage("A valid email is required")
    .normalizeEmail(),
  body("password").isString().notEmpty().withMessage("Password is required"),
];

router.post(
  "/register",
  authLimiter,
  validate(registerValidators),
  asyncHandler(register),
);

router.post(
  "/login",
  authLimiter,
  validate(loginValidators),
  asyncHandler(login),
);

export default router;
