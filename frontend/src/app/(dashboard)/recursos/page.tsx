"use client";

import { useState } from "react";
import {
  FolderOpen,
  Search,
  Upload,
  FileText,
  Database,
  Globe,
  BarChart3,
  Download,
  Eye,
  Trash2,
  Filter,
  Grid3X3,
  List,
  Clock,
  HardDrive,
  Plus,
} from "lucide-react";

const resources = [
  {
    id: 1,
    name: "Base de Datos de Proveedores 2024",
    type: "database",
    size: "245 MB",
    updated: "Hace 2 hrs",
    status: "activo",
    records: "12,450",
    category: "Proveedores",
  },
  {
    id: 2,
    name: "Informe de Análisis Q1 2024",
    type: "document",
    size: "18 MB",
    updated: "Hace 1 día",
    status: "activo",
    records: "—",
    category: "Informes",
  },
  {
    id: 3,
    name: "Dataset de Precios Históricos",
    type: "dataset",
    size: "1.2 GB",
    updated: "Hace 3 hrs",
    status: "procesando",
    records: "890,234",
    category: "Datos",
  },
  {
    id: 4,
    name: "API Conexión Amadeus",
    type: "api",
    size: "—",
    updated: "Hace 15 min",
    status: "activo",
    records: "∞",
    category: "Integraciones",
  },
  {
    id: 5,
    name: "Modelo de Scoring de Proveedores",
    type: "model",
    size: "450 MB",
    updated: "Hace 5 días",
    status: "activo",
    records: "—",
    category: "Modelos IA",
  },
  {
    id: 6,
    name: "Catálogo de Destinos Global",
    type: "database",
    size: "780 MB",
    updated: "Hace 12 hrs",
    status: "activo",
    records: "45,670",
    category: "Proveedores",
  },
  {
    id: 7,
    name: "Dashboard Métricas Mensual",
    type: "report",
    size: "5 MB",
    updated: "Hace 2 días",
    status: "activo",
    records: "—",
    category: "Informes",
  },
  {
    id: 8,
    name: "Feed de Tarifas en Tiempo Real",
    type: "api",
    size: "—",
    updated: "Hace 1 min",
    status: "activo",
    records: "∞",
    category: "Integraciones",
  },
];

