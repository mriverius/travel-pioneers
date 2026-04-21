import { Router } from "express";
import { body, param } from "express-validator";
import validate from "../middleware/validate.js";
import asyncHandler from "../utils/asyncHandler.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import {
  ALLOWED_VIEWS,
  ROLES,
  create,
  list,
  remove,
  update,
} from "../controllers/userController.js";

const router = Router();

// Every route on this router requires an authenticated admin.
router.use(requireAuth, requireAdmin);

const createValidators = [
  body("name")
    .trim()
    .isLength({ min: 2, max: 120 })
    .withMessage("Name must be between 2 and 120 characters"),
  body("email")
    .trim()
    .isEmail()
    .withMessage("A valid email is required")
    .normalizeEmail(),
  body("role")
    .optional()
    .isIn(ROLES)
    .withMessage("Role must be admin or member"),
  body("views")
    .optional()
    .isArray()
    .withMessage("Views must be an array"),
  body("views.*")
    .optional()
    .isIn(ALLOWED_VIEWS)
    .withMessage("Unknown view id"),
];

const idParam = [
  param("id").isUUID().withMessage("User id must be a UUID"),
];

const updateValidators = [
  ...idParam,
  body("name")
    .optional()
    .trim()
    .isLength({ min: 2, max: 120 })
    .withMessage("Name must be between 2 and 120 characters"),
  body("role")
    .optional()
    .isIn(ROLES)
    .withMessage("Role must be admin or member"),
  body("views")
    .optional()
    .isArray()
    .withMessage("Views must be an array"),
  body("views.*")
    .optional()
    .isIn(ALLOWED_VIEWS)
    .withMessage("Unknown view id"),
];

router.get("/", asyncHandler(list));

router.post(
  "/",
  validate(createValidators),
  asyncHandler(create),
);

router.patch(
  "/:id",
  validate(updateValidators),
  asyncHandler(update),
);

router.delete(
  "/:id",
  validate(idParam),
  asyncHandler(remove),
);

export default router;
