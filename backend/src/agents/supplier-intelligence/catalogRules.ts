import type {
  ContractBrief,
  ContractRow,
  ExtractedContract,
  ProductOccupancySpec,
} from "./types.js";

/**
 * Reglas determinísticas del catálogo Utopía — aplicadas post-extracción para
 * corregir mapeos que Opus suele errar (Garden Suite→STD, Full Experience→N).
 */

/** Códigos de ocupación adultos del catálogo Utopía. */
export const CATALOG_OCCUPANCY_CODES = [
  "SGL",
  "DBL",
  "TPL",
  "QDP",
  "QTN",
  "CHL",
  "DAY",
  "UNI",
] as const;

export type ProductOccupancyTier = "suite" | "villa_quad" | "villa_quint" | "unknown";

const TIER_OCCUPANCY_CODES: Record<
  Exclude<ProductOccupancyTier, "unknown">,
  string[]
> = {
  suite: ["SGL", "DBL", "TPL", "CHL"],
  villa_quad: ["SGL", "DBL", "TPL", "QDP", "CHL"],
  villa_quint: ["SGL", "DBL", "TPL", "QDP", "QTN", "CHL"],
};

function normalizeOccupancyCode(code: string): string {
  return code.trim().toUpperCase();
}

function filterCatalogCodes(codes: string[]): string[] {
  return [
    ...new Set(
      codes
        .map(normalizeOccupancyCode)
        .filter((c) =>
          (CATALOG_OCCUPANCY_CODES as readonly string[]).includes(c),
        ),
    ),
  ];
}

/** Base del nombre de producto sin sufijo de paquete/sección. */
export function productBaseName(productName: string | null): string {
  const raw = (productName ?? "").trim();
  if (!raw) return "";
  const dash = raw.indexOf(" - ");
  return dash >= 0 ? raw.slice(0, dash).trim() : raw;
}

/**
 * Mapea el nombre del producto al código de categoría HO más cercano.
 * El orden importa: "Suite" antes que "Garden"→STD.
 */
export function inferCategoriaHospedaje(productName: string | null): string {
  const n = productBaseName(productName).toLowerCase();
  if (!n.trim()) return "STD";
  if (/\bvilla\b/.test(n)) return "VIL";
  if (/\bmaster suite\b/.test(n)) return "MAS";
  if (/\bpenthouse\b/.test(n)) return "PNT";
  if (/\bfamily suite\b|\bfamily room\b/.test(n)) return "FAM";
  if (/\bdeluxe suite\b/.test(n)) return "DLX";
  if (/\bjunior suite\b/.test(n)) return "JUN";
  if (/\bsuite\b/.test(n)) return "SUI";
  if (/\bpremium\b/.test(n)) return "PRM";
  if (/\bsuperior\b/.test(n)) return "SUP";
  if (/\bbungalow\b/.test(n)) return "BUN";
  if (/\bdeluxe\b/.test(n)) return "DLX";
  if (/\bocean view\b/.test(n)) return "OCV";
  return "STD";
}

/** Infiera el tier de ocupaciones según el tipo de habitación. */
export function inferProductOccupancyTier(
  productName: string | null,
): ProductOccupancyTier {
  const n = productBaseName(productName).toLowerCase();
  if (!n) return "unknown";
  if (/\bjaguar\b/.test(n) && /\bvilla\b/.test(n)) return "villa_quint";
  if (/\bvilla\b/.test(n)) return "villa_quad";
  if (/\bsuite\b/.test(n)) return "suite";
  return "unknown";
}

