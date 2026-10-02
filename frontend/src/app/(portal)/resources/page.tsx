import {
  Activity,
  BookMarked,
  CircleHelp,
  FlaskConical,
  History,
  ListChecks,
  ScanSearch,
  ShieldCheck,
} from "lucide-react";

type Faq = {
  question: string;
  answer: string;
};

type Step = {
  title: string;
  body: string;
  icon: React.ReactNode;
};

const steps: Step[] = [
  {
    title: "Paso 1 · Documentos y contexto",
    icon: <ScanSearch className="w-4 h-4" />,
    body:
      "Arrastra todos los documentos del contrato (tarifario, políticas, carta bancaria). En cuanto los sueltas, un lector sin IA identifica al proveedor del maestro y extrae lo que se puede leer literalmente: cédula, cuentas, moneda, vigencia, temporadas, impuestos, comisión, políticas. Confirma el proveedor y escribe en «Comentarios adicionales» todo lo que sepas por correo o por experiencia: los comentarios son la fuente de verdad y mandan sobre el documento.",
  },
  {
    title: "Paso 2 · Reglas globales y preguntas",
    icon: <ShieldCheck className="w-4 h-4" />,
    body:
      "La IA propone las reglas globales del contrato (IVA, comisión, moneda, temporadas, cuentas, inventario de productos). Un revisor sin IA las contrasta contra el documento y contra la aritmética, y te presenta hallazgos por severidad y, cuando hay que decidir, preguntas con opciones. Cada respuesta corrige el brief y viaja a la extracción como instrucción tuya. Si el proveedor ya se procesó antes, verás su «memoria» (lo aprobado la última vez) para detectar diferencias.",
  },
  {
    title: "Paso 3 · Tabla y verificación",
    icon: <ListChecks className="w-4 h-4" />,
    body:
      "La IA genera una fila por producto × temporada × ocupación. El mismo revisor verifica la tabla: filas sin precio, duplicados, neto = rack × (1 − comisión), precios del documento que no aparecen, fechas de temporada inventadas, códigos de servicio que no existen para el proveedor. Corrige en la grilla o con el chat. Con errores pendientes, para descargar hay que confirmar explícitamente.",
  },
  {
    title: "Paso 4 · Excel y aprendizaje",
    icon: <History className="w-4 h-4" />,
    body:
      "Descarga el Excel para Utopía. Al aprobar, el sistema guarda el contrato en el historial, lo convierte en memoria del proveedor y registra qué corrigió la persona frente a lo que propuso la IA. Esa señal alimenta el panel de calidad y las sugerencias de reglas.",
  },
];

const adminTools: Step[] = [
  {
    title: "Reglas del agente",
    icon: <BookMarked className="w-4 h-4" />,
    body:
      "Conocimiento permanente de la agencia, en texto. Cada regla activa se aplica en todas las extracciones con prioridad alta (por encima del documento, por debajo de los comentarios de cada contrato). Cuando la misma corrección se repite en varios contratos de proveedores distintos, el sistema la propone aquí como sugerencia; un admin la acepta o descarta. Nada se convierte en regla solo.",
  },
  {
    title: "Calidad del agente",
    icon: <Activity className="w-4 h-4" />,
    body:
      "Métricas en vivo a partir de cada contrato aprobado: acierto del lector sin IA al detectar proveedores, cuánto corrige la persona al brief y a la tabla, cómo se responden las preguntas (ganó el documento o ganó la IA) y qué hallazgos se repiten. Sirve para decidir dónde invertir; cada contrato real es una medición gratis.",
  },
  {
    title: "Casos de prueba",
    icon: <FlaskConical className="w-4 h-4" />,
    body:
      "Contratos de referencia con los que se verifica el lector sin IA cuando alguien lo modifica. No hacen al sistema más inteligente: evitan que un arreglo para un proveedor rompa a otro. Se agregan desde el Paso 4 cuando un contrato tiene un formato nuevo (una vez por familia de formato basta) y se corren desde la pantalla, en segundos y sin costo de IA.",
  },
];

