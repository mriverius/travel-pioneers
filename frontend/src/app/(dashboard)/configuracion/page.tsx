"use client";

import { useState } from "react";
import {
  Settings,
  User,
  Bell,
  Shield,
  Palette,
  Globe,
  Key,
  Save,
  Bot,
  Zap,
  Database,
  Mail,
  ChevronRight,
} from "lucide-react";

const tabs = [
  { id: "general", label: "General", icon: Settings },
  { id: "perfil", label: "Perfil", icon: User },
  { id: "notificaciones", label: "Notificaciones", icon: Bell },
  { id: "seguridad", label: "Seguridad", icon: Shield },
  { id: "ia", label: "Modelos IA", icon: Bot },
  { id: "integraciones", label: "Integraciones", icon: Zap },
];

export default function ConfiguracionPage() {
  const [activeTab, setActiveTab] = useState("general");
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="p-6 px-8 lg:p-10 lg:px-14 xl:px-20 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Settings className="w-6 h-6 text-emerald-400" />
            Configuración
          </h1>
          <p className="text-muted-foreground mt-1">
            Administra las preferencias y ajustes de la plataforma
          </p>
        </div>
        <button
          onClick={handleSave}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg gradient-primary text-white text-sm font-medium hover:opacity-90 transition-opacity"
        >
          <Save className="w-4 h-4" />
          {saved ? "¡Guardado!" : "Guardar Cambios"}
        </button>
      </div>

      <div className="flex flex-col lg:flex-row gap-6">
        {/* Tab navigation */}
        <div className="lg:w-56 flex-shrink-0">
          <nav className="flex lg:flex-col gap-1 overflow-x-auto lg:overflow-visible pb-2 lg:pb-0">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${
                  activeTab === tab.id
                    ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary border border-transparent"
                }`}
              >
                <tab.icon className="w-4 h-4 flex-shrink-0" />
                {tab.label}
                {activeTab === tab.id && (
                  <ChevronRight className="w-3.5 h-3.5 ml-auto hidden lg:block" />
                )}
              </button>
            ))}
          </nav>
        </div>

        {/* Content */}
        <div className="flex-1 space-y-6">
          {activeTab === "general" && (
            <>
              <Section title="Información de la Plataforma">
                <Field label="Nombre de la Organización" defaultValue="Travel Pioneers" />
                <Field label="Dominio" defaultValue="travelpioners.com" />
                <div>
                  <label className="block text-sm font-medium mb-2">Idioma</label>
                  <select className="w-full h-11 px-4 rounded-lg bg-secondary border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all">
                    <option value="es">Español</option>
                    <option value="en">English</option>
                    <option value="pt">Português</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">Zona Horaria</label>
                  <select className="w-full h-11 px-4 rounded-lg bg-secondary border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all">
                    <option value="utc-6">UTC-6 (Ciudad de México)</option>
                    <option value="utc-5">UTC-5 (Bogotá, Lima)</option>
                    <option value="utc-3">UTC-3 (Buenos Aires)</option>
                    <option value="utc+1">UTC+1 (Madrid)</option>
                  </select>
                </div>
              </Section>

              <Section title="Apariencia">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Tema Oscuro</p>
                    <p className="text-xs text-muted-foreground">Interfaz con colores oscuros (activo)</p>
                  </div>
                  <Toggle defaultChecked />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Animaciones</p>
                    <p className="text-xs text-muted-foreground">Efectos de transición en la interfaz</p>
                  </div>
                  <Toggle defaultChecked />
                </div>
              </Section>
            </>
          )}

          {activeTab === "perfil" && (
            <Section title="Información Personal">
              <div className="flex items-center gap-4 mb-4">
                <div className="w-16 h-16 rounded-full gradient-primary flex items-center justify-center text-white text-xl font-bold">
                  TP
                </div>
                <div>
                  <button className="text-sm text-emerald-400 hover:text-emerald-300 transition-colors font-medium">
                    Cambiar avatar
                  </button>
                  <p className="text-xs text-muted-foreground mt-1">JPG, PNG. Máximo 2MB.</p>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label="Nombre" defaultValue="Admin" />
                <Field label="Apellido" defaultValue="Travel Pioneers" />
              </div>
              <Field label="Correo Electrónico" defaultValue="admin@travelpioners.com" type="email" />
              <Field label="Teléfono" defaultValue="+52 55 1234 5678" type="tel" />
              <Field label="Cargo" defaultValue="Administrador de Plataforma" />
            </Section>
          )}

          {activeTab === "notificaciones" && (
            <Section title="Preferencias de Notificaciones">
              <NotifRow
                title="Alertas de Agentes"
                desc="Notificar cuando un agente complete una tarea o tenga errores"
                defaultChecked
              />
              <NotifRow
                title="Actualizaciones de Recursos"
                desc="Avisar cuando se actualicen bases de datos o integraciones"
                defaultChecked
              />
              <NotifRow
                title="Informes Semanales"
                desc="Recibir resumen semanal de rendimiento de agentes"
                defaultChecked
              />
              <NotifRow
                title="Alertas de Precios"
                desc="Notificar cambios significativos en precios de proveedores"
                defaultChecked
              />
              <NotifRow
                title="Notificaciones por Email"
                desc="Enviar notificaciones también por correo electrónico"
              />
              <NotifRow
                title="Alertas de Seguridad"
                desc="Avisar sobre intentos de acceso sospechosos"
                defaultChecked
              />
            </Section>
          )}

          {activeTab === "seguridad" && (
            <>
              <Section title="Contraseña">
                <Field label="Contraseña Actual" type="password" placeholder="••••••••" />
                <Field label="Nueva Contraseña" type="password" placeholder="••••••••" />
                <Field label="Confirmar Contraseña" type="password" placeholder="••••••••" />
              </Section>
              <Section title="Autenticación de Dos Factores">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Activar 2FA</p>
                    <p className="text-xs text-muted-foreground">
                      Agrega una capa extra de seguridad a tu cuenta
                    </p>
                  </div>
                  <Toggle />
                </div>
              </Section>
              <Section title="Sesiones Activas">
                <div className="space-y-3">
                  <SessionRow device="MacBook Pro — Chrome" location="Ciudad de México" current />
                  <SessionRow device="iPhone 15 — Safari" location="Ciudad de México" />
                </div>
              </Section>
            </>
          )}

          {activeTab === "ia" && (
            <>
              <Section title="Configuración de Modelos">
                <div>
                  <label className="block text-sm font-medium mb-2">Modelo Principal</label>
                  <select className="w-full h-11 px-4 rounded-lg bg-secondary border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all">
                    <option>GPT-4o (Recomendado)</option>
                    <option>GPT-4 Turbo</option>
                    <option>Claude 3.5 Sonnet</option>
                    <option>Llama 3.1 70B</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">Temperatura</label>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    defaultValue="70"
                    className="w-full accent-emerald-500"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground mt-1">
                    <span>Preciso (0.0)</span>
                    <span>Creativo (1.0)</span>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Modo de Aprendizaje</p>
                    <p className="text-xs text-muted-foreground">Permitir que los agentes aprendan de sus resultados</p>
                  </div>
                  <Toggle defaultChecked />
                </div>
              </Section>
              <Section title="Límites de Uso">
                <Field label="Máximo de Tokens por Consulta" defaultValue="4096" type="number" />
                <Field label="Consultas Diarias Máx." defaultValue="10000" type="number" />
              </Section>
            </>
          )}

          {activeTab === "integraciones" && (
            <Section title="Conexiones Activas">
              <IntegrationRow name="API de Amadeus" status="conectado" icon={Globe} />
              <IntegrationRow name="Base de Datos PostgreSQL" status="conectado" icon={Database} />
              <IntegrationRow name="Servicio de Email (SMTP)" status="configurar" icon={Mail} />
              <IntegrationRow name="API de OpenAI" status="conectado" icon={Key} />
              <IntegrationRow name="Webhook de Alertas" status="configurar" icon={Zap} />
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-card border border-border p-6 space-y-4">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </div>
  );
}

function Field({
  label,
  defaultValue,
  type = "text",
  placeholder,
}: {
  label: string;
  defaultValue?: string;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium mb-2">{label}</label>
      <input
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder}
        className="w-full h-11 px-4 rounded-lg bg-secondary border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all"
      />
    </div>
  );
}

function Toggle({ defaultChecked }: { defaultChecked?: boolean }) {
  const [on, setOn] = useState(defaultChecked ?? false);
  return (
    <button
      onClick={() => setOn(!on)}
      className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${
        on ? "bg-emerald-500" : "bg-border"
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
          on ? "translate-x-5" : ""
        }`}
      />
    </button>
  );
}

