"use client";

import {
  Zap,
  Bot,
  User,
  Sparkles,
  Upload,
  Send,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type Role = "agent" | "user";

type Msg = {
  id: number;
  role: Role;
  time: string;
  body: ReactNode;
};

type QuickAction = {
  label: string;
  userPrompt: string;
  reply: ReactNode;
};

const quickActions: QuickAction[] = [
  {
    label: "¿Qué puedes hacer?",
    userPrompt: "¿Qué funciones tiene este sistema?",
    reply: (
      <>
        <p>
          ¡Hola! Como <strong>AI Supplier Intelligence Agent</strong> de Travel
          Pioneers, mi función principal es automatizar la digitalización de
          contratos de proveedores turísticos para su carga en{" "}
          <strong>Utopía</strong>. 🚀
        </p>
        <p className="mt-3">Mis capacidades específicas incluyen:</p>
        <ul className="mt-2 space-y-1.5 text-[13.5px]">
          <li>
            • <strong>Procesamiento de Documentos:</strong> Analizo contratos
            en PDF o Word.
          </li>
          <li>
            • <strong>Interpretación de Tarifas:</strong> Extraigo precios por
            temporada, tipo de habitación y régimen alimenticio.
          </li>
          <li>
            • <strong>Gestión de Condiciones:</strong> Identifico políticas de
            cancelación, impuestos y cargos adicionales.
          </li>
          <li>
            • <strong>Generación de Plantillas:</strong> Creo los archivos
            Excel estructurados necesarios para el sistema (Plantilla Proveedor
            + Plantilla Tarifas).
          </li>
          <li>
            • <strong>Detección de Errores:</strong> Identifico información
            ambigua o faltante antes de la carga.
          </li>
        </ul>
        <p className="mt-3">
          Si tienes un contrato listo, puedes adjuntarlo y procederé con el
          análisis. Solo puedo asistirte en temas relacionados con la gestión
          de proveedores. 📄✨
        </p>
      </>
    ),
  },
  {
    label: "Procesar contrato",
    userPrompt: "Necesito procesar un contrato de proveedor.",
    reply: (
      <>
        <p>
          Excelente. Estoy listo para procesar el contrato y generar las
          plantillas para Utopía. 📄
        </p>
        <p className="mt-3">
          Por favor, adjunta el archivo en formato PDF o Word. Una vez
          recibido, realizaré las siguientes acciones:
        </p>
        <ol className="mt-2 space-y-1.5 text-[13.5px] list-decimal list-inside">
          <li>
            <strong>Extracción de datos:</strong> Identificaré nombre del
            proveedor, moneda e impuestos.
          </li>
          <li>
            <strong>Análisis de tarifas:</strong> Clasificaré precios por
            temporada, categoría de habitación y régimen.
          </li>
          <li>
            <strong>Políticas:</strong> Detectaré condiciones de cancelación y
            suplementos.
          </li>
          <li>
            <strong>Entrega:</strong> Te proporcionaré la Plantilla Proveedor y
            la Plantilla Tarifas listas para carga.
          </li>
        </ol>
        <p className="mt-3">Quedo a la espera del documento. 📥</p>
      </>
    ),
  },
  {
    label: "Formato Utopía",
    userPrompt: "¿Qué formato tienen las plantillas que generas para Utopía?",
    reply: (
      <>
        <p>
          Las plantillas que genero se exportan en formato Excel (.xlsx) y
          están diseñadas bajo la estructura técnica requerida por Utopía:
        </p>
        <ol className="mt-2 space-y-1.5 text-[13.5px] list-decimal list-inside">
          <li>
            <strong>Plantilla Proveedor:</strong> Contiene los datos maestros
            (Nombre, ID, moneda, contacto, impuestos y configuración general de
            políticas).
          </li>
          <li>
            <strong>Plantilla Tarifas:</strong> Una tabla estructurada por
            columnas que incluye:
            <ul className="mt-1.5 ml-5 space-y-1">
              <li>• Categoría: Tipo de habitación/servicio.</li>
              <li>• Fechas: Rangos de validez por temporada.</li>
              <li>• Régimen: (AD, MP, PC, TI).</li>
              <li>• Precios: Desglose neto y neto + impuesto.</li>
              <li>• Restricciones: Estancias mínimas o fechas cerradas.</li>
            </ul>
          </li>
        </ol>
        <p className="mt-3">
          Este formato permite una importación masiva directa, evitando errores
          de transcripción manual. 📥✨
        </p>
      </>
    ),
  },
  {
    label: "Tipos de contrato",
    userPrompt: "¿Qué tipos de contratos puedes interpretar?",
    reply: (
      <>
        <p>
          Puedo interpretar una amplia variedad de contratos de servicios
          turísticos, facilitando su integración en Utopía:
        </p>
        <ul className="mt-2 space-y-1.5 text-[13.5px]">
          <li>
            • <strong>Alojamiento:</strong> Hoteles, villas y apartamentos
            (tarifas por noche, persona, suplementos y políticas de niños). 🏨
          </li>
          <li>
            • <strong>Transporte:</strong> Traslados privados o compartidos y
            alquiler de vehículos. 🚗
          </li>
          <li>
            • <strong>Actividades:</strong> Tours, excursiones, entradas a
            parques y guías. 🎟️
          </li>
          <li>
            • <strong>Paquetes:</strong> Servicios combinados con condiciones
            específicas de grupo.
          </li>
          <li>
            • <strong>Servicios Complementarios:</strong> Alimentación
            (restaurantes), seguros de viaje o asistencias.
          </li>
        </ul>
        <p className="mt-3">
          Puedo procesar contratos en español e inglés. Si el documento incluye
          tablas complejas de temporadas o anexos de condiciones especiales,
          los analizaré detalladamente para asegurar que la plantilla de carga
          sea precisa. 📄✅
        </p>
      </>
    ),
  },
];

function nowHHmm() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

export function ChatAgent() {
  const initialTime = useMemo(() => nowHHmm(), []);
  const [messages, setMessages] = useState<Msg[]>([
    {
      id: 1,
      role: "agent",
      time: initialTime,
      body: (
        <>
          <p>Hola 👋</p>
          <p className="mt-2">
            Soy el <strong>AI Supplier Intelligence Agent</strong> de Travel
            Pioneers.
          </p>
          <p className="mt-2">
            Estoy diseñado para procesar contratos de proveedores turísticos,
            interpretar tarifas, condiciones e impuestos, y convertirlos en
            plantillas estructuradas listas para carga en{" "}
            <strong>Utopía</strong>.
          </p>
          <p className="mt-2">
            Puede subir un contrato o indicarme qué necesita procesar.
          </p>
        </>
      ),
    },
  ]);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const counterRef = useRef(2);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, typing]);

  const pushUserThenAgent = (userPrompt: string, reply: ReactNode) => {
    const t = nowHHmm();
    const a = counterRef.current++;
    setMessages((m) => [
      ...m,
      { id: a, role: "user", time: t, body: <p>{userPrompt}</p> },
    ]);
    setTyping(true);
    setTimeout(() => {
      const b = counterRef.current++;
      setTyping(false);
      setMessages((m) => [
        ...m,
        { id: b, role: "agent", time: nowHHmm(), body: reply },
      ]);
    }, 650);
  };

  const handleQuick = (q: QuickAction) => {
    pushUserThenAgent(q.userPrompt, q.reply);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput("");
    pushUserThenAgent(
      text,
      <p>
        Estoy procesando tu consulta. Si necesitas subir un contrato, usa el
        botón <strong>Cargar contrato</strong>. 📎
      </p>
    );
  };

  return (
    <section className="relative overflow-hidden rounded-2xl border border-border bg-card/80 shadow-[0_1px_0_0_hsl(var(--primary)/0.08)_inset]">
      {/* Ambient top halo */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-20 left-1/2 h-56 w-[70%] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl"
      />

      {/* Header */}
      <header className="relative flex items-center gap-3 px-5 py-4 border-b border-border bg-card/60 backdrop-blur">
        <div className="relative w-10 h-10 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center">
          <Zap className="w-4 h-4 text-primary" />
          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-primary border-2 border-card animate-pulse-dot" />
        </div>
        <div className="flex-1 leading-tight">
          <p className="text-[14.5px] font-semibold text-foreground">
            Chat con tu agente
          </p>
          <p className="text-[12px] text-muted-foreground flex items-center gap-1.5 mt-0.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-primary/60 animate-pulse-dot" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-primary" />
            </span>
            En línea · Listo para procesar contratos
          </p>
        </div>
      </header>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="relative px-5 py-6 max-h-[520px] min-h-[240px] overflow-y-auto"
      >
        <div className="space-y-5">
          {messages.map((m) => (
            <Message key={m.id} msg={m} />
          ))}
          {typing ? <TypingIndicator /> : null}
        </div>
      </div>

      {/* Quick actions */}
      <div className="px-5 pt-1 pb-3 flex flex-wrap gap-2 border-t border-border/60 bg-card/40">
        {quickActions.map((q) => (
          <button
            key={q.label}
            type="button"
            onClick={() => handleQuick(q)}
            className="group inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/25 text-primary text-[12.5px] font-medium hover:bg-primary/18 hover:border-primary/40 hover:shadow-[0_0_12px_0_hsl(var(--primary)/0.35)] transition-all"
          >
            <Sparkles className="w-3 h-3 transition-transform group-hover:rotate-12" />
            {q.label}
          </button>
        ))}
      </div>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 px-5 pb-5 pt-2"
      >
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg bg-secondary/60 border border-border text-foreground text-[12.5px] hover:bg-secondary hover:border-primary/30 transition-colors"
        >
          <Upload className="w-4 h-4" />
          Cargar contrato
        </button>
        <div className="flex-1 relative">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            type="text"
            placeholder="Pregúntale al agente sobre contratos..."
            className="w-full bg-input/60 border border-border rounded-lg pl-3.5 pr-3.5 py-2.5 text-sm placeholder:text-muted-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-ring/30 focus:bg-input/80 transition"
          />
        </div>
        <button
          type="submit"
          aria-label="Enviar"
          disabled={!input.trim()}
          className="w-10 h-10 rounded-lg bg-primary text-primary-foreground flex items-center justify-center shadow-[0_0_18px_0_hsl(var(--primary)/0.35)] hover:shadow-[0_0_22px_0_hsl(var(--primary)/0.55)] disabled:opacity-40 disabled:shadow-none transition-all"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
    </section>
  );
}

