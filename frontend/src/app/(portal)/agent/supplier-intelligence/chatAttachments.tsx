"use client";

import { FileText, Image as ImageIcon, Paperclip, X } from "lucide-react";
import { useRef, useState, type ClipboardEvent } from "react";

/**
 * Adjuntos para los chats de corrección (Paso 2 y Paso 3).
 *
 * El operador puede sumar capturas, PDFs, Word o Excel como contexto de su
 * pedido ("acá está la tabla de triples"). Mismos formatos y tope por archivo
 * que el upload del Paso 1; el backend los recibe en el campo `attachments`.
 * También se pueden pegar imágenes directo en el textarea (Cmd/Ctrl+V).
 */

export const MAX_CHAT_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const ACCEPTED_EXT = ["pdf", "docx", "doc", "xlsx", "xls", "jpg", "jpeg", "png", "gif", "webp"];
export const CHAT_ATTACHMENT_ACCEPT = ACCEPTED_EXT.map((e) => `.${e}`).join(",");

function extOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function isImage(f: File): boolean {
  return f.type.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "webp"].includes(extOf(f.name));
}

/** Estado + validación de los adjuntos de un mensaje. */
export function useChatAttachments() {
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);

  const add = (incoming: File[]) => {
    if (incoming.length === 0) return;
    const next = [...files];
    let problem: string | null = null;
    for (const raw of incoming) {
      if (next.length >= MAX_CHAT_ATTACHMENTS) {
        problem = `Máximo ${MAX_CHAT_ATTACHMENTS} adjuntos por mensaje.`;
        break;
      }
      // Las capturas pegadas llegan como "image.png": les damos un nombre único.
      const f =
        raw.name === "image.png" || raw.name === ""
          ? new File([raw], `captura-${Date.now()}-${next.length + 1}.png`, {
              type: raw.type || "image/png",
            })
          : raw;
      if (!ACCEPTED_EXT.includes(extOf(f.name))) {
        problem = `Formato no soportado: ${f.name}. Usá PDF, Word, Excel o imágenes.`;
        continue;
      }
      if (f.size > MAX_ATTACHMENT_BYTES) {
        problem = `${f.name} pesa más de 20 MB.`;
        continue;
      }
      if (next.some((x) => x.name === f.name && x.size === f.size)) continue;
      next.push(f);
    }
    setFiles(next);
    setError(problem);
  };

  const remove = (i: number) => setFiles((prev) => prev.filter((_, idx) => idx !== i));
  const clear = () => {
    setFiles([]);
    setError(null);
  };

  /** Para el `onPaste` del textarea: captura imágenes del portapapeles. */
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(e.clipboardData?.files ?? []);
    if (pasted.length === 0) return;
    e.preventDefault();
    add(pasted);
  };

  return { files, error, add, remove, clear, onPaste };
}

/** Botón clip que abre el selector de archivos. */
export function AttachButton({
  onAdd,
  disabled,
  count,
}: {
  onAdd: (files: File[]) => void;
  disabled?: boolean;
  count: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const full = count >= MAX_CHAT_ATTACHMENTS;
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={CHAT_ATTACHMENT_ACCEPT}
        className="hidden"
        onChange={(e) => {
          onAdd(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || full}
        title={
          full
            ? `Máximo ${MAX_CHAT_ATTACHMENTS} adjuntos`
            : "Adjuntar imagen o documento (también podés pegar una captura)"
        }
        className="inline-flex items-center justify-center gap-1.5 h-8 px-2.5 rounded-md border border-border bg-secondary/30 text-[12px] text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Paperclip className="w-3.5 h-3.5" />
        Adjuntar
      </button>
    </>
  );
}

/** Chips con los adjuntos pendientes (con botón para quitar) o enviados. */
export function AttachmentChips({
  files,
  names,
  onRemove,
  disabled,
}: {
  files?: File[];
  /** Variante solo-lectura para mostrar en el historial del chat. */
  names?: string[];
  onRemove?: (i: number) => void;
  disabled?: boolean;
}) {
  const items =
    files?.map((f) => ({ name: f.name, image: isImage(f) })) ??
    names?.map((n) => ({ name: n, image: ["jpg", "jpeg", "png", "gif", "webp"].includes(extOf(n)) })) ??
    [];
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((it, i) => (
        <span
          key={`${it.name}-${i}`}
          className="inline-flex items-center gap-1.5 max-w-[240px] rounded-md border border-border bg-secondary/40 px-2 py-1 text-[11.5px] text-foreground"
        >
          {it.image ? (
            <ImageIcon className="w-3.5 h-3.5 shrink-0 text-violet-300" />
          ) : (
            <FileText className="w-3.5 h-3.5 shrink-0 text-amber-300" />
          )}
          <span className="truncate">{it.name}</span>
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(i)}
              disabled={disabled}
              aria-label={`Quitar ${it.name}`}
              className="text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
