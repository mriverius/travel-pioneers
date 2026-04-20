import { FileText, CircleHelp, Download } from "lucide-react";

type Guide = {
  title: string;
  description: string;
};

const guides: Guide[] = [
  {
    title: "Guía del AI Supplier Intelligence Agent",
    description:
      "Cómo usar el sistema para procesar contratos y generar plantillas Utopía",
  },
  {
    title: "Formato de plantillas Utopía",
    description:
      "Especificaciones de las plantillas de proveedor y tarifas generadas",
  },
];

type Faq = {
  question: string;
  answer: string;
};

const faqs: Faq[] = [
  {
    question: "¿Qué tipos de contratos puede procesar el agente?",
    answer:
      "El agente puede procesar contratos de proveedores turísticos en formato PDF o Word. Esto incluye contratos de hoteles, transportistas, operadores de tours, DMCs y otros proveedores de servicios turísticos.",
  },
  {
    question: "¿Qué formato tienen las plantillas que genera?",
    answer:
      "El sistema genera dos plantillas Excel estructuradas: una plantilla de proveedor (datos generales, contacto, condiciones) y una plantilla de tarifas (temporadas, tipos de habitación, régimen, precios). Ambas listas para carga directa en Utopía.",
  },
  {
    question: "¿Qué pasa si el contrato tiene información ambigua?",
    answer:
      "El agente detecta automáticamente información ambigua, incompleta o contradictoria y la señala en los resultados para que pueda ser revisada y completada manualmente antes de la carga.",
  },
  {
    question: "¿Cómo subo un contrato al sistema?",
    answer:
      "Simplemente envíe el archivo PDF o Word directamente en el chat del agente. Puede arrastrarlo a la ventana del chat o usar el botón de adjuntar archivo.",
  },
];

export default function ResourcesPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[28px] font-bold tracking-tight text-foreground">
          Cómo usar el sistema
        </h1>
        <p className="text-sm text-muted-foreground mt-1.5">
          Documentación y guías del AI Supplier Intelligence Agent.
        </p>
      </header>

      {/* Documentos */}
      <section className="bg-card/80 border border-border rounded-xl">
        <header className="flex items-center gap-2.5 px-6 pt-5 pb-4 border-b border-border">
          <FileText className="w-5 h-5 text-primary" />
          <h2 className="text-[15px] font-semibold">Documentos y guías</h2>
        </header>
        <div className="p-4 space-y-3">
          {guides.map((g) => (
            <article
              key={g.title}
              className="flex items-center gap-4 p-4 bg-secondary/40 border border-border/70 rounded-lg hover:bg-secondary/60 transition-colors"
            >
              <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                <FileText className="w-5 h-5 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[14px] font-semibold text-foreground">
                  {g.title}
                </p>
                <p className="text-[12.5px] text-muted-foreground mt-0.5">
                  {g.description}
                </p>
              </div>
              <button
                type="button"
                className="inline-flex items-center px-3 py-1.5 rounded-md border border-border text-[12.5px] text-primary hover:bg-primary/10 transition-colors"
              >
                <Download className="w-4 h-4 mr-1.5" />
                Descargar
              </button>
            </article>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section className="bg-card/80 border border-border rounded-xl">
        <header className="flex items-center gap-2.5 px-6 pt-5 pb-4 border-b border-border">
          <CircleHelp className="w-5 h-5 text-primary" />
          <h2 className="text-[15px] font-semibold">Preguntas frecuentes</h2>
        </header>
        <div className="p-4 space-y-3">
          {faqs.map((f) => (
            <article
              key={f.question}
              className="bg-secondary/40 border border-border/70 rounded-lg p-4"
            >
              <p className="text-[14px] font-semibold text-foreground">
                {f.question}
              </p>
              <p className="text-[13px] text-muted-foreground mt-2 leading-relaxed">
                {f.answer}
              </p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
