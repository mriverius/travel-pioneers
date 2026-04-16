"use client";

import { useState } from "react";
import {
  Bot,
  Plus,
  Search,
  Sparkles,
  Activity,
  Zap,
  Globe,
  TrendingUp,
  Clock,
  CheckCircle2,
  AlertCircle,
  MoreHorizontal,
  Play,
  Pause,
  RefreshCw,
} from "lucide-react";

const agents = [
  {
    id: 1,
    name: "Analizador de Proveedores",
    description: "Evalúa y califica proveedores según métricas de rendimiento, confiabilidad y costo.",
    status: "activo",
    type: "Análisis",
    lastRun: "Hace 5 min",
    tasks: 128,
    accuracy: 94,
  },
  {
    id: 2,
    name: "Monitor de Precios",
    description: "Rastrea fluctuaciones de precios en tiempo real y genera alertas de oportunidad.",
    status: "activo",
    type: "Monitoreo",
    lastRun: "Hace 12 min",
    tasks: 256,
    accuracy: 97,
  },
  {
    id: 3,
    name: "Predictor de Demanda",
    description: "Predice patrones de demanda futura basándose en datos históricos y tendencias.",
    status: "pausado",
    type: "Predicción",
    lastRun: "Hace 2 hrs",
    tasks: 89,
    accuracy: 91,
  },
  {
    id: 4,
    name: "Negociador Automático",
    description: "Genera propuestas de negociación optimizadas basadas en análisis de mercado.",
    status: "activo",
    type: "Negociación",
    lastRun: "Hace 30 min",
    tasks: 45,
    accuracy: 88,
  },
  {
    id: 5,
    name: "Auditor de Calidad",
    description: "Verifica estándares de calidad y compliance de proveedores de forma automatizada.",
    status: "error",
    type: "Auditoría",
    lastRun: "Hace 1 hr",
    tasks: 67,
    accuracy: 92,
  },
  {
    id: 6,
    name: "Scout de Mercado",
    description: "Identifica nuevos proveedores potenciales y oportunidades de mercado emergentes.",
    status: "activo",
    type: "Investigación",
    lastRun: "Hace 8 min",
    tasks: 203,
    accuracy: 95,
  },
];

const statusConfig: Record<string, { color: string; bg: string; label: string; icon: React.ElementType }> = {
  activo: { color: "text-emerald-400", bg: "bg-emerald-400/10 border-emerald-400/20", label: "Activo", icon: CheckCircle2 },
  pausado: { color: "text-amber-400", bg: "bg-amber-400/10 border-amber-400/20", label: "Pausado", icon: Pause },
  error: { color: "text-red-400", bg: "bg-red-400/10 border-red-400/20", label: "Error", icon: AlertCircle },
};

export default function AgentesPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState("todos");

  const filtered = agents.filter((a) => {
    const matchesSearch =
      a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.description.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesFilter = filter === "todos" || a.status === filter;
    return matchesSearch && matchesFilter;
  });

  const stats = [
    { label: "Agentes Activos", value: agents.filter((a) => a.status === "activo").length, icon: Bot, color: "text-emerald-400" },
    { label: "Tareas Completadas", value: agents.reduce((s, a) => s + a.tasks, 0), icon: Zap, color: "text-emerald-400" },
    { label: "Precisión Promedio", value: `${Math.round(agents.reduce((s, a) => s + a.accuracy, 0) / agents.length)}%`, icon: TrendingUp, color: "text-cyan-400" },
    { label: "Tiempo Activo", value: "99.8%", icon: Activity, color: "text-amber-400" },
  ];

  return (
    <div className="p-6 px-8 lg:p-10 lg:px-14 xl:px-20 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-emerald-400" />
            Agentes de IA
          </h1>
          <p className="text-muted-foreground mt-1">
            Gestiona y monitorea tus agentes de inteligencia artificial
          </p>
        </div>
        <button className="flex items-center gap-2 px-4 py-2.5 rounded-lg gradient-primary text-white text-sm font-medium hover:opacity-90 transition-opacity">
          <Plus className="w-4 h-4" />
          Nuevo Agente
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="p-4 rounded-xl bg-card border border-border hover:border-emerald-500/30 transition-colors"
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                {stat.label}
              </span>
              <stat.icon className={`w-4 h-4 ${stat.color}`} />
            </div>
            <p className="text-2xl font-bold">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Buscar agentes..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-10 pl-10 pr-4 rounded-lg bg-card border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all text-sm"
          />
        </div>
        <div className="flex gap-2">
          {["todos", "activo", "pausado", "error"].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-2 rounded-lg text-xs font-medium capitalize transition-all ${
                filter === f
                  ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                  : "bg-card border border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {f === "todos" ? "Todos" : f}
            </button>
          ))}
        </div>
      </div>

      {/* Agent cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {filtered.map((agent) => {
          const st = statusConfig[agent.status];
          const StatusIcon = st.icon;
          return (
            <div
              key={agent.id}
              className="group p-5 rounded-xl bg-card border border-border hover:border-emerald-500/30 transition-all hover:shadow-lg hover:shadow-emerald-500/5"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="w-10 h-10 rounded-lg gradient-card border border-emerald-500/20 flex items-center justify-center">
                  <Bot className="w-5 h-5 text-emerald-400" />
                </div>
                <div className="flex items-center gap-2">
                  <span className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-medium border ${st.bg} ${st.color}`}>
                    <StatusIcon className="w-3 h-3" />
                    {st.label}
                  </span>
                  <button className="opacity-0 group-hover:opacity-100 p-1 rounded-md hover:bg-secondary transition-all text-muted-foreground">
                    <MoreHorizontal className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <h3 className="font-semibold text-foreground mb-1">{agent.name}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed mb-4 line-clamp-2">
                {agent.description}
              </p>

              <div className="flex items-center gap-4 text-xs text-muted-foreground mb-4">
                <span className="flex items-center gap-1">
                  <Globe className="w-3 h-3" />
                  {agent.type}
                </span>
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {agent.lastRun}
                </span>
              </div>

              <div className="flex items-center justify-between pt-3 border-t border-border">
                <div className="flex items-center gap-4 text-xs">
                  <span className="text-muted-foreground">
                    <strong className="text-foreground">{agent.tasks}</strong> tareas
                  </span>
                  <span className="text-muted-foreground">
                    <strong className="text-foreground">{agent.accuracy}%</strong> precisión
                  </span>
                </div>
                <div className="flex gap-1">
                  {agent.status === "activo" ? (
                    <button className="p-1.5 rounded-md hover:bg-amber-400/10 text-muted-foreground hover:text-amber-400 transition-all" title="Pausar">
                      <Pause className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <button className="p-1.5 rounded-md hover:bg-emerald-400/10 text-muted-foreground hover:text-emerald-400 transition-all" title="Iniciar">
                      <Play className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button className="p-1.5 rounded-md hover:bg-emerald-500/10 text-muted-foreground hover:text-emerald-400 transition-all" title="Reiniciar">
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-16">
          <Bot className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">No se encontraron agentes</p>
        </div>
      )}
    </div>
  );
}
