"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, X } from "lucide-react";

/**
 * Shared chrome for every dialog in the portal: dimmed backdrop, centered
 * card, body-scroll lock and Escape-to-close.
 *
 * Rendered through a portal attached to <body> so it escapes any transformed
 * ancestor (e.g. the `animate-fade-up` wrapper in the portal layout) —
 * without that, `fixed inset-0` is positioned relative to the transformed
 * ancestor instead of the viewport, which causes the modal to appear
 * off-center.
 */
export function ModalShell({
  onClose,
  labelledBy,
  maxWidth = "max-w-lg",
  children,
}: {
  onClose: () => void;
  labelledBy: string;
  maxWidth?: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // `createPortal` must not run during SSR — guard against a missing window.
  if (typeof window === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] overflow-y-auto overscroll-contain bg-black/60 p-4 sm:p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
    >
      {/* Flex wrapper handles centering; min-h-full + my-auto keeps the modal
          centered when it fits, and lets it scroll when it doesn't. */}
      <div className="flex min-h-full items-center justify-center">
        <div
          onClick={(e) => e.stopPropagation()}
          className={`w-full ${maxWidth} bg-card border border-border rounded-xl shadow-2xl animate-fade-in my-auto`}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ModalHeader({
  id,
  title,
  onClose,
  tone = "default",
}: {
  id: string;
  title: string;
  onClose: () => void;
  tone?: "default" | "danger";
}) {
  return (
    <header className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-border">
      <h3
        id={id}
        className={`text-[15px] font-semibold ${
          tone === "danger" ? "text-destructive" : ""
        }`}
      >
        {title}
      </h3>
      <button
        type="button"
        onClick={onClose}
        className="text-muted-foreground hover:text-foreground transition-colors"
        aria-label="Cerrar"
      >
        <X className="w-4 h-4" />
      </button>
    </header>
  );
}

/** Inline error block used inside dialogs and page banners. */
export function InlineError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-[12.5px] text-destructive"
    >
      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

/** Labelled form field wrapper with optional error line. */
export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-[12.5px] font-medium text-muted-foreground mb-1.5">
        {label}
      </span>
      {children}
      {hint && !error && (
        <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>
      )}
      {error && <p className="mt-1 text-[11.5px] text-destructive">{error}</p>}
    </label>
  );
}

export const inputClass =
  "w-full h-10 px-3 rounded-md bg-input/70 border border-border text-sm outline-none focus:border-primary/60 focus:ring-2 focus:ring-ring/30 transition-colors disabled:opacity-60 disabled:cursor-not-allowed";
