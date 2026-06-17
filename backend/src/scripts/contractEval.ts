/**
 * Contract extraction EVAL HARNESS (general — scales to N contracts).
 *
 * This is NOT a Grano-de-Oro-specific test. It's a framework: every contract
 * you want to guard becomes a pair of files in `backend/evals/contracts/`:
 *
 *     <slug>.pdf            (or .png/.jpg/.docx/.xlsx — the real contract)
 *     <slug>.expected.json  (the ground-truth assertions for that contract)
 *
 * The runner discovers every pair, runs the SAME pipeline the app uses
 * (analyzeContractBrief → extractContract), and scores the output against the
 * expectations. Add the next of your 400 contracts by dropping two files in —
 * no code changes.
 *
 * Usage (from backend/, needs ANTHROPIC_API_KEY in env / .env):
 *   npx tsx src/scripts/contractEval.ts                  # run every fixture
 *   npx tsx src/scripts/contractEval.ts --case grano-de-oro-2026
 *   npx tsx src/scripts/contractEval.ts --brief-only     # skip the row pass (cheap/fast)
 *   npx tsx src/scripts/contractEval.ts --inspect path/to/contract.pdf
 *        ^ DEBUG MODE: runs only the brief and dumps the raw JSON the model
 *          returned. Use this to see exactly why Step 2 is empty.
 *
 * Exit code is non-zero if any assertion fails, so this is CI-friendly.
 */
import "dotenv/config";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectDocKind,
  prepareDocument,
} from "../agents/supplier-intelligence/extractors/index.js";
import {
  analyzeContractBrief,
  extractContract,
  type PreparedDocumentInput,
} from "../agents/supplier-intelligence/service.js";
import type {
  ContractBrief,
  ExtractedContract,
} from "../agents/supplier-intelligence/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = resolve(HERE, "../../evals/contracts");

const DOC_EXTENSIONS = new Set([
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".docx",
  ".xlsx",
]);

/* ----------------------------- expectations ------------------------------ */

interface ExpectedRow {
  /** Substring match (case-insensitive) against product_name. */
  product: string;
  /** Substring match against season_name. */
  season: string;
  /** Optional occupancy to disambiguate (e.g. "DBL"). */
  ocupacion?: string;
  precio_rack_iva?: number;
  precios_neto_iva?: number;
  porcentaje_comision?: number;
}

interface Expected {
  shared_fields?: Partial<Record<string, string>>;
  prices_include_tax?: boolean;
  tax_rate_pct?: number;
  commission_default_pct?: number;
  /** Season NAMES that must each appear. */
  seasons?: string[];
  /** Minimum number of rows the extraction must produce. */
  min_rows?: number;
  rows?: ExpectedRow[];
  /** Absolute tolerance for price comparisons. Default 1.0. */
  price_tolerance?: number;
}

interface Check {
  label: string;
  ok: boolean;
  detail?: string;
}

/* ------------------------------- helpers --------------------------------- */

const norm = (s: unknown): string =>
  (typeof s === "string" ? s : "").trim().toLowerCase();

function parseAmount(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[^0-9.,-]/g, "").trim();
  if (cleaned === "") return null;
  let n = cleaned;
  if (n.includes(",") && n.includes(".")) n = n.replace(/,/g, "");
  else if (n.includes(",")) n = n.replace(",", ".");
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

async function prepareCase(filePath: string): Promise<PreparedDocumentInput> {
  const buf = readFileSync(filePath);
  const kind = detectDocKind(undefined, filePath);
  if (!kind) throw new Error(`Unsupported file type: ${filePath}`);
  const doc = await prepareDocument(kind, buf, undefined, filePath);
  return { ...doc, originalName: filePath.split("/").pop() ?? "contract" };
}

/* ------------------------------- scoring --------------------------------- */

function scoreBrief(brief: ContractBrief, exp: Expected): Check[] {
  const checks: Check[] = [];

  if (exp.shared_fields) {
    for (const [key, want] of Object.entries(exp.shared_fields)) {
      if (want == null) continue;
      const got = (brief.shared_fields as unknown as Record<string, string | null>)[
        key
      ];
      const ok = norm(got).includes(norm(want)) || norm(want).includes(norm(got));
      checks.push({
        label: `shared.${key}`,
        ok: ok && norm(got) !== "",
        detail: `want≈"${want}" got="${got ?? ""}"`,
      });
    }
  }

  if (exp.prices_include_tax !== undefined) {
    checks.push({
      label: "prices_include_tax",
      ok: brief.prices_include_tax === exp.prices_include_tax,
      detail: `want=${exp.prices_include_tax} got=${brief.prices_include_tax}`,
    });
  }
  if (exp.tax_rate_pct !== undefined) {
    checks.push({
      label: "tax_rate_pct",
      ok: brief.tax_rate_pct === exp.tax_rate_pct,
      detail: `want=${exp.tax_rate_pct} got=${brief.tax_rate_pct}`,
    });
  }
  if (exp.commission_default_pct !== undefined) {
    checks.push({
      label: "commission_default_pct",
      ok: brief.commission_default_pct === exp.commission_default_pct,
      detail: `want=${exp.commission_default_pct} got=${brief.commission_default_pct}`,
    });
  }

  if (exp.seasons) {
    const haystack = [
      ...brief.seasons.map(norm),
      ...brief.seasons_detail.map((s) => norm(s.name)),
    ];
    for (const season of exp.seasons) {
      const ok = haystack.some(
        (h) => h.includes(norm(season)) || norm(season).includes(h),
      );
      checks.push({
        label: `season "${season}"`,
        ok,
        detail: ok ? "" : `not found in [${brief.seasons.join(", ")}]`,
      });
    }
  }

  return checks;
}

