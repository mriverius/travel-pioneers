"use client";

import { ArrowLeft, History } from "lucide-react";
import Link from "next/link";
import { HistoryTable } from "../history";

/**
 * Supplier-intelligence history sub-page.
 *
 * Lives at `/agent/supplier-intelligence/history`. Pulls fictitious data via
 * `useFakeHistory` for now; swap to a real `GET /api/supplier-intelligence/history`
 * when the backend lands. Layout: back link + page header + filterable table.
 */
export default function SupplierIntelligenceHistoryPage() {
  return (
    <div className="space-y-5">
      {/* Back link */}
      <Link
        href="/agent/supplier-intelligence"
        className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Volver al agente
      </Link>

      {/* Header */}
      <header className="flex items-start gap-3">
        <div className="w-11 h-11 rounded-xl bg-primary/10 border border-primary/30 flex items-center justify-center shrink-0">
          <History className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-[24px] font-bold tracking-tight text-foreground">
            Historial de contratos
          </h1>
          <p className="mt-1 text-[13.5px] text-muted-foreground">
            Tabla con todos los contratos procesados por el agente. Filtra por
            estado, tipo de archivo o fecha; abre cualquier fila para ver los
            52 campos extraídos.
          </p>
        </div>
      </header>

      {/* Table */}
      <HistoryTable />
    </div>
  );
}