function Message({ msg }: { msg: Msg }) {
  const isAgent = msg.role === "agent";
  return (
    <div
      className={`flex gap-3 animate-chat-in ${
        isAgent ? "flex-row" : "flex-row-reverse"
      }`}
    >
      <div
        className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center border ${
          isAgent
            ? "bg-primary/10 border-primary/30"
            : "bg-secondary border-border"
        }`}
      >
        {isAgent ? (
          <Bot className="w-4 h-4 text-primary" />
        ) : (
          <User className="w-4 h-4 text-muted-foreground" />
        )}
      </div>
      <div
        className={`max-w-[min(82%,720px)] min-w-0 flex flex-col ${
          isAgent ? "items-start" : "items-end"
        }`}
      >
        <div
          className={`flex items-baseline gap-2 mb-1 ${
            isAgent ? "" : "flex-row-reverse"
          }`}
        >
          <span
            className={`text-[11px] font-semibold uppercase tracking-wider ${
              isAgent ? "text-primary" : "text-foreground/80"
            }`}
          >
            {isAgent ? "AI Agent" : "Tú"}
          </span>
          <span className="text-[11px] text-muted-foreground">{msg.time}</span>
        </div>
        <div
          className={`px-4 py-3 rounded-2xl text-[13.5px] leading-relaxed text-foreground/90 ${
            isAgent
              ? "chat-bubble-agent rounded-tl-md"
              : "chat-bubble-user rounded-tr-md"
          }`}
        >
          {msg.body}
        </div>
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex gap-3 animate-chat-in">
      <div className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center border bg-primary/10 border-primary/30">
        <Bot className="w-4 h-4 text-primary" />
      </div>
      <div className="flex items-center gap-1.5 px-4 py-3 rounded-2xl rounded-tl-md chat-bubble-agent">
        <span className="w-1.5 h-1.5 rounded-full bg-primary/70 animate-pulse-dot" />
        <span
          className="w-1.5 h-1.5 rounded-full bg-primary/70 animate-pulse-dot"
          style={{ animationDelay: "0.15s" }}
        />
        <span
          className="w-1.5 h-1.5 rounded-full bg-primary/70 animate-pulse-dot"
          style={{ animationDelay: "0.3s" }}
        />
      </div>
    </div>
  );
}
