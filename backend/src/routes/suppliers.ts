import { Router } from "express";
import { body, param } from "express-validator";
import validate from "../middleware/validate.js";
import asyncHandler from "../utils/asyncHandler.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import {
  create,
  getOne,
  list,
  remove,
  replaceServices,
  update,
} from "../controllers/supplierController.js";

const router = Router();

// Lectura: cualquier usuario autenticado (el agente la necesita en el Paso 1).
router.use(requireAuth);

const idParam = [param("id").isUUID().withMessage("Supplier id must be a UUID")];

const supplierFields = (optional: boolean) => {
  const chain = (field: string, max: number) => {
    const b = body(field);
    return (optional ? b.optional({ values: "null" }) : b)
      .isString()
      .withMessage(`${field} must be a string`)
      .isLength({ max })
      .withMessage(`${field} must be at most ${max} characters`);
  };
  return [
    chain("codigo", 64),
    body("nombre").optional({ values: "null" }).isString().isLength({ max: 200 }),
    body("actividad").optional({ values: "null" }).isString().isLength({ max: 32 }),
    body("zona").optional({ values: "null" }).isString().isLength({ max: 32 }),
  ];
};

const servicesValidators = [
  body("servicios").optional().isArray({ max: 2000 }).withMessage("servicios must be an array"),
  body("servicios.*.codigo").optional().isString().isLength({ max: 64 }),
  body("servicios.*.descripcion")
    .optional({ values: "null" })
    .isString()
    .isLength({ max: 500 }),
  body("servicios.*.actividad").optional({ values: "null" }).isString().isLength({ max: 32 }),
  body("servicios.*.zona").optional({ values: "null" }).isString().isLength({ max: 32 }),
];

router.get("/", asyncHandler(list));
router.get("/:id", validate(idParam), asyncHandler(getOne));

// Escritura: solo admins.
router.post(
  "/",
  requireAdmin,
  validate([...supplierFields(false), ...servicesValidators]),
  asyncHandler(create),
);

router.patch(
  "/:id",
  requireAdmin,
  validate([...idParam, ...supplierFields(true)]),
  asyncHandler(update),
);

router.put(
  "/:id/servicios",
  requireAdmin,
  validate([
    ...idParam,
    body("servicios").isArray({ max: 2000 }).withMessage("servicios must be an array"),
    body("servicios.*.codigo").isString().isLength({ min: 1, max: 64 }),
    body("servicios.*.descripcion")
      .optional({ values: "null" })
      .isString()
      .isLength({ max: 500 }),
    body("servicios.*.actividad").optional({ values: "null" }).isString().isLength({ max: 32 }),
    body("servicios.*.zona").optional({ values: "null" }).isString().isLength({ max: 32 }),
  ]),
  asyncHandler(replaceServices),
);

router.delete("/:id", requireAdmin, validate(idParam), asyncHandler(remove));

export default router;