function scoreRows(extraction: ExtractedContract, exp: Expected): Check[] {
  const checks: Check[] = [];
  const tol = exp.price_tolerance ?? 1.0;

  if (exp.min_rows !== undefined) {
    checks.push({
      label: `min_rows >= ${exp.min_rows}`,
      ok: extraction.rows.length >= exp.min_rows,
      detail: `got ${extraction.rows.length} rows`,
    });
  }

  for (const er of exp.rows ?? []) {
    const match = extraction.rows.find((r) => {
      const okProduct = norm(r.product_name).includes(norm(er.product));
      const okSeason = norm(r.season_name).includes(norm(er.season));
      const okOcc =
        er.ocupacion === undefined ||
        norm(r.ocupacion) === norm(er.ocupacion) ||
        (norm(er.ocupacion) === "dbl" && norm(r.ocupacion) === "");
      return okProduct && okSeason && okOcc;
    });
    const tag = `${er.product} / ${er.season}${er.ocupacion ? ` / ${er.ocupacion}` : ""}`;
    if (!match) {
      checks.push({ label: `row ${tag}`, ok: false, detail: "row not found" });
      continue;
    }
    const cmp = (field: string, want: number | undefined, raw: string | null) => {
      if (want === undefined) return;
      const got = parseAmount(raw);
      const ok = got !== null && Math.abs(got - want) <= tol;
      checks.push({
        label: `row ${tag} · ${field}`,
        ok,
        detail: `want=${want}±${tol} got=${got ?? "null"}`,
      });
    };
    cmp("precio_rack_iva", er.precio_rack_iva, match.precio_rack_iva);
    cmp("precios_neto_iva", er.precios_neto_iva, match.precios_neto_iva);
    cmp("porcentaje_comision", er.porcentaje_comision, match.porcentaje_comision);
  }

  return checks;
}

/* --------------------------------- run ----------------------------------- */

function printChecks(name: string, checks: Check[]): boolean {
  const passed = checks.filter((c) => c.ok).length;
  const allOk = passed === checks.length;
  const head = allOk ? "✅ PASS" : "❌ FAIL";
  console.log(`\n${head}  ${name}  (${passed}/${checks.length})`);
  for (const c of checks) {
    const mark = c.ok ? "  ✓" : "  ✗";
    console.log(`${mark} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  return allOk;
}

async function runInspect(filePath: string): Promise<void> {
  console.log(`\n🔍 Inspecting brief for: ${filePath}\n`);
  const doc = await prepareCase(resolve(process.cwd(), filePath));
  const { brief, model, usage } = await analyzeContractBrief([doc], "eval-inspect", {
    isExistingSupplier: false,
  });
  console.log(`model: ${model}  ·  tokens in/out: ${usage.inputTokens}/${usage.outputTokens}  ·  cost $${usage.costUsd}`);
  console.log("\n--- RAW BRIEF ---");
  console.log(JSON.stringify(brief, null, 2));
  console.log("\nseasons:", brief.seasons);
  console.log("seasons_detail count:", brief.seasons_detail.length);
}

function discoverCases(): { slug: string; file: string; expected: string }[] {
  if (!existsSync(CONTRACTS_DIR)) return [];
  const files = readdirSync(CONTRACTS_DIR);
  const cases: { slug: string; file: string; expected: string }[] = [];
  for (const f of files) {
    const ext = extname(f).toLowerCase();
    if (!DOC_EXTENSIONS.has(ext)) continue;
    const slug = f.slice(0, -ext.length);
    const expected = join(CONTRACTS_DIR, `${slug}.expected.json`);
    if (existsSync(expected)) {
      cases.push({ slug, file: join(CONTRACTS_DIR, f), expected });
    }
  }
  return cases;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inspectIdx = args.indexOf("--inspect");
  if (inspectIdx !== -1) {
    const p = args[inspectIdx + 1];
    if (!p) throw new Error("--inspect requires a file path");
    await runInspect(p);
    return;
  }

  const briefOnly = args.includes("--brief-only");
  const caseIdx = args.indexOf("--case");
  const onlySlug = caseIdx !== -1 ? args[caseIdx + 1] : null;

  let cases = discoverCases();
  if (onlySlug) cases = cases.filter((c) => c.slug === onlySlug);

  if (cases.length === 0) {
    console.log(
      `No fixtures found in ${CONTRACTS_DIR}.\n` +
        `Add a contract + "<slug>.expected.json" pair to start. See evals/README.md.`,
    );
    return;
  }

  console.log(`Running ${cases.length} case(s)${briefOnly ? " (brief-only)" : ""}…`);
  let allPassed = true;

  for (const c of cases) {
    const exp = JSON.parse(readFileSync(c.expected, "utf8")) as Expected;
    const doc = await prepareCase(c.file);

    const { brief } = await analyzeContractBrief([doc], `eval-${c.slug}`, {
      isExistingSupplier: false,
    });
    const briefChecks = scoreBrief(brief, exp);
    allPassed = printChecks(`${c.slug} · brief`, briefChecks) && allPassed;

    if (!briefOnly) {
      const { data } = await extractContract(
        [doc],
        `eval-${c.slug}`,
        { isExistingSupplier: false },
        [brief],
      );
      const rowChecks = scoreRows(data, exp);
      if (rowChecks.length > 0) {
        allPassed = printChecks(`${c.slug} · rows`, rowChecks) && allPassed;
      }
    }
  }

  console.log(`\n${allPassed ? "✅ ALL PASSED" : "❌ SOME FAILED"}`);
  if (!allPassed) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Eval runner crashed:", err);
  process.exitCode = 1;
});
