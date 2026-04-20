import { FileText, FileSpreadsheet, Download } from "lucide-react";
import { ChatAgent } from "./chat-agent";

type HistoryItem = {
  name: string;
  date: string;
  status: "Completado" | "Error";
};

const history: HistoryItem[] = [
  {
    name: "Contrato_Hotel_Pacífico_2026.pdf",
    date: "28 Mar 2026",
    status: "Completado",
  },
  {
    name: "Tarifas_TransporteCR_Q2.pdf",
    date: "25 Mar 2026",
    status: "Completado",
  },
  {
    name: "Acuerdo_TourOperador_Aventura.docx",
    date: "22 Mar 2026",
    status: "Completado",
  },
  {
    name: "Rates_ResortPlaya_2026.pdf",
    date: "19 Mar 2026",
    status: "Completado",
  },
  {
    name: "Contrato_DMC_Guatemala.pdf",
    date: "15 Mar 2026",
    status: "Error",
  },
];

export default function SupplierIntelligencePage() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <header>
        <h1 className="text-[28px] font-bold tracking-tight text-foreground">
          AI Supplier Intelligence Agent
        </h1>
        <p className="text-sm text-muted-foreground mt-1.5">
          Procesamiento inteligente de contratos de proveedores turísticos
        </p>
      </header>

      {/* Chat card */}
      <ChatAgent />

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <StatCard
          icon={<FileText className="w-4 h-4 text-primary" />}
          value="47"
          title="Contratos procesados"
          subtitle="Este mes"
        />
        <StatCard
          icon={<FileSpreadsheet className="w-4 h-4 text-blue-400" />}
          value="94"
          title="Plantillas generadas"
          subtitle="Proveedor + Tarifas"
        />
      </div>

      {/* History */}
      <section className="bg-card/80 border border-border rounded-xl">
        <header className="flex items-center gap-2.5 px-6 pt-5 pb-4 border-b border-border">
          <FileText className="w-4 h-4 text-primary" />
          <h2 className="text-[15px] font-semibold text-foreground">
            Historial de documentos procesados
          </h2>
        </header>
        <ul className="divide-y divide-border/60">
          {history.map((item) => (
            <li
              key={item.name}
              className="flex items-center gap-3 px-6 py-3.5 hover:bg-secondary/30 transition-colors"
            >
              <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="text-sm text-foreground/90 flex-1 truncate">
                {item.name}
              </span>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {item.date}
              </span>
              <span
                className={`text-xs font-medium px-2 py-0.5 rounded ${
                  item.status === "Completado"
                    ? "text-primary"
                    : "text-destructive"
                }`}
              >
                {item.status}
              </span>
              <button
                type="button"
                aria-label={`Descargar ${item.name}`}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function StatCard({
  icon,
  value,
  title,
  subtitle,
}: {
  icon: React.ReactNode;
  value: string;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="bg-card/80 border border-border rounded-xl p-5">
      <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center mb-4">
        {icon}
      </div>
      <p className="text-[28px] font-bold leading-none text-foreground">
        {value}
      </p>
      <p className="text-sm text-foreground/90 mt-2">{title}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
    </div>
  );
}