const faqs: Faq[] = [
  {
    question: "¿Qué tipos de contratos puede procesar el agente?",
    answer:
      "Contratos de proveedores turísticos en PDF, Word o Excel (y también imágenes o PDFs escaneados, que la IA lee como imagen aunque el lector sin IA no pueda ayudar). Incluye hoteles, transportistas, operadores de tours, DMCs y otros servicios.",
  },
  {
    question: "¿Qué manda cuando el documento y mis comentarios no coinciden?",
    answer:
      "Tus comentarios. El orden de prioridad del sistema es: comentarios del contrato en curso > reglas permanentes de la agencia > texto literal del documento > lo que leyó el lector sin IA > inferencias de la IA. Si sabes por correo que la comisión cambió, escríbelo en comentarios y la extracción lo respetará aunque el PDF diga otra cosa.",
  },
  {
    question: "¿El sistema aprende solo?",
    answer:
      "Aprende de forma explícita y visible, nunca a escondidas. La memoria del proveedor se actualiza con cada contrato aprobado; las reglas permanentes las escribe o acepta un admin (el sistema sólo sugiere); los casos de prueba los agrega una persona. El modelo de IA no se re-entrena con tus contratos.",
  },
  {
    question: "¿Qué pasa si un caso de prueba falla?",
    answer:
      "No significa que el Excel salga mal: el lector sin IA es una capa de apoyo y sus errores quedan visibles en el Paso 2. Significa que el lector dejó de entender ese formato y alguien del equipo técnico debe ajustarlo. La pantalla muestra qué esperaba y qué encontró para que lo puedas reportar tal cual.",
  },
  {
    question: "¿Qué pasa si el contrato tiene información ambigua?",
    answer:
      "El revisor la convierte en una pregunta con opciones en el Paso 2 (por ejemplo, si los precios incluyen impuesto cuando el documento no lo dice). Lo que no se pueda resolver queda señalado en la tabla y en las notas para revisarlo antes de la carga en Utopía.",
  },
];

export default function ResourcesPage() {
  return (
    <div className="space-y-6">
      <header className="pl-12 lg:pl-0">
        <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-foreground">
          Cómo usar el sistema
        </h1>
        <p className="text-sm text-muted-foreground mt-1.5">
          Guía del AI Supplier Intelligence Agent: el flujo de cuatro pasos, cómo decide el
          sistema qué información manda y qué herramientas tienen los administradores.
        </p>
      </header>

      <section className="bg-card/80 border border-border rounded-xl">
        <header className="flex items-center gap-2.5 px-6 pt-5 pb-4 border-b border-border">
          <ListChecks className="w-5 h-5 text-primary" />
          <h2 className="text-[15px] font-semibold">El flujo</h2>
        </header>
        <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
          {steps.map((s) => (
            <article key={s.title} className="bg-secondary/40 border border-border/70 rounded-lg p-4">
              <p className="flex items-center gap-2 text-[14px] font-semibold text-foreground">
                <span className="text-primary">{s.icon}</span>
                {s.title}
              </p>
              <p className="text-[13px] text-muted-foreground mt-2 leading-relaxed">{s.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="bg-card/80 border border-border rounded-xl">
        <header className="flex items-center gap-2.5 px-6 pt-5 pb-4 border-b border-border">
          <ShieldCheck className="w-5 h-5 text-primary" />
          <h2 className="text-[15px] font-semibold">Herramientas de administración</h2>
        </header>
        <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          {adminTools.map((s) => (
            <article key={s.title} className="bg-secondary/40 border border-border/70 rounded-lg p-4">
              <p className="flex items-center gap-2 text-[14px] font-semibold text-foreground">
                <span className="text-primary">{s.icon}</span>
                {s.title}
              </p>
              <p className="text-[13px] text-muted-foreground mt-2 leading-relaxed">{s.body}</p>
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
            <article key={f.question} className="bg-secondary/40 border border-border/70 rounded-lg p-4">
              <p className="text-[14px] font-semibold text-foreground">{f.question}</p>
              <p className="text-[13px] text-muted-foreground mt-2 leading-relaxed">{f.answer}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
