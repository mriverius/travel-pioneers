import {
  Baby,
  Banknote,
  BedDouble,
  BookMarked,
  Briefcase,
  Building2,
  Calendar,
  CalendarCheck2,
  CalendarRange,
  Clock,
  Compass,
  CreditCard,
  DollarSign,
  FileText,
  Globe,
  Hash,
  Landmark,
  Mail,
  Map as MapIcon,
  MapPin,
  Package,
  Percent,
  PlusCircle,
  Receipt,
  ShieldAlert,
  Sparkles,
  Star,
  Sun,
  Tag,
  Users,
  Utensils,
  Wallet,
  type LucideIcon,
} from "lucide-react";

/**
 * Schema legacy usado solo por la página de historial (mock data) — la
 * pantalla principal del agente migró al modelo shared_fields + rows. Como
 * el historial todavía es ficticio, mantenemos su esquema sectioned aquí
 * para no inflar workflow.tsx con tipos en uso solo por una sub-página.
 *
 * Cuando exista un endpoint real `GET /api/supplier-intelligence/history`,
 * actualizaremos esto al nuevo shape y este archivo desaparecerá.
 */
export type DisplayFieldKey =
  // Identidad / ubicación / contrato
  | "tipo_actividad"
  | "zona_turismo"
  | "proveedor"
  | "razon_social"
  | "cedula_juridica"
  | "contract_date"
  | "nombre_comercial"
  | "pais"
  | "state_province"
  | "location"
  | "type_of_business"
  | "contract_starts"
  | "contract_ends"
  // Servicio
  | "codigo_servicio"
  | "product_name"
  | "tipo_unidad"
  | "tipo_servicio"
  | "categoria"
  | "ocupacion"
  // Temporada
  | "season_name"
  | "season_starts"
  | "season_ends"
  | "meals_included"
  // Tarifas
  | "tipo_tarifa_neta"
  | "precios_neto_iva"
  | "precio_rack_iva"
  | "tipo_tarifa_mayorista"
  | "porcentaje_comision"
  | "tipo_tarifa_fds"
  | "t_tar_neta_fds"
  | "precios_neto_iva_fds"
  | "precio_rack_iva_fds"
  | "tipo_tarifa_mayorista_fds"
  | "porcentaje_comision_fds"
  // Políticas
  | "cancellation_policy"
  | "range_payment_policy"
  | "others_payment_cancel"
  | "kids_policy"
  | "other_included"
  | "feeds_adicionales"
  // Reservas y crédito
  | "reservations_email"
  | "cond_credito"
  | "plazo"
  // Cuentas bancarias
  | "cuenta_bancaria_1"
  | "banco_1"
  | "moneda_1"
  | "cuenta_bancaria_2"
  | "banco_2"
  | "moneda_2"
  | "cuenta_bancaria_3"
  | "banco_3"
  | "moneda_3";

export interface FieldDef {
  key: DisplayFieldKey;
  label: string;
  icon: LucideIcon;
}

export interface SectionAccent {
  iconBg: string;
  iconText: string;
  ring: string;
  pillBg: string;
  pillText: string;
  pillBorder: string;
}

export const ACCENTS = {
  primary: {
    iconBg: "bg-primary/15",
    iconText: "text-primary",
    ring: "border-primary/30",
    pillBg: "bg-primary/10",
    pillText: "text-primary",
    pillBorder: "border-primary/30",
  },
  sky: {
    iconBg: "bg-sky-500/15",
    iconText: "text-sky-300",
    ring: "border-sky-500/30",
    pillBg: "bg-sky-500/10",
    pillText: "text-sky-300",
    pillBorder: "border-sky-500/30",
  },
  emerald: {
    iconBg: "bg-emerald-500/15",
    iconText: "text-emerald-300",
    ring: "border-emerald-500/30",
    pillBg: "bg-emerald-500/10",
    pillText: "text-emerald-300",
    pillBorder: "border-emerald-500/30",
  },
  amber: {
    iconBg: "bg-amber-500/15",
    iconText: "text-amber-300",
    ring: "border-amber-500/30",
    pillBg: "bg-amber-500/10",
    pillText: "text-amber-300",
    pillBorder: "border-amber-500/30",
  },
  violet: {
    iconBg: "bg-violet-500/15",
    iconText: "text-violet-300",
    ring: "border-violet-500/30",
    pillBg: "bg-violet-500/10",
    pillText: "text-violet-300",
    pillBorder: "border-violet-500/30",
  },
  rose: {
    iconBg: "bg-rose-500/15",
    iconText: "text-rose-300",
    ring: "border-rose-500/30",
    pillBg: "bg-rose-500/10",
    pillText: "text-rose-300",
    pillBorder: "border-rose-500/30",
  },
} satisfies Record<string, SectionAccent>;

export interface SectionDef {
  id: string;
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  accent: SectionAccent;
  fields: FieldDef[];
}

