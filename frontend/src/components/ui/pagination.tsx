"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Select } from "@/components/ui/select";

export function Pagination({
  rangeStart,
  rangeEnd,
  total,
  page,
  totalPages,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: {
  rangeStart: number;
  rangeEnd: number;
  total: number;
  page: number;
  totalPages: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}) {
  // Build the page-number pill list. For long result sets, collapse the
  // middle with "…" so we never render an unbounded strip of buttons.
  const pages = buildPageList(page, totalPages);

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between px-4 sm:px-6 py-3 border-t border-border bg-secondary/20">
      <div className="flex items-center gap-3 text-[12.5px] text-muted-foreground">
        <span>
          Mostrando{" "}
          <span className="font-semibold text-foreground">
            {rangeStart}–{rangeEnd}
          </span>{" "}
          de <span className="font-semibold text-foreground">{total}</span>
        </span>
        <span className="hidden sm:inline-block h-4 w-px bg-border" />
        <div className="hidden sm:flex items-center gap-2">
          <span>Por página:</span>
          <div className="w-20">
            <Select
              options={[
                { value: "10", label: "10" },
                { value: "25", label: "25" },
                { value: "50", label: "50" },
              ]}
              value={String(pageSize)}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
            />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="Página anterior"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        {pages.map((p, i) =>
          p === "…" ? (
            <span
              key={`gap-${i}`}
              className="px-1.5 text-[12.5px] text-muted-foreground select-none"
            >
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              onClick={() => onPageChange(p)}
              aria-current={p === page ? "page" : undefined}
              className={`min-w-[32px] h-8 px-2 rounded-md text-[12.5px] font-medium border transition-colors ${
                p === page
                  ? "bg-primary/15 border-primary/40 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground hover:bg-secondary/60"
              }`}
            >
              {p}
            </button>
          ),
        )}

        <button
          type="button"
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="Página siguiente"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * Compact page number strip. Always shows first / last page, the current
 * page, and its immediate neighbours. Gaps are filled with "…" sentinels.
 *
 * Examples (current page in parens):
 *   totalPages=5, page=(3) → [1, 2, (3), 4, 5]
 *   totalPages=10, page=(1) → [(1), 2, 3, "…", 10]
 *   totalPages=10, page=(5) → [1, "…", 4, (5), 6, "…", 10]
 *   totalPages=10, page=(10) → [1, "…", 8, 9, (10)]
 */
export function buildPageList(
  page: number,
  totalPages: number,
): (number | "…")[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const out: (number | "…")[] = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(totalPages - 1, page + 1);
  if (start > 2) out.push("…");
  for (let i = start; i <= end; i++) out.push(i);
  if (end < totalPages - 1) out.push("…");
  out.push(totalPages);
  return out;
}
