# Pre-scan regression fixtures

Each folder is one contract (all its documents together) plus `expected.json`
with what the deterministic pre-scan must read from them. Run from `backend/`:

    npm run eval:prescan
    npm run eval:prescan -- --case rios-lodge-2027
    npm run eval:prescan -- --case rios-lodge-2027 --dump   # full output

No AI, no database, no API key: it runs in seconds, so run it after every
change to `preScanService.ts`. To add a supplier, drop its documents in a new
folder and write the `expected.json` from what the documents literally say
(see the field list at the top of `src/scripts/preScanEval.ts`).
