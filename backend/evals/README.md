# Contract extraction evals

A **general** regression harness for the supplier-intelligence extractor. It is
not tied to any one contract — it's designed to grow to all ~400 contracts. Each
contract you want to guard is two files in `evals/contracts/`:

```
<slug>.pdf              # or .png .jpg .jpeg .docx .xlsx — the real contract
<slug>.expected.json    # the ground-truth assertions for that contract
```

The runner discovers every pair, runs the exact app pipeline
(`analyzeContractBrief` → `extractContract`), and scores the output. Adding the
next contract is a copy-paste of two files — no code changes.

## Running

From `backend/` (needs `ANTHROPIC_API_KEY` in your env / `.env`):

```bash
# Run every fixture, score brief + rows, non-zero exit on any failure (CI-ready)
npx tsx src/scripts/contractEval.ts

# One contract only
npx tsx src/scripts/contractEval.ts --case grano-de-oro-2026

# Brief pass only (cheap/fast — checks IVA, commission, seasons, identity)
npx tsx src/scripts/contractEval.ts --brief-only

# DEBUG: dump the raw brief JSON the model returned for ANY file.
# Use this to see why Step 2 is empty.
npx tsx src/scripts/contractEval.ts --inspect path/to/contract.pdf
```

## `expected.json` schema

Every field is optional — assert only what you care about for that contract.

| field | meaning |
|---|---|
| `shared_fields` | object of identity fields; each is a **substring** match (case-insensitive) against the extracted value |
| `prices_include_tax` | boolean the brief must match exactly |
| `tax_rate_pct` | number the brief must match exactly |
| `commission_default_pct` | number the brief must match exactly |
| `seasons` | array of season **names**; each must appear in the detected seasons |
| `min_rows` | extraction must produce at least this many rows |
| `rows` | spot-checks: `{ product, season, ocupacion?, precio_rack_iva?, precios_neto_iva?, porcentaje_comision? }`. `product`/`season` are substring matches; prices compared within `price_tolerance` |
| `price_tolerance` | absolute tolerance for price comparisons (default `1.0`) |

`product` and `season` use substring matching so you don't have to reproduce the
exact extracted string — `"STANDARD"` matches `"STANDARD"`, `"Alta"` matches
`"Temporada Alta"`.

## Why prices look "off" in the fixture

When a contract's prices exclude tax (`prices_include_tax: false`), the system
**adds** the tax to produce the `*_iva` columns. So a `$230 + imp` rack rate
becomes `precio_rack_iva = 230 × 1.13 = 259.90`. The fixture encodes the
post-tax number on purpose — that's the math we most want to catch regressing.

## Suggested workflow for the 400 contracts

1. Start with ~10–15 contracts spanning your hard cases (nested grids, split
   seasons, multi-currency, net-rate vs rack, image-only scans).
2. Label each `expected.json` from the real contract (5 min each).
3. Wire `npx tsx src/scripts/contractEval.ts` into CI so prompt/schema/model
   changes can't silently regress accuracy.
4. Add contracts as they reveal new failure modes — the harness only grows.
