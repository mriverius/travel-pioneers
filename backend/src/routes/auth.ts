import { Router } from "express";
import { body } from "express-validator";
import rateLimit from "express-rate-limit";
import validate from "../middleware/validate.js";
import asyncHandler from "../utils/asyncHandler.js";
import { login } from "../controllers/authController.js";

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

const loginValidators = [
  body("email")
    .trim()
    .isEmail()
    .withMessage("A valid email is required")
    .normalizeEmail(),
  body("password").isString().notEmpty().withMessage("Password is required"),
];

router.post(
  "/login",
  authLimiter,
  validate(loginValidators),
  asyncHandler(login),
);

export default router;