function briefTextHaystack(brief: ContractBrief): string {
  return [
    brief.notes,
    brief.meal_plan_note,
    brief.logic_summary,
    ...brief.sections,
    ...brief.product_categories,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Detecta tarifas por paquete/servicio (Full Experience, 2N/3D, etc.). */
export function detectPackagePricing(
  brief: ContractBrief,
  rows: ContractRow[],
): boolean {
  if (brief.tipo_unidad === "S") return true;
  if (brief.tipo_unidad === "N") return false;

  const haystack =
    briefTextHaystack(brief) +
    " " +
    rows
      .map((r) => r.product_name ?? "")
      .join(" ")
      .toLowerCase();

  return (
    /\bfull experience\b/.test(haystack) ||
    /\ball[- ]inclusive\b/.test(haystack) ||
    /\bpaquete completo\b/.test(haystack) ||
    /\bpackage rate\b/.test(haystack) ||
    /\bper person\b/.test(haystack) ||
    /\bpor persona\b/.test(haystack) ||
    /\b\d+n\s*\/\s*\d+d\b/.test(haystack) ||
    /\b\d+\s*nights?\s*\/\s*\d+\s*days?\b/.test(haystack)
  );
}

/** Ocupaciones globales de referencia (fallback para productos sin tier). */
export function resolveExpectedOccupancyCodes(brief: ContractBrief): string[] {
  const fromBrief = filterCatalogCodes(brief.occupancy_codes ?? []);
  if (fromBrief.length > 0) return fromBrief;

  const haystack = briefTextHaystack(brief);
  const codes: string[] = ["SGL", "DBL"];

  const perCat = brief.row_plan?.occupancies_per_category;
  const mentionsTriple =
    /\btriple\b|\btpl\b/.test(haystack) || (perCat != null && perCat >= 3);
  const mentionsQuad =
    /\bquadruple\b|\bquádruple\b|\bcuádruple\b|\bqdp\b/.test(haystack) ||
    (perCat != null && perCat >= 4);
  const mentionsQuint =
    /\bquintuple\b|\bquíntuple\b|\bqtn\b/.test(haystack) ||
    (perCat != null && perCat >= 5);
  const mentionsChild =
    /\bchildren\b|\bchild\b|\bniño|\bniños|\bchl\b/.test(haystack) ||
    (perCat != null && perCat >= 4);

  if (mentionsTriple) codes.push("TPL");
  if (mentionsQuad) codes.push("QDP");
  if (mentionsQuint) codes.push("QTN");
  if (mentionsChild) codes.push("CHL");

  return filterCatalogCodes(codes);
}

/** Ocupaciones esperadas para un producto concreto. */
export function inferOccupancyCodesFromProductName(
  productName: string,
  brief: ContractBrief | null,
  policy?: OccupancyPolicy,
): string[] {
  const tier = inferProductOccupancyTier(productName);
  let codes: string[];
  if (tier !== "unknown") codes = [...TIER_OCCUPANCY_CODES[tier]];
  else if (brief) codes = resolveExpectedOccupancyCodes(brief);
  else codes = ["SGL", "DBL"];
  const effectivePolicy = policy ?? detectOccupancyPolicy(brief, undefined);
  return filterOccupancyCodesByPolicy(codes, effectivePolicy);
}

function productNamesMatch(specProduct: string, rowProduct: string): boolean {
  const spec = specProduct.toLowerCase().trim();
  const row = rowProduct.toLowerCase().trim();
  const rowBase = productBaseName(rowProduct).toLowerCase();
  if (!spec || !row) return false;
  return (
    row.includes(spec) ||
    spec.includes(row) ||
    rowBase.includes(spec) ||
    spec.includes(rowBase)
  );
}

function findBestProductOccupancySpec(
  productName: string,
  specs: ProductOccupancySpec[],
): ProductOccupancySpec | null {
  let best: ProductOccupancySpec | null = null;
  let bestLen = 0;
  for (const spec of specs) {
    if (!productNamesMatch(spec.product, productName)) continue;
    const len = spec.product.trim().length;
    if (len >= bestLen) {
      best = spec;
      bestLen = len;
    }
  }
  return best;
}

/** Construye specs por producto desde categorías del brief. */
export function buildOccupanciesByProductFromCategories(
  categories: string[],
  brief: ContractBrief | null,
): ProductOccupancySpec[] {
  return categories.map((product) => ({
    product,
    occupancy_codes: inferOccupancyCodesFromProductName(product, brief),
  }));
}

/** Lista efectiva de specs por producto (brief + filas extraídas). */
export function collectProductOccupancySpecs(
  brief: ContractBrief,
  extraction: ExtractedContract,
): ProductOccupancySpec[] {
  const specs: ProductOccupancySpec[] = (brief.occupancies_by_product ?? [])
    .map((s) => ({
      product: s.product.trim(),
      occupancy_codes: filterCatalogCodes(s.occupancy_codes),
    }))
    .filter((s) => s.product && s.occupancy_codes.length > 0);

  if (specs.length === 0 && brief.product_categories.length > 0) {
    specs.push(
      ...buildOccupanciesByProductFromCategories(
        brief.product_categories,
        brief,
      ),
    );
  }

  const seen = new Set(specs.map((s) => s.product.toLowerCase()));
  for (const row of extraction.rows) {
    const base = productBaseName(row.product_name);
    if (!base || seen.has(base.toLowerCase())) continue;
    specs.push({
      product: base,
      occupancy_codes: inferOccupancyCodesFromProductName(base, brief),
    });
    seen.add(base.toLowerCase());
  }

  return specs;
}

/** Ocupaciones esperadas para validar un producto × temporada. */
export function resolveExpectedOccupancyCodesForProduct(
  productName: string,
  brief: ContractBrief,
  specs: ProductOccupancySpec[],
  policy?: OccupancyPolicy,
): string[] {
  const matched = findBestProductOccupancySpec(productName, specs);
  let codes: string[];
  if (matched && matched.occupancy_codes.length > 0) {
    codes = matched.occupancy_codes;
  } else {
    codes = inferOccupancyCodesFromProductName(productName, brief, policy);
  }
  const effectivePolicy = policy ?? detectOccupancyPolicy(brief, undefined);
  return filterOccupancyCodesByPolicy(codes, effectivePolicy);
}

function effectiveTipoServicio(
  row: ContractRow,
  sharedTipo: string | null,
): string | null {
  return row.tipo_servicio?.trim() || sharedTipo?.trim() || null;
}

function isHospedajeRow(row: ContractRow, sharedTipo: string | null): boolean {
  const ts = effectiveTipoServicio(row, sharedTipo);
  return ts === "HO" || ts === "SH" || ts === null;
}

/**
 * Normaliza categoría, tipo_unidad y tipo_servicio HO en filas de hospedaje.
 */
export function normalizeCatalogFields(
  extraction: ExtractedContract,
  brief: ContractBrief | null | undefined,
  warnings: string[],
): ExtractedContract {
  let shared = extraction.shared_fields;
  let rows = extraction.rows;
  const sharedTipo = shared.tipo_servicio;

  const usePackageUnit =
    brief != null ? detectPackagePricing(brief, rows) : false;

  if (usePackageUnit) {
    if (shared.tipo_unidad !== "S") {
      shared = { ...shared, tipo_unidad: "S" };
      warnings.push(
        "Tipo unidad ajustado a S (por servicio/paquete): el contrato " +
          "parece tarifar paquetes Full Experience o similares, no noches sueltas.",
      );
    }
  }

  let catFixed = 0;
  let unitFixed = 0;
  rows = rows.map((row) => {
    let next = row;
    if (isHospedajeRow(row, sharedTipo)) {
      const inferredCat = inferCategoriaHospedaje(row.product_name);
      if (row.categoria !== inferredCat) {
        next = { ...next, categoria: inferredCat };
        catFixed += 1;
      }
      if (usePackageUnit && row.tipo_unidad !== "S") {
        next = { ...next, tipo_unidad: "S" };
        unitFixed += 1;
      }
      if (!next.tipo_servicio?.trim() && sharedTipo === "HO") {
        next = { ...next, tipo_servicio: "HO" };
      }
    }
    return next;
  });

  if (catFixed > 0) {
    warnings.push(
      `Se normalizaron ${catFixed} categoría(s) según el catálogo Utopía ` +
        `(ej. *Suite→SUI, Villa→VIL).`,
    );
  }
  if (unitFixed > 0) {
    warnings.push(
      `Se ajustaron ${unitFixed} fila(s) a tipo unidad S (por servicio/paquete).`,
    );
  }

  return { ...extraction, shared_fields: shared, rows };
}

/** Valida ocupaciones por producto × temporada (no lista global plana). */
export function validateExpectedOccupancies(
  extraction: ExtractedContract,
  brief: ContractBrief,
  warnings: string[],
): void {
  const specs = collectProductOccupancySpecs(brief, extraction);
  if (specs.length === 0) return;

  const policy = detectOccupancyPolicy(brief, extraction);

  const groups = new Map<string, Set<string>>();
  for (const row of extraction.rows) {
    const product = (row.product_name ?? "").trim();
    const season = (row.season_name ?? "").trim();
    if (!product || !season) continue;
    const occ = normalizeOccupancyCode(row.ocupacion ?? "");
    if (!occ) continue;
    const key = `${product} · ${season}`;
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key)!.add(occ);
  }

  for (const [label, occs] of groups) {
    const product = label.split(" · ")[0] ?? label;
    const expected = resolveExpectedOccupancyCodesForProduct(
      product,
      brief,
      specs,
      policy,
    );
    if (expected.length === 0) continue;

    const adultExpected = expected.filter((c) => c !== "CHL");
    const needsChild = expected.includes("CHL");

    for (const code of adultExpected) {
      if (!occs.has(code)) {
        warnings.push(
          `Falta ocupación ${code} en ${label}. Para este producto aplican ` +
            `[${expected.join(", ")}] — revisá precios en el Paso 3.`,
        );
      }
    }
    if (needsChild && !occs.has("CHL")) {
      warnings.push(`Falta ocupación CHL (niño) en ${label}.`);
    }
  }
}

/** Política de ocupación inferida del contrato. */
export interface OccupancyPolicy {
  quadrupleAllowed: boolean;
  quintupleAllowed: boolean;
}

function normalizeSeasonKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function contractTextHaystack(
  brief: ContractBrief | null | undefined,
  extraction?: ExtractedContract,
): string {
  const parts: string[] = [];
  if (brief) {
    for (const p of [
      brief.notes,
      brief.logic_summary,
      brief.meal_plan_note,
      brief.commission_summary,
      ...brief.sections,
      ...brief.product_categories,
    ]) {
      if (p && p.trim()) parts.push(p);
    }
  }
  if (extraction) {
    if (extraction.shared_fields.notes) parts.push(extraction.shared_fields.notes);
    for (const row of extraction.rows) {
      if (row.kids_policy) parts.push(row.kids_policy);
      if (row.other_included) parts.push(row.other_included);
      if (row.feeds_adicionales) parts.push(row.feeds_adicionales);
    }
  }
  return parts.filter((p): p is string => !!p && p.trim() !== "").join(" ").toLowerCase();
}

/** Detecta si el contrato prohíbe cuádruple/quíntuple (ej. Belmar: max 2 adultos). */
export function detectOccupancyPolicy(
  brief: ContractBrief | null | undefined,
  extraction?: ExtractedContract,
): OccupancyPolicy {
  if (brief?.quadruple_allowed === false) {
    return { quadrupleAllowed: false, quintupleAllowed: false };
  }
  if (
    brief?.max_adults_per_room != null &&
    brief.max_adults_per_room <= 3
  ) {
    return { quadrupleAllowed: false, quintupleAllowed: false };
  }

  const haystack = contractTextHaystack(brief, extraction);
  const prohibitsQuad =
    /no se admiten?\s*4\s*adultos/.test(haystack) ||
    /no\s*(se\s*)?(permit|admit)[a-z\s]*cu[aá]druple/.test(haystack) ||
    /cu[aá]druple\s*no\s*(se\s*)?(permit|aplica)/.test(haystack) ||
    (/ocupaci[oó]n\s+base\s*2\s*personas/.test(haystack) &&
      /no.*4\s*adultos/.test(haystack)) ||
    /m[aá]ximo\s*2\s*(adultos?|personas?|hu[eé]spedes?)/.test(haystack) ||
    /maximum\s*occupancy\s*(of\s*)?2/.test(haystack);

  if (prohibitsQuad) {
    return { quadrupleAllowed: false, quintupleAllowed: false };
  }

  return { quadrupleAllowed: true, quintupleAllowed: true };
}

export function filterOccupancyCodesByPolicy(
  codes: string[],
  policy: OccupancyPolicy,
): string[] {
  return codes.filter((c) => {
    if (c === "QDP" && !policy.quadrupleAllowed) return false;
    if (c === "QTN" && !policy.quintupleAllowed) return false;
    return true;
  });
}

/** Extrae días de prepago/crédito desde range_payment_policy (ej. "45 días"). */
export function derivePlazoDaysFromPaymentPolicy(
  text: string | null | undefined,
): string | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  const match = raw.match(/(\d{1,3})\s*d[ií]as?/i);
  return match?.[1] ?? null;
}

