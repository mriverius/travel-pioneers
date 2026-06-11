# Contract Extraction Strategy — Travel Pioneers

This note answers two things you asked: **what's the best extraction approach** (Tesseract vs. Opus vs. a hybrid), and **how the new "Variables de Configuración" step makes extraction more reliable**. It also documents the changes that ship with this step.

## TL;DR

- **Keep Claude (Opus) as the extraction engine. Do not add Tesseract.** For these contracts, the failure mode is *reasoning over structure*, not OCR. Tesseract would make it worse.
- **The values come out wrong mostly because of bad *global rules*, not bad cell reads.** One wrong rule ("prices exclude IVA", wrong commission %, wrong season dates) silently corrupts every row.
- **The highest-leverage fix is the human-in-the-loop gate you asked for:** surface the global config, let the user correct it, then run the full extraction with the corrected rules. That's exactly what the new Step 2 does.
- We added deterministic, model-free validation that cross-checks the extracted rows against the confirmed config (IVA, commission, season coverage, row count).

## Why not Tesseract (or any OCR)?

Tesseract is an OCR engine: pixels → characters. It's the right tool when you have a *scanned image of text* and need the raw characters. It's the wrong tool here for three reasons:

1. **Your documents are mostly born-digital PDFs with real text layers.** Claude reads those natively, including layout. Running OCR over them throws away the structure and re-introduces character errors that aren't there today.
2. **The hard part is table topology, not glyphs.** Look at the Pacuare Lodge sheet: nested `season × room × occupancy` grids where a single price like `$1.958` only means something relative to its column header three rows up and its season banner above that. Tesseract returns a flat stream of tokens and loses the row/column relationships entirely. You'd then have to *re-build* the table — which is the actual hard problem, and the thing a vision-language model already does.
3. **Multilingual + mixed conventions.** The contracts mix Spanish/English, `$1.958` (dot-thousands) vs `$1,958`, split season ranges ("May 1–Jun 19 · Aug 21–Oct 31"). Claude handles these in context; OCR + regex pipelines are brittle against them.

When OCR *is* worth it: a supplier sends a **photo or scan** with no text layer (e.g. a phone picture of a printed rate sheet). Even then, prefer Claude's native vision (`image` block) over Tesseract — the model reads the image and the table structure in one step. The codebase already does this (`extractors/image.ts`, `kind: "image"` blocks). Only reach for a dedicated OCR pass if you start seeing low-resolution scans where vision struggles, and even then layout-aware OCR (AWS Textract / Google Document AI / Azure Document Intelligence) beats Tesseract for tables.

## Recommended architecture

```
                ┌──────────── Step 1: Upload ────────────┐
                │  PDF / DOCX / XLSX / image (native)     │
                └───────────────────┬─────────────────────┘
                                    │
                 POST /analyze-brief │  (Fase 1 — Sonnet, cheap & fast)
                                    ▼
        ┌──────── Step 2: Variables de Configuración (NEW) ────────┐
        │  IVA? · commission % · seasons+dates · additional person  │
        │  · banks · meal plan · special periods · row estimate     │
        │  → user CONFIRMS / CORRECTS  ◀── the highest-leverage gate │
        └───────────────────────────┬───────────────────────────────┘
                                    │  confirmed config
                  POST /extract      │  (Fase 2 — Opus, skips Fase 1,
                                    ▼   uses confirmed rules verbatim)
        ┌──────── Step 3: Review rows ────────┐   deterministic checks
        │  52-col grid, per-row edits          │ ◀ cross-check vs config
        └───────────────────┬──────────────────┘   (IVA / commission /
                            │                        seasons / row count)
              POST /generate-xlsx                    surfaced as warnings
                            ▼
                ┌──── Step 4: Download xlsx ────┐
                └───────────────────────────────┘
```

This is a small evolution of what you already had. You were *already* running a two-pass flow (a hidden "brief" pass on Sonnet, then the Opus grid-fill). All we did was **pull the brief out into the open and let the user correct it before it drives extraction.**

### Why the gate works

