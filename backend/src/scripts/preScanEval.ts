/**
 * Pre-scan REGRESSION RUNNER (sin IA, sin DB, sin API key).
 *
 * Cada caso es una carpeta en `backend/evals/prescan/<slug>/` con uno o más
 * documentos del MISMO contrato y un `expected.json` (formato documentado en
 * `preScanEvalCore.ts`). Corre el mismo `preScan()` del Paso 1 y compara.
 *
 *   npm run eval:prescan                 # todos los casos del repo
 *   npm run eval:prescan -- --case rios-lodge-2027
 *   npm run eval:prescan -- --dump       # imprime el resultado completo del caso
 *
 * Los casos creados desde la UI viven en la DB y se corren desde el portal
 * («Casos de prueba» → «Correr verificación»), no desde aquí.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRepoCases, runEvalCase } from "../agents/supplier-intelligence/preScanEvalCore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..", "evals", "prescan");

const args = process.argv.slice(2);
const onlyCase = args.includes("--case") ? args[args.indexOf("--case") + 1] : null;
const dump = args.includes("--dump");

async function main(): Promise<void> {
  const cases = loadRepoCases(ROOT, onlyCase);
  if (cases.length === 0) {
    console.error(`No hay casos en ${ROOT}`);
    process.exit(1);
  }
  let failed = 0;
  for (const c of cases) {
    const { result } = await runEvalCase(c, undefined, { dump });
    if (result.error) {
      failed += 1;
      console.log(`\n✖ ${result.slug}  ERROR: ${result.error}`);
      continue;
    }
    const bad = result.checks.filter((x) => !x.ok);
    failed += bad.length;
    console.log(`\n${bad.length === 0 ? "✔" : "✖"} ${result.slug}  (${result.checks.length} checks, ${result.ms} ms)`);
    for (const x of bad) {
      console.log(`   ✖ ${x.name}\n      expected: ${JSON.stringify(x.expected)}\n      actual:   ${JSON.stringify(x.actual)}`);
    }
  }
  console.log(failed === 0 ? "\nAll pre-scan checks passed." : `\n${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