const typeConfig: Record<string, { icon: React.ElementType; color: string }> = {
  database: { icon: Database, color: "text-blue-400 bg-blue-400/10 border-blue-400/20" },
  document: { icon: FileText, color: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20" },
  dataset: { icon: BarChart3, color: "text-teal-400 bg-teal-400/10 border-teal-400/20" },
  api: { icon: Globe, color: "text-cyan-400 bg-cyan-400/10 border-cyan-400/20" },
  model: { icon: HardDrive, color: "text-amber-400 bg-amber-400/10 border-amber-400/20" },
  report: { icon: BarChart3, color: "text-pink-400 bg-pink-400/10 border-pink-400/20" },
};

const categories = ["Todos", "Proveedores", "Informes", "Datos", "Integraciones", "Modelos IA"];

export default function RecursosPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("Todos");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  const filtered = resources.filter((r) => {
    const matchesSearch =
      r.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      r.category.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = selectedCategory === "Todos" || r.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const storageStats = [
    { label: "Total Almacenamiento", value: "2.7 GB", icon: HardDrive },
    { label: "Recursos Totales", value: resources.length.toString(), icon: FolderOpen },
    { label: "Conexiones API", value: resources.filter((r) => r.type === "api").length.toString(), icon: Globe },
    { label: "Última Actualización", value: "Hace 1 min", icon: Clock },
  ];

  return (
    <div className="p-6 px-8 lg:p-10 lg:px-14 xl:px-20 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FolderOpen className="w-6 h-6 text-emerald-400" />
            Recursos
          </h1>
          <p className="text-muted-foreground mt-1">
            Gestiona datos, integraciones y recursos de tus agentes
          </p>
        </div>
        <div className="flex gap-2">
          <button className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-card border border-border text-sm font-medium text-foreground hover:bg-secondary transition-colors">
            <Upload className="w-4 h-4" />
            Subir Archivo
          </button>
          <button className="flex items-center gap-2 px-4 py-2.5 rounded-lg gradient-primary text-white text-sm font-medium hover:opacity-90 transition-opacity">
            <Plus className="w-4 h-4" />
            Nuevo Recurso
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {storageStats.map((stat) => (
          <div
            key={stat.label}
            className="p-4 rounded-xl bg-card border border-border"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                {stat.label}
              </span>
              <stat.icon className="w-4 h-4 text-emerald-400" />
            </div>
            <p className="text-xl font-bold">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="flex flex-col sm:flex-row gap-3 flex-1">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Buscar recursos..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-10 pl-10 pr-4 rounded-lg bg-card border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all text-sm"
            />
          </div>
          <div className="flex gap-1 flex-wrap">
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap ${
                  selectedCategory === cat
                    ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                    : "bg-card border border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>
        <div className="flex gap-1 bg-card border border-border rounded-lg p-0.5">
          <button
            onClick={() => setViewMode("grid")}
            className={`p-2 rounded-md transition-colors ${viewMode === "grid" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            <Grid3X3 className="w-4 h-4" />
          </button>
          <button
            onClick={() => setViewMode("list")}
            className={`p-2 rounded-md transition-colors ${viewMode === "list" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            <List className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Resources grid / list */}
      {viewMode === "grid" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
          {filtered.map((resource) => {
            const tc = typeConfig[resource.type] || typeConfig.document;
            const TypeIcon = tc.icon;
            return (
              <div
                key={resource.id}
                className="group p-5 rounded-xl bg-card border border-border hover:border-emerald-500/30 transition-all"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center border ${tc.color}`}>
                    <TypeIcon className="w-5 h-5" />
                  </div>
                  <span
                    className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
                      resource.status === "activo"
                        ? "bg-emerald-400/10 text-emerald-400"
                        : "bg-amber-400/10 text-amber-400"
                    }`}
                  >
                    {resource.status === "activo" ? "Activo" : "Procesando"}
                  </span>
                </div>

                <h3 className="font-semibold text-sm mb-1 line-clamp-1">{resource.name}</h3>
                <p className="text-xs text-muted-foreground mb-3">{resource.category}</p>

                <div className="flex items-center gap-3 text-xs text-muted-foreground mb-4">
                  <span>{resource.size}</span>
                  <span>•</span>
                  <span>{resource.records} registros</span>
                </div>

                <div className="flex items-center justify-between pt-3 border-t border-border">
                  <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {resource.updated}
                  </span>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-all" title="Ver">
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                    <button className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-all" title="Descargar">
                      <Download className="w-3.5 h-3.5" />
                    </button>
                    <button className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all" title="Eliminar">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-xl bg-card border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left p-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Nombre</th>
                <th className="text-left p-4 text-xs font-medium text-muted-foreground uppercase tracking-wide hidden md:table-cell">Categoría</th>
                <th className="text-left p-4 text-xs font-medium text-muted-foreground uppercase tracking-wide hidden sm:table-cell">Tamaño</th>
                <th className="text-left p-4 text-xs font-medium text-muted-foreground uppercase tracking-wide hidden lg:table-cell">Registros</th>
                <th className="text-left p-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Estado</th>
                <th className="text-right p-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((resource) => {
                const tc = typeConfig[resource.type] || typeConfig.document;
                const TypeIcon = tc.icon;
                return (
                  <tr key={resource.id} className="border-b border-border last:border-0 hover:bg-secondary/50 transition-colors">
                    <td className="p-4">
                      <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center border flex-shrink-0 ${tc.color}`}>
                          <TypeIcon className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium truncate">{resource.name}</p>
                          <p className="text-xs text-muted-foreground">{resource.updated}</p>
                        </div>
                      </div>
                    </td>
                    <td className="p-4 text-muted-foreground hidden md:table-cell">{resource.category}</td>
                    <td className="p-4 text-muted-foreground hidden sm:table-cell">{resource.size}</td>
                    <td className="p-4 text-muted-foreground hidden lg:table-cell">{resource.records}</td>
                    <td className="p-4">
                      <span
                        className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
                          resource.status === "activo"
                            ? "bg-emerald-400/10 text-emerald-400"
                            : "bg-amber-400/10 text-amber-400"
                        }`}
                      >
                        {resource.status === "activo" ? "Activo" : "Procesando"}
                      </span>
                    </td>
                    <td className="p-4 text-right">
                      <div className="flex gap-1 justify-end">
                        <button className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-all">
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                        <button className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-all">
                          <Download className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {filtered.length === 0 && (
        <div className="text-center py-16">
          <FolderOpen className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">No se encontraron recursos</p>
        </div>
      )}
    </div>
  );
}