function NotifRow({
  title,
  desc,
  defaultChecked,
}: {
  title: string;
  desc: string;
  defaultChecked?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{desc}</p>
      </div>
      <Toggle defaultChecked={defaultChecked} />
    </div>
  );
}

function SessionRow({
  device,
  location,
  current,
}: {
  device: string;
  location: string;
  current?: boolean;
}) {
  return (
    <div className="flex items-center justify-between p-3 rounded-lg bg-secondary/50 border border-border">
      <div>
        <p className="text-sm font-medium">
          {device}
          {current && (
            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-400/10 text-emerald-400 font-medium">
              Actual
            </span>
          )}
        </p>
        <p className="text-xs text-muted-foreground">{location}</p>
      </div>
      {!current && (
        <button className="text-xs text-destructive hover:underline">
          Cerrar sesión
        </button>
      )}
    </div>
  );
}

function IntegrationRow({
  name,
  status,
  icon: Icon,
}: {
  name: string;
  status: "conectado" | "configurar";
  icon: React.ElementType;
}) {
  return (
    <div className="flex items-center justify-between p-3 rounded-lg bg-secondary/50 border border-border">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
          <Icon className="w-4 h-4 text-emerald-400" />
        </div>
        <span className="text-sm font-medium">{name}</span>
      </div>
      {status === "conectado" ? (
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-400/10 text-emerald-400 font-medium">
          Conectado
        </span>
      ) : (
        <button className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors font-medium">
          Configurar
        </button>
      )}
    </div>
  );
}