The brief/extract split exists because of a real failure pattern (documented in `briefSchema.ts`): when Opus is forced to emit dozens of rows in one shot with `tool_choice`, it loses track of global rules — it copied prices without adding the 13% IVA across 127 rows, captured only one of four bank accounts, etc. The brief pass fixes that by capturing the rules in a small, focused call.

But until now the brief was *auto-injected* — if the brief got IVA wrong, that error still propagated to every row, just faster. **The gate closes that hole:** the one place a human can catch a global error in 5 seconds (a toggle, a percentage, a date) is before it's multiplied across 100 rows. After that point, the same error is buried in a 52-column × N-row grid and is far more expensive to find.

## What shipped with this change

### Backend
- `prompts/briefSchema.ts` — the brief tool now also captures `commission_default_pct` (as a number), `currency`, and `seasons_detail` (each season with `starts`/`ends`/`raw_range`, so split ranges survive).
- `types.ts` — `ContractBrief` extended with those fields + new `ContractBriefSeason`.
- `service.ts`
  - `analyzeContractBrief(...)` — public Fase-1-only entry point for the new endpoint.
  - `extractContract(..., briefOverride?)` — when the confirmed config is passed, **Fase 1 is skipped** and the user's rules are used directly. No wasted second analysis pass.
  - `coerceBrief` is now exported and parses the new fields.
- `prompts/briefPrompt.ts` — the injected "CONTRACT BRIEF" block now renders the default commission, currency, and per-season dates as explicit instructions ("use EXACTLY these ranges for season_starts/ends").
- `controller.ts` — new `analyzeBriefHandler`; `extractContractHandler` now parses an optional `brief` form field (the confirmed config) and forwards it. Shared upload prep extracted into `prepareUploadedDocs`.
- `routes/supplierIntelligence.ts` — new `POST /analyze-brief` (same upload middleware + rate limit as `/extract`).
- `validators.ts` — new `validateAgainstBrief(...)`, run inside `validateExtraction`. Deterministic, no model calls:
  - **IVA:** if the user confirmed "prices exclude IVA", emit an explicit verify-all-rows warning.
  - **Commission:** flags rows whose implied commission (`(rack − net) / rack`) deviates > 2 points from the confirmed default (only when there are no per-section overrides).
  - **Seasons:** flags confirmed seasons that don't appear in any row (missing combinations).
  - **Completeness:** flags when row count is < 70% of the confirmed estimate.

### Frontend
- `lib/api.ts` — `ContractConfigVariables` (+ sub-types) mirroring the backend, `analyzeBrief(files, input)`, and a `confirmedConfig` field on `extract`.
- `configStep.tsx` (new) — the editable Step 2: tri-state IVA toggle, tax rate, currency, default commission %, expected rows, per-section commission, editable seasons (name + dates), additional-person rates, bank accounts, meal plan, special periods, notes.
- `workflow.tsx` — now a 4-step flow. Step 1 calls `analyzeBrief` (fast); Step 2 is the config gate; confirming runs `extract` with the corrected config and then the supplier match; Steps 3/4 are the existing review + download.

## Operational notes / tuning

- **Cost & latency:** the gate adds one cheap Sonnet call up front (`/analyze-brief`), but the subsequent `/extract` *skips* its own Fase 1, so the net extra cost is roughly one brief pass — and you spend it on the run that's most likely to need correction. The user's wait is also better distributed (quick analyze → review → longer extract that they kicked off knowingly).
- **"Doesn't miss details":** completeness is enforced from three directions now — the brief's `expected_row_estimate`, the season-coverage check, and the existing occupancy expansion (TPL/QDP) and section inventory in the prompt. The config gate lets the user bump the estimate or add a missing season so the warning fires if extraction comes up short.
- **If you later get true scans:** add a pre-step that routes no-text-layer PDFs/images through layout-aware OCR (Textract/Document AI) and feed the result to the same pipeline — don't replace Claude with it.
- **Schema is the contract:** because extraction is `tool_choice`-forced, the JSON schema is your strongest guardrail. Keep widening *descriptions* (cheap, high-yield) before adding more passes.