/** Elimina filas QDP/QTN cuando el contrato no las permite. */
export function removeForbiddenOccupancyRows(
  extraction: ExtractedContract,
  policy: OccupancyPolicy,
  warnings: string[],
): ExtractedContract {
  if (policy.quadrupleAllowed && policy.quintupleAllowed) return extraction;

  const forbidden = new Set<string>();
  if (!policy.quadrupleAllowed) forbidden.add("QDP");
  if (!policy.quintupleAllowed) forbidden.add("QTN");

  let removed = 0;
  const rows: ContractRow[] = [];
  const pages: Record<string, import("./types.js").SourcePage>[] = [];
  extraction.rows.forEach((row, i) => {
    const occ = normalizeOccupancyCode(row.ocupacion ?? "");
    if (forbidden.has(occ)) {
      removed += 1;
      return;
    }
    rows.push(row);
    pages.push(extraction.paginas_origen_rows[i] ?? {});
  });

  if (removed > 0) {
    warnings.push(
      `Se eliminaron ${removed} fila(s) ${[...forbidden].join("/")} — el contrato ` +
        "no admite cuádruple/quíntuple en ninguna categoría.",
    );
  }

  return {
    ...extraction,
    rows,
    paginas_origen_rows: pages.length > 0 ? pages : extraction.paginas_origen_rows,
  };
}