export const SECTIONS: SectionDef[] = [
  {
    id: "identidad",
    title: "Información del proveedor",
    subtitle: "Identidad legal, ubicación y vigencia del contrato.",
    icon: Building2,
    accent: ACCENTS.primary,
    fields: [
      { key: "tipo_actividad", label: "Tipo Actividad", icon: Compass },
      { key: "zona_turismo", label: "Zona Turismo", icon: MapIcon },
      { key: "proveedor", label: "Proveedor", icon: Building2 },
      { key: "razon_social", label: "Razón Social", icon: Building2 },
      { key: "cedula_juridica", label: "Cédula Jurídica", icon: Hash },
      { key: "contract_date", label: "Contract Date", icon: Calendar },
      { key: "nombre_comercial", label: "Nombre Comercial", icon: BookMarked },
      { key: "pais", label: "País", icon: Globe },
      { key: "state_province", label: "State / Province", icon: MapPin },
      { key: "location", label: "Location", icon: MapPin },
      { key: "type_of_business", label: "Type of Business", icon: Briefcase },
      { key: "contract_starts", label: "Contract Starts", icon: CalendarCheck2 },
      { key: "contract_ends", label: "Contract Ends", icon: CalendarRange },
    ],
  },
  {
    id: "servicio",
    title: "Servicio",
    icon: Package,
    accent: ACCENTS.sky,
    fields: [
      { key: "codigo_servicio", label: "Código Servicio", icon: Hash },
      { key: "product_name", label: "Product Name", icon: Tag },
      { key: "tipo_unidad", label: "Tipo Unidad", icon: BedDouble },
      { key: "tipo_servicio", label: "Tipo Servicio", icon: Tag },
      { key: "categoria", label: "Categoría", icon: Star },
      { key: "ocupacion", label: "Ocupación", icon: Users },
    ],
  },
  {
    id: "temporada",
    title: "Temporada",
    icon: Sun,
    accent: ACCENTS.amber,
    fields: [
      { key: "season_name", label: "Season Name", icon: Sparkles },
      { key: "season_starts", label: "Season Starts", icon: Calendar },
      { key: "season_ends", label: "Season Ends", icon: Calendar },
      { key: "meals_included", label: "Meals Included", icon: Utensils },
    ],
  },
  {
    id: "tarifas",
    title: "Tarifas estándar",
    icon: DollarSign,
    accent: ACCENTS.emerald,
    fields: [
      { key: "tipo_tarifa_neta", label: "Tipo Tarifa Neta", icon: DollarSign },
      { key: "precios_neto_iva", label: "Precios Neto con IVA", icon: Banknote },
      { key: "precio_rack_iva", label: "Precio Rack con IVA", icon: Banknote },
      { key: "tipo_tarifa_mayorista", label: "Tipo Tarifa Mayorista", icon: Receipt },
      { key: "porcentaje_comision", label: "Porcentaje de Comisión", icon: Percent },
    ],
  },
  {
    id: "tarifas_fds",
    title: "Tarifas fin de semana",
    icon: DollarSign,
    accent: ACCENTS.violet,
    fields: [
      { key: "tipo_tarifa_fds", label: "Tipo Tarifa Fin de Semana", icon: DollarSign },
      { key: "t_tar_neta_fds", label: "T.Tar Neta Fin de Semana", icon: DollarSign },
      { key: "precios_neto_iva_fds", label: "Precios Neto FdS", icon: Banknote },
      { key: "precio_rack_iva_fds", label: "Precio Rack FdS", icon: Banknote },
      { key: "tipo_tarifa_mayorista_fds", label: "Tipo Mayorista FdS", icon: Receipt },
      { key: "porcentaje_comision_fds", label: "% Comisión FdS", icon: Percent },
    ],
  },
  {
    id: "politicas",
    title: "Políticas",
    icon: ShieldAlert,
    accent: ACCENTS.rose,
    fields: [
      { key: "cancellation_policy", label: "Cancellation Policy", icon: ShieldAlert },
      { key: "range_payment_policy", label: "Range Payment Policy", icon: Wallet },
      { key: "others_payment_cancel", label: "Others Payment / Cancel", icon: FileText },
      { key: "kids_policy", label: "Kids Policy", icon: Baby },
      { key: "other_included", label: "Other Included", icon: PlusCircle },
      { key: "feeds_adicionales", label: "Feeds Adicionales", icon: Receipt },
    ],
  },
  {
    id: "credito",
    title: "Reservas y crédito",
    icon: Mail,
    accent: ACCENTS.sky,
    fields: [
      { key: "reservations_email", label: "Reservations Email", icon: Mail },
      { key: "cond_credito", label: "Cond. Crédito", icon: CreditCard },
      { key: "plazo", label: "Plazo", icon: Clock },
    ],
  },
  {
    id: "bancos",
    title: "Información bancaria",
    icon: Landmark,
    accent: ACCENTS.emerald,
    fields: [
      { key: "cuenta_bancaria_1", label: "Cuenta Bancaria 1", icon: CreditCard },
      { key: "banco_1", label: "Banco 1", icon: Landmark },
      { key: "moneda_1", label: "Moneda 1", icon: Banknote },
      { key: "cuenta_bancaria_2", label: "Cuenta Bancaria 2", icon: CreditCard },
      { key: "banco_2", label: "Banco 2", icon: Landmark },
      { key: "moneda_2", label: "Moneda 2", icon: Banknote },
      { key: "cuenta_bancaria_3", label: "Cuenta Bancaria 3", icon: CreditCard },
      { key: "banco_3", label: "Banco 3", icon: Landmark },
      { key: "moneda_3", label: "Moneda 3", icon: Banknote },
    ],
  },
];

export const ALL_FIELDS: FieldDef[] = SECTIONS.flatMap((s) => s.fields);
