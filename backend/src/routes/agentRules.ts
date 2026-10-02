import { Router } from "express";
import { param } from "express-validator";
import validate from "../middleware/validate.js";
import asyncHandler from "../utils/asyncHandler.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import {
  acceptSuggestion,
  create,
  dismissSuggestion,
  list,
  listSuggestions,
  remove,
  update,
} from "../controllers/agentRuleController.js";

const router = Router();
router.use(requireAuth);

const idParam = [param("id").isUUID().withMessage("Rule id must be a UUID")];

router.get("/", asyncHandler(list));
// Sugerencias derivadas de correcciones recurrentes (sólo propone; decide un admin).
router.get("/suggestions", asyncHandler(listSuggestions));
router.post("/suggestions/:id/accept", requireAdmin, validate(idParam), asyncHandler(acceptSuggestion));
router.post("/suggestions/:id/dismiss", requireAdmin, validate(idParam), asyncHandler(dismissSuggestion));
router.post("/", requireAdmin, asyncHandler(create));
router.patch("/:id", requireAdmin, validate(idParam), asyncHandler(update));
router.delete("/:id", requireAdmin, validate(idParam), asyncHandler(remove));

export default router;