/** Alinea season_starts/season_ends de cada fila con seasons_detail del brief. */
export function syncSeasonDatesFromBrief(
  extraction: ExtractedContract,
  brief: ContractBrief | null | undefined,
  warnings: string[],
): ExtractedContract {
  if (!brief?.seasons_detail?.length) return extraction;

  const bySeason = new Map<
    string,
    { starts: string | null; ends: string | null }
  >();
  for (const sd of brief.seasons_detail) {
    const name = (sd.name ?? "").trim();
    if (!name) continue;
    bySeason.set(normalizeSeasonKey(name), {
      starts: sd.starts,
      ends: sd.ends,
    });
  }
  if (bySeason.size === 0) return extraction;

  let adjusted = 0;
  const rows = extraction.rows.map((row) => {
    const seasonName = (row.season_name ?? "").trim();
    if (!seasonName) return row;
    const detail = bySeason.get(normalizeSeasonKey(seasonName));
    if (!detail) return row;

    let next = row;
    if (detail.starts && row.season_starts !== detail.starts) {
      next = { ...next, season_starts: detail.starts };
      adjusted += 1;
    }
    if (detail.ends && row.season_ends !== detail.ends) {
      next = { ...next, season_ends: detail.ends };
      adjusted += 1;
    }
    return next;
  });

  if (adjusted > 0) {
    warnings.push(
      `Se sincronizaron ${adjusted} fecha(s) de temporada según el brief confirmado.`,
    );
  }

  return { ...extraction, rows };
}

/** Completa occupancies_by_product desde categorías si el brief no lo trae. */
export function enrichBriefOccupancies(brief: ContractBrief): ContractBrief {
  const policy = detectOccupancyPolicy(brief, undefined);
  if ((brief.occupancies_by_product ?? []).length > 0) {
    return {
      ...brief,
      occupancies_by_product: brief.occupancies_by_product.map((spec) => ({
        ...spec,
        occupancy_codes: filterOccupancyCodesByPolicy(
          spec.occupancy_codes,
          policy,
        ),
      })),
    };
  }
  if (brief.product_categories.length === 0) return brief;
  return {
    ...brief,
    occupancies_by_product: buildOccupanciesByProductFromCategories(
      brief.product_categories,
      brief,
    ).map((spec) => ({
      ...spec,
      occupancy_codes: filterOccupancyCodesByPolicy(
        spec.occupancy_codes,
        policy,
      ),
    })),
  };
}
