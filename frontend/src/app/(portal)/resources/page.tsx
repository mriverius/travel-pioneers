import { CircleHelp } from "lucide-react";

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
      "El sistema genera una plantilla Excel estructurada lista para carga directa en Utopía.",
  },
  {
    question: "¿Qué pasa si el contrato tiene información ambigua?",
    answer:
      "El agente detecta automáticamente información ambigua, incompleta o contradictoria y la señala en los resultados para que pueda ser revisada y completada manualmente antes de la carga.",
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
