import { Building, Bell, Globe, Shield, Upload } from "lucide-react";
import { Select } from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import AdminGuard from "@/components/admin-guard";

const timezones = [
  { value: "America/Mexico_City", label: "America/Mexico_City (GMT-6)" },
  { value: "America/Bogota", label: "America/Bogota (GMT-5)" },
  { value: "America/Costa_Rica", label: "America/Costa_Rica (GMT-6)" },
  { value: "America/Guatemala", label: "America/Guatemala (GMT-6)" },
  { value: "Europe/Madrid", label: "Europe/Madrid (GMT+1)" },
];

const languages = [
  { value: "es", label: "Español" },
  { value: "en", label: "English" },
  { value: "pt", label: "Português" },
];

const dateFormats = [
  { value: "DD/MM/YYYY", label: "DD/MM/YYYY" },
  { value: "MM/DD/YYYY", label: "MM/DD/YYYY" },
  { value: "YYYY-MM-DD", label: "YYYY-MM-DD" },
];

export default function SettingsPage() {
  return (
    <AdminGuard>
      <SettingsPageContent />
    </AdminGuard>
  );
}

function SettingsPageContent() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[28px] font-bold tracking-tight text-foreground">
          Configuración del Portal
        </h1>
        <p className="text-sm text-muted-foreground mt-1.5">
          Administra la configuración de Travel Pioneers.
        </p>
      </header>

      {/* Información de la empresa */}
      <section className="bg-card/80 border border-border rounded-xl">
        <header className="flex items-center gap-2.5 px-6 pt-5 pb-4 border-b border-border">
          <Building className="w-5 h-5 text-primary" />
          <h2 className="text-[15px] font-semibold">Información de la empresa</h2>
        </header>
        <div className="p-6 space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <FormField label="Nombre de la empresa">
              <input
                type="text"
                defaultValue="Travel Pioneers"
                className="w-full bg-input/70 border border-border rounded-md px-3 py-2.5 text-sm outline-none focus:border-primary/60 focus:ring-2 focus:ring-ring/30 transition"
              />
            </FormField>
            <FormField label="Zona horaria">
              <Select
                options={timezones}
                defaultValue="America/Mexico_City"
              />
            </FormField>
          </div>

          <FormField label="Logo de la empresa">
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 rounded-lg bg-secondary/60 border border-dashed border-border flex items-center justify-center">
                <Upload className="w-6 h-6 text-muted-foreground" />
              </div>
              <div>
                <button
                  type="button"
                  className="px-3.5 py-2 rounded-md border border-border text-[13px] hover:bg-secondary/60 transition-colors"
                >
                  Subir logo
                </button>
                <p className="text-[11.5px] text-muted-foreground mt-1.5">
                  PNG, JPG hasta 2MB.
                </p>
              </div>
            </div>
          </FormField>
        </div>
      </section>

      {/* Notificaciones */}
      <section className="bg-card/80 border border-border rounded-xl">
        <header className="flex items-center gap-2.5 px-6 pt-5 pb-4 border-b border-border">
          <Bell className="w-5 h-5 text-primary" />
          <h2 className="text-[15px] font-semibold">Notificaciones</h2>
        </header>
        <div className="p-4 space-y-3">
          <NotifRow
            title="Notificaciones por email"
            description="Recibe alertas cuando el agente detecte ambigüedades en un contrato"
            defaultChecked
          />
          <NotifRow
            title="Notificaciones de Slack"
            description="Envía alertas cuando se complete el procesamiento de un contrato"
          />
          <NotifRow
            title="Reportes semanales"
            description="Recibe un resumen semanal de contratos procesados y plantillas generadas"
            defaultChecked
          />
        </div>
      </section>

      {/* Idioma y región */}
      <section className="bg-card/80 border border-border rounded-xl">
        <header className="flex items-center gap-2.5 px-6 pt-5 pb-4 border-b border-border">
          <Globe className="w-5 h-5 text-primary" />
          <h2 className="text-[15px] font-semibold">Idioma y región</h2>
        </header>
        <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-5">
          <FormField label="Idioma del sistema">
            <Select options={languages} defaultValue="es" />
          </FormField>
          <FormField label="Formato de fecha">
            <Select options={dateFormats} defaultValue="DD/MM/YYYY" />
          </FormField>
        </div>
      </section>

      {/* Seguridad */}
      <section className="bg-card/80 border border-border rounded-xl">
        <header className="flex items-center gap-2.5 px-6 pt-5 pb-4 border-b border-border">
          <Shield className="w-5 h-5 text-primary" />
          <h2 className="text-[15px] font-semibold">Seguridad</h2>
        </header>
        <div className="p-6 space-y-5">
          <button
            type="button"
            className="px-3.5 py-2 rounded-md border border-border text-[13px] hover:bg-secondary/60 transition-colors"
          >
            Cambiar contraseña
          </button>

          <div className="flex items-center justify-between bg-secondary/30 border border-border/70 rounded-lg p-4">
            <div>
              <p className="text-[14px] font-semibold">
                Autenticación de dos factores
              </p>
              <p className="text-[12.5px] text-muted-foreground mt-0.5">
                Añade una capa extra de seguridad a tu cuenta
              </p>
            </div>
            <button
              type="button"
              className="px-3.5 py-1.5 rounded-md border border-primary/40 text-primary text-[12.5px] font-medium hover:bg-primary/10 transition-colors"
            >
              Activar 2FA
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function FormField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-[12.5px] font-medium text-muted-foreground mb-1.5">
        {label}
      </span>
      {children}
    </label>
  );
}

function NotifRow({
  title,
  description,
  defaultChecked = false,
}: {
  title: string;
  description: string;
  defaultChecked?: boolean;
}) {
  return (
    <div className="flex items-center justify-between bg-secondary/30 border border-border/70 rounded-lg px-4 py-3.5">
      <div className="min-w-0 pr-4">
        <p className="text-[14px] font-semibold text-foreground">{title}</p>
        <p className="text-[12.5px] text-muted-foreground mt-0.5">
          {description}
        </p>
      </div>
      <Toggle defaultChecked={defaultChecked} ariaLabel={title} />
    </div>
  );
}
