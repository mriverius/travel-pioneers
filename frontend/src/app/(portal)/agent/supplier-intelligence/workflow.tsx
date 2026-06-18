"use client";

import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Cloud,
  CloudUpload,
  FileSpreadsheet,
  FileText,
  ImageIcon,
  Loader2,
  MessageSquareText,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  UserCheck,
  UserPlus,
  Download,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from "react";
import {
  api,
  ApiError,
  type AnalyzeBriefMeta,
  type BriefChatMessage,
  type ContractConfigVariables,
  type ExtractContractResponse,
  type ExtractedContract,
  type ExtractedContractRow,
  type ExtractedRowFieldKey,
  type ExtractedSharedFieldKey,
  type ExtractedSharedFields,
  type ExtractionConfianza,
  type ExtractionSourcePage,
  type GenerateXlsxCatalogPrefill,
  type GenerateXlsxManualFields,
  type ManualBankPrefill,
} from "@/lib/api";
import { ConfigVariablesStep } from "./configStep";
import {
  findSupplierByNameWithAI,
  findServiceForSupplierWithAI,
  type SupplierMatch,
} from "@/lib/supplierLookup";
import {
  CATEGORIAS_BY_TIPO_SERVICIO,
  TIPOS_SERVICIO,
} from "@/lib/serviceTypesCatalog";

/**
 * Three-step supplier-contract workflow wired to the backend agent at
 * `POST /api/supplier-intelligence/extract`.
 *
 *   1. Upload   — drag & drop a .pdf / .docx / .doc / .xlsx / .xls (≤20 MB).
 *   2. Review   — Tabla plana de 52 columnas (A..AZ). Cada combinación
 *                 product × season es una fila. Las columnas compartidas
 *                 (razón social, cédula, bancos…) muestran el mismo valor
 *                 en todas las filas; editar una propaga al resto. Source
 *                 page en tooltip al hover sobre cada celda.
 *   3. Download — POST /generate-xlsx con los datos aprobados y descarga el
 *                 xlsx final (clonado de plantilla-agente-utopia.xlsx).
 */

type Step = 1 | 2 | 3 | 4;

export type FileKind = "pdf" | "docx" | "xlsx" | "image";

/* -------------------------------------------------------------------------- */
/*                       Catalog prefill from master                          */
/* -------------------------------------------------------------------------- */

/**
 * Datos que vienen del catálogo lista-proveedores cuando el usuario marca
 * "Sí, existente" en step 1. Estos pre-llenan las columnas A, B, C, N del
 * xlsx. Cuando no hay match, el usuario los puede llenar a mano en step 2.
 */
export type CatalogPrefill = {
  tipo_actividad: string | null;
  zona_turismo: string | null;
  /** Código corto del proveedor en el maestro (columna C del xlsx). */
  proveedor_codigo: string | null;
  codigo_servicio: string | null;
};

export type CatalogMatchInfo =
  | {
      status: "matched";
      supplierName: string;
      supplierCode: string;
      matchedBy: SupplierMatch["matchedBy"];
      serviceMatched: boolean;
      aiConfidence?: SupplierMatch["aiConfidence"];
      aiReasoning?: string;
    }
  | { status: "not_found"; query: string; aiAttempted: boolean }
  | { status: "skipped"; reason: "new_supplier" | "no_query" };

const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Mirrors `MAX_UPLOAD_FILES` in the backend `uploadMiddleware`. Kept in sync
 * manually — if the backend raises this, bump it here too.
 */
const MAX_FILES_PER_REQUEST = 10;
const MAX_SECONDARY_FILES = MAX_FILES_PER_REQUEST - 1;

const STEP2_ANALYSIS_FOOTER =
  "Corre en dos fases: un pre-análisis rápido (Opus) que detecta las reglas " +
  "globales y luego la extracción completa que consolida todos los documentos. " +
  "Puede tardar varios minutos — mantené esta pestaña abierta.";

const STEP3_EXTRACT_FOOTER =
  "Extrayendo y estructurando todas las tarifas del contrato. El modelo está generando " +
  "cada combinación de habitación × temporada × ocupación. Puede tardar varios minutos " +
  "con contratos extensos — mantené esta pestaña abierta.";

const STEP3_RENDER_FOOTER =
  "Preparando la tabla con todas las filas generadas. Esto puede tomar unos segundos " +
  "según la cantidad de combinaciones — ya casi está listo.";

const ACCEPT_ATTR = [
  "application/pdf",
  ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".docx",
  "application/msword",
  ".doc",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsx",
  "application/vnd.ms-excel",
  ".xls",
  // Imágenes — Claude Opus 4.7 las lee nativamente con vision. Las
  // extensiones se incluyen además del MIME porque algunos sistemas
  // (notablemente Windows arrastrando desde el escritorio) suben con
  // MIME genérico application/octet-stream y nos quedamos sin señal.
  "image/jpeg",
  ".jpg",
  ".jpeg",
  "image/png",
  ".png",
  "image/gif",
  ".gif",
  "image/webp",
  ".webp",
].join(",");

const STEPS: { id: Step; label: string; hint: string }[] = [
  {
    id: 1,
    label: "Cargar documento",
    hint: "PDF, Word, Excel o imagen · máx 20 MB",
  },
  {
    id: 2,
    label: "Variables de configuración",
    hint: "Confirma IVA, comisión, temporadas…",
  },
  { id: 3, label: "Revisar información", hint: "Tabla con todas las filas" },
  { id: 4, label: "Descargar xlsx", hint: "Genera el archivo final" },
];

function inferKind(mime: string, name: string): FileKind | null {
  const lower = name.toLowerCase();
  // Match the extension as a token, not just at the end of the string. The
  // backend's `meta.filename` can be a combined display string like
  // `contrato.pdf (+2 más)` when multiple documents were uploaded; that still
  // needs to resolve to a kind so step 3 can persist the run with the right
  // file_kind. We anchor on `.ext` followed by a non-letter (word boundary,
  // space, end-of-string) so `.pdf2026` doesn't get mistaken for a PDF.
  if (mime === "application/pdf" || /\.pdf(\b|$|[^a-z])/i.test(lower)) {
    return "pdf";
  }
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/msword" ||
    /\.docx?(\b|$|[^a-z])/i.test(lower)
  ) {
    return "docx";
  }
  if (
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.ms-excel" ||
    /\.xlsx?(\b|$|[^a-z])/i.test(lower)
  ) {
    return "xlsx";
  }
  // Imágenes — todas comparten un único `file_kind = "image"` para no
  // explosionar el universo de tipos en BD. El media_type específico
  // (jpeg vs png vs …) lo resuelve el backend desde el MIME del upload.
  if (
    mime.startsWith("image/") ||
    /\.(jpe?g|png|gif|webp)(\b|$|[^a-z])/i.test(lower)
  ) {
    return "image";
  }
  return null;
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(kind: FileKind) {
  if (kind === "xlsx")
    return <FileSpreadsheet className="w-4 h-4 text-emerald-300" />;
  if (kind === "docx") return <FileText className="w-4 h-4 text-sky-300" />;
  if (kind === "image") return <ImageIcon className="w-4 h-4 text-violet-300" />;
  return <FileText className="w-4 h-4 text-amber-300" />;
}

/* ============================================================================
   SUPPLIER WORKFLOW (orchestrator)
   ========================================================================== */

export interface ApprovedPayload {
  sharedFields: ExtractedSharedFields;
  rows: ExtractedContractRow[];
  catalogPrefill: GenerateXlsxCatalogPrefill | null;
  manualFields: GenerateXlsxManualFields | null;
}

export function SupplierWorkflow() {
  const [step, setStep] = useState<Step>(1);
  /**
   * Documento principal (índice 0) + secundarios opcionales. El orden se
   * preserva end-to-end para el backend.
   */
  const [primaryFile, setPrimaryFile] = useState<File | null>(null);
  const [secondaryFiles, setSecondaryFiles] = useState<File[]>([]);
  const selectedFiles = useMemo(
    () => (primaryFile ? [primaryFile, ...secondaryFiles] : []),
    [primaryFile, secondaryFiles],
  );
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<ExtractContractResponse | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const primaryFileInputRef = useRef<HTMLInputElement>(null);
  const secondaryFileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Variables de Configuración detectadas en la Fase 1 (step 1 → 2) — UNA por
   * documento (flujo multi-documento). `briefs` es la salida de la IA (se
   * reemplaza al re-analizar); `editedBriefs` son los drafts vivos que el
   * usuario edita en cada tab (se envían a la extracción). `metas` guarda
   * filename/model/etc. por documento. `briefVersions` fuerza el remount del
   * editor cuando la IA reemplaza un brief tras un refine.
   */
  const [briefs, setBriefs] = useState<ContractConfigVariables[]>([]);
  const [editedBriefs, setEditedBriefs] = useState<ContractConfigVariables[]>(
    [],
  );
  const [metas, setMetas] = useState<AnalyzeBriefMeta[]>([]);
  const [chatHistories, setChatHistories] = useState<BriefChatMessage[][]>([]);
  const [briefVersions, setBriefVersions] = useState<number[]>([]);
  const [fileLabels, setFileLabels] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState(0);
  /** True mientras corre la extracción principal disparada desde el step 2. */
  const [extracting, setExtracting] = useState(false);
  const [preparingGrid, setPreparingGrid] = useState(false);
  /** Índice del tab que Opus está re-analizando (null = ninguno). */
  const [refiningTab, setRefiningTab] = useState<number | null>(null);

  /** Actualiza el draft vivo del documento `i` sin perder los de otros tabs. */
  const handleDraftChange = useCallback(
    (i: number, edited: ContractConfigVariables) => {
      setEditedBriefs((prev) => {
        if (prev[i] === edited) return prev;
        const next = [...prev];
        next[i] = edited;
        return next;
      });
    },
    [],
  );

  const [comments, setComments] = useState("");
  const [isExistingSupplier, setIsExistingSupplier] = useState<boolean | null>(
    null,
  );
  const [catalogPrefill, setCatalogPrefill] = useState<CatalogPrefill | null>(
    null,
  );
  const [, setCatalogMatchInfo] = useState<CatalogMatchInfo | null>(null);
  const [matchingPhase, setMatchingPhase] = useState<"local" | "ai" | null>(
    null,
  );

  const [approvedPayload, setApprovedPayload] = useState<ApprovedPayload | null>(
    null,
  );

  useEffect(() => {
    if (!analyzing && !extracting) return;
    const id = window.setInterval(() => {
      setProgress((p) => {
        if (p >= 90) return p;
        const step = Math.max(0.4, (90 - p) * 0.06);
        return Math.min(90, p + step);
      });
    }, 180);
    return () => window.clearInterval(id);
  }, [analyzing, extracting]);

  useEffect(() => {
    if (!preparingGrid) return;
    setProgress(15);
    const id = window.setInterval(() => {
      setProgress((p) => (p >= 92 ? p : Math.min(92, p + 6)));
    }, 120);
    return () => window.clearInterval(id);
  }, [preparingGrid]);

  /**
   * Valida archivos entrantes contra formato, tamaño y duplicados.
   */
  const validateIncomingFiles = (
    incoming: File[],
    seen: Set<string>,
    maxToAccept: number,
    limitMessage: string,
  ): { accepted: File[]; errors: string[] } => {
    const accepted: File[] = [];
    const errors: string[] = [];

    for (const file of incoming) {
      if (accepted.length >= maxToAccept) {
        errors.push(`${limitMessage} — se descartó "${file.name}".`);
        continue;
      }
      const kind = inferKind(file.type, file.name);
      if (!kind) {
        errors.push(
          `${file.name}: formato no admitido. Usa PDF, Word, Excel o imagen (JPG/PNG/GIF/WebP).`,
        );
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        errors.push(
          `${file.name}: excede el límite de 20 MB (${humanSize(file.size)}).`,
        );
        continue;
      }
      const key = `${file.name}|${file.size}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      accepted.push(file);
    }

    return { accepted, errors };
  };

  const buildSeenKeys = (): Set<string> => {
    const seen = new Set<string>();
    if (primaryFile) seen.add(`${primaryFile.name}|${primaryFile.size}`);
    for (const f of secondaryFiles) seen.add(`${f.name}|${f.size}`);
    return seen;
  };

  const acceptPrimaryFiles = (incoming: FileList | File[]) => {
    setServerError(null);
    const list = Array.from(incoming);
    if (list.length === 0) {
      setUploadError(null);
      return;
    }

    const errors: string[] = [];
    if (list.length > 1) {
      errors.push(
        "Solo se permite 1 documento principal. Usá la sección de documentos secundarios para archivos adicionales.",
      );
    }

    const seen = buildSeenKeys();
    const { accepted, errors: validationErrors } = validateIncomingFiles(
      list.slice(0, 1),
      seen,
      1,
      "Solo se permite 1 documento principal",
    );
    errors.push(...validationErrors);

    setUploadError(errors.length > 0 ? errors.join(" ") : null);
    if (accepted.length > 0) {
      setPrimaryFile(accepted[0]!);
    }
  };

  const acceptSecondaryFiles = (incoming: FileList | File[]) => {
    setServerError(null);
    const list = Array.from(incoming);
    if (list.length === 0) {
      setUploadError(null);
      return;
    }

    const slotsLeft = MAX_SECONDARY_FILES - secondaryFiles.length;
    if (slotsLeft <= 0) {
      setUploadError(
        `Máximo ${MAX_SECONDARY_FILES} documentos secundarios — quitá alguno para agregar más.`,
      );
      return;
    }

    const seen = buildSeenKeys();
    const { accepted, errors } = validateIncomingFiles(
      list,
      seen,
      slotsLeft,
      `Máximo ${MAX_SECONDARY_FILES} documentos secundarios`,
    );
    setUploadError(errors.length > 0 ? errors.join(" ") : null);
    if (accepted.length > 0) {
      setSecondaryFiles((prev) => [...prev, ...accepted]);
    }
  };

  const handlePrimaryDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    acceptPrimaryFiles(Array.from(files));
  };

  const handleSecondaryDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    acceptSecondaryFiles(Array.from(files));
  };

  const handlePrimaryPick = (e: ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    e.target.value = "";
    acceptPrimaryFiles(files);
  };

  const handleSecondaryPick = (e: ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    e.target.value = "";
    acceptSecondaryFiles(files);
  };

  const removePrimary = () => {
    setPrimaryFile(null);
    setUploadError(null);
    setServerError(null);
  };

  const removeSecondary = (index: number) => {
    setSecondaryFiles((prev) => prev.filter((_, i) => i !== index));
    setUploadError(null);
    setServerError(null);
  };

  const clearSecondaryFiles = () => {
    setSecondaryFiles([]);
    setUploadError(null);
    setServerError(null);
  };

  /**
   * Step 1 → 2: corre la Fase 1 (pre-análisis) Y el matching contra el catálogo
   * lista-proveedores, de modo que el step 2 pueda mostrar TODO lo compartido —
   * identidad del proveedor + reglas globales + clasificación de catálogo
   * (Tipo Actividad, Zona Turismo, Proveedor código). El matching usa el nombre
   * del proveedor que trae el brief; el hint de servicio usa el inventario de
   * categorías del brief (todavía no hay filas).
   */
  const startAnalysis = async () => {
    if (!primaryFile || analyzing || isExistingSupplier === null) {
      return;
    }
    setAnalyzing(true);
    setServerError(null);
    setProgress(4);
    resetConfigState();
    setStep(2);
    try {
      const files = selectedFiles;
      const responses = await Promise.all(
        files.map((f) =>
          api.supplierIntelligence.analyzeBrief([f], {
            comments,
            isExistingSupplier,
          }),
        ),
      );
      setProgress(100);

      // El documento PRIMARIO (primero) maneja el matching contra el catálogo.
      const brief = responses[0]!.brief;
      let prefill: CatalogPrefill | null = null;
      let matchInfo: CatalogMatchInfo | null = null;
      if (isExistingSupplier) {
        setMatchingPhase("local");
        const sharedNames = [
          brief.shared_fields.nombre_comercial,
          brief.shared_fields.proveedor,
        ]
          .map((s) => s?.trim())
          .filter((s): s is string => !!s);
        if (sharedNames.length === 0) {
          matchInfo = { status: "skipped", reason: "no_query" };
        } else {
          let match: SupplierMatch | null = null;
          let aiAttempted = false;
          for (const c of sharedNames) {
            match = await findSupplierByNameWithAI(c, { enableAIFallback: false });
            if (match) break;
          }
          if (!match) {
            setMatchingPhase("ai");
            aiAttempted = true;
            match = await findSupplierByNameWithAI(sharedNames[0] as string, {
              enableAIFallback: true,
            });
          }
          if (match) {
            // Hint de servicio desde el BRIEF (no hay filas todavía en este
            // punto del flujo gated): usamos el inventario de categorías de
            // producto + país + moneda como señal para elegir entre los
            // servicios del proveedor.
            const dedupe = (xs: Array<string | null>, cap: number): string[] =>
              Array.from(
                new Set(xs.filter((s): s is string => !!s && s.trim() !== "")),
              ).slice(0, cap);
            const categorias = dedupe(brief.product_categories, 8);
            const hintParts = [
              brief.shared_fields.nombre_comercial
                ? `Proveedor: ${brief.shared_fields.nombre_comercial}`
                : null,
              brief.shared_fields.type_of_business
                ? `Tipo negocio: ${brief.shared_fields.type_of_business}`
                : null,
              categorias.length > 0
                ? `Categorías/Productos: ${categorias.join(", ")}`
                : null,
              brief.currency ? `Moneda: ${brief.currency}` : null,
              brief.shared_fields.pais
                ? `País proveedor: ${brief.shared_fields.pais}`
                : null,
              comments?.trim() ? `Notas: ${comments.trim()}` : null,
              selectedFiles[0]?.name
                ? `Archivo: ${selectedFiles[0].name}` +
                  (selectedFiles.length > 1
                    ? ` (+${selectedFiles.length - 1} más)`
                    : "")
                : null,
            ].filter((s): s is string => s !== null);
            const serviceHint = hintParts.join(" · ");

            setMatchingPhase("ai");
            const serviceMatch = await findServiceForSupplierWithAI(
              match.supplier,
              serviceHint,
              { enableAIFallback: true },
            );
            setMatchingPhase(null);

            prefill = {
              tipo_actividad: match.supplier.actividad,
              zona_turismo: match.supplier.zona,
              proveedor_codigo: match.supplier.codigo,
              codigo_servicio: serviceMatch?.service.codigo ?? null,
            };
            matchInfo = {
              status: "matched",
              supplierName: match.supplier.nombre ?? match.supplier.codigo,
              supplierCode: match.supplier.codigo,
              matchedBy: match.matchedBy,
              serviceMatched: serviceMatch !== null,
              aiConfidence: match.aiConfidence,
              aiReasoning: match.aiReasoning,
            };
          } else {
            matchInfo = {
              status: "not_found",
              query: sharedNames[0] as string,
              aiAttempted,
            };
          }
        }
        setMatchingPhase(null);
      } else {
        matchInfo = { status: "skipped", reason: "new_supplier" };
      }
      setCatalogPrefill(prefill);
      setCatalogMatchInfo(matchInfo);

      await new Promise((r) => setTimeout(r, 300));
      const newBriefs = responses.map((r) => r.brief);
      setBriefs(newBriefs);
      setEditedBriefs(newBriefs.map((b) => b));
      setMetas(responses.map((r) => r.meta));
      setChatHistories(newBriefs.map(() => []));
      setBriefVersions(newBriefs.map(() => 0));
      setFileLabels(files.map((f) => f.name));
      setActiveTab(0);
    } catch (err) {
      if (err instanceof ApiError) {
        setServerError(err.message);
      } else {
        setServerError(
          "No pudimos conectar con el servidor. Revisa tu conexión e intenta de nuevo.",
        );
      }
      setProgress(0);
    } finally {
      setAnalyzing(false);
      setMatchingPhase(null);
    }
  };

  /** Sincroniza `seasons` (nombres) con `seasons_detail` antes de extraer. */
  const normalizeBrief = (
    b: ContractConfigVariables,
  ): ContractConfigVariables => {
    const seasonNames = b.seasons_detail
      .map((s) => s.name?.trim())
      .filter((s): s is string => !!s);
    return {
      ...b,
      seasons: seasonNames.length > 0 ? seasonNames : b.seasons,
    };
  };

  /**
   * Paso 2 — chat: re-analiza el brief del documento `tabIndex` con Opus según
   * el feedback del usuario. Cada documento tiene su propio historial.
   */
  const refineConfig = async (tabIndex: number, message: string) => {
    const file = selectedFiles[tabIndex];
    const prevBrief = editedBriefs[tabIndex] ?? briefs[tabIndex];
    if (
      !file ||
      !prevBrief ||
      refiningTab !== null ||
      extracting ||
      isExistingSupplier === null
    ) {
      return;
    }
    const userMsg = message.trim();
    if (!userMsg) return;

    setRefiningTab(tabIndex);
    setServerError(null);
    setChatHistories((prev) => {
      const next = [...prev];
      next[tabIndex] = [...(next[tabIndex] ?? []), { role: "user", content: userMsg }];
      return next;
    });

    try {
      const response = await api.supplierIntelligence.refineBrief([file], {
        comments,
        isExistingSupplier,
        previousBrief: prevBrief,
        feedbackMessage: userMsg,
        chatHistory: chatHistories[tabIndex] ?? [],
      });
      setBriefs((prev) => {
        const next = [...prev];
        next[tabIndex] = response.brief;
        return next;
      });
      setEditedBriefs((prev) => {
        const next = [...prev];
        next[tabIndex] = response.brief;
        return next;
      });
      setBriefVersions((prev) => {
        const next = [...prev];
        next[tabIndex] = (next[tabIndex] ?? 0) + 1;
        return next;
      });
      setMetas((prev) => {
        const next = [...prev];
        const cur = next[tabIndex];
        next[tabIndex] = cur
          ? {
              ...cur,
              model: response.meta.model,
              processed_at: response.meta.processed_at,
              input_tokens: response.meta.input_tokens,
              output_tokens: response.meta.output_tokens,
              cost_usd: response.meta.cost_usd,
            }
          : response.meta;
        return next;
      });
      const assistantReply =
        response.brief.logic_summary?.trim() ||
        "Actualicé el análisis según tus correcciones.";
      setChatHistories((prev) => {
        const next = [...prev];
        next[tabIndex] = [
          ...(next[tabIndex] ?? []),
          { role: "assistant", content: assistantReply },
        ];
        return next;
      });
    } catch (err) {
      if (err instanceof ApiError) {
        setServerError(err.message);
      } else {
        setServerError(
          "No pudimos reanalizar el documento. Revisa tu conexión e intenta de nuevo.",
        );
      }
    } finally {
      setRefiningTab(null);
    }
  };

  const handleGridReady = useCallback(() => {
    setProgress(100);
    setPreparingGrid(false);
  }, []);

  /**
   * Step 2 → 3: el usuario confirmó TODOS los briefs (uno por documento).
   * Corremos la extracción enviando el array de briefs validados; el backend
   * salta la Fase 1, consolida los documentos en un único conjunto de filas y
   * pasamos a la revisión de la grilla.
   */
  const confirmConfig = async () => {
    if (
      !primaryFile ||
      extracting ||
      preparingGrid ||
      refiningTab !== null ||
      isExistingSupplier === null ||
      briefs.length === 0
    ) {
      return;
    }
    const source = briefs.map((b, i) => editedBriefs[i] ?? b);
    const finalBriefs = source.map(normalizeBrief);
    setEditedBriefs(finalBriefs);
    setExtracting(true);
    setPreparingGrid(false);
    setServerError(null);
    setProgress(4);
    setResult(null);
    setStep(3);
    try {
      const response = await api.supplierIntelligence.extract(selectedFiles, {
        comments,
        isExistingSupplier,
        confirmedConfigs: finalBriefs,
      });
      setProgress(100);
      setResult(response);
      setPreparingGrid(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setServerError(err.message);
      } else {
        setServerError(
          "No pudimos conectar con el servidor. Revisa tu conexión e intenta de nuevo.",
        );
      }
      setProgress(0);
    } finally {
      setExtracting(false);
    }
  };

  const resetConfigState = () => {
    setBriefs([]);
    setEditedBriefs([]);
    setMetas([]);
    setChatHistories([]);
    setBriefVersions([]);
    setFileLabels([]);
    setActiveTab(0);
    setRefiningTab(null);
  };

  const reset = () => {
    setStep(1);
    setPrimaryFile(null);
    setSecondaryFiles([]);
    setResult(null);
    setUploadError(null);
    setServerError(null);
    setProgress(0);
    setComments("");
    setIsExistingSupplier(null);
    setCatalogPrefill(null);
    setCatalogMatchInfo(null);
    setMatchingPhase(null);
    setApprovedPayload(null);
    setExtracting(false);
    setPreparingGrid(false);
    resetConfigState();
  };

  /** Step 3 ← error o volver: regresa al Paso 2 conservando briefs y archivos. */
  const backToConfig = () => {
    setStep(2);
    setServerError(null);
    setProgress(0);
    setExtracting(false);
    setPreparingGrid(false);
    setResult(null);
  };

  /** Step 2 ← 1: volver del config a la carga sin perder los archivos. */
  const backToUpload = () => {
    setStep(1);
    setServerError(null);
    setProgress(0);
    resetConfigState();
  };

  const approve = (payload: ApprovedPayload) => {
    setApprovedPayload(payload);
    setStep(4);
  };

  return (
    <>
      <section className="relative overflow-hidden rounded-2xl border border-border bg-card/80 shadow-[0_1px_0_0_hsl(var(--primary)/0.08)_inset]">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-20 left-1/2 h-56 w-[70%] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl"
        />

      <div className="relative px-5 sm:px-8 pt-6 pb-5 border-b border-border">
        <ol className="flex items-center justify-between gap-2">
          {STEPS.map((s, i) => {
            const state: "complete" | "current" | "upcoming" =
              step > s.id ? "complete" : step === s.id ? "current" : "upcoming";
            return (
              <li
                key={s.id}
                className="flex-1 flex items-center"
                aria-current={state === "current" ? "step" : undefined}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`w-8 h-8 rounded-full border flex items-center justify-center text-[12.5px] font-semibold shrink-0 transition-colors ${
                      state === "complete"
                        ? "bg-primary text-primary-foreground border-primary shadow-[0_0_14px_0_hsl(var(--primary)/0.35)]"
                        : state === "current"
                          ? "bg-primary/15 text-primary border-primary/50 animate-pulse-glow"
                          : "bg-secondary/50 text-muted-foreground border-border"
                    }`}
                  >
                    {state === "complete" ? <Check className="w-4 h-4" /> : s.id}
                  </div>
                  <div className="hidden sm:block min-w-0">
                    <p
                      className={`text-[13px] font-semibold truncate ${
                        state === "upcoming"
                          ? "text-muted-foreground"
                          : "text-foreground"
                      }`}
                    >
                      {s.label}
                    </p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {s.hint}
                    </p>
                  </div>
                </div>
                {i < STEPS.length - 1 && (
                  <div
                    aria-hidden
                    className={`flex-1 h-px mx-3 sm:mx-4 transition-colors ${
                      step > s.id ? "bg-primary/50" : "bg-border"
                    }`}
                  />
                )}
              </li>
            );
          })}
        </ol>
      </div>

      <div key={step} className="animate-page-enter">
        {step === 1 && (
          <UploadStep
            primaryFile={primaryFile}
            secondaryFiles={secondaryFiles}
            uploadError={uploadError}
            serverError={serverError}
            analyzing={analyzing}
            primaryFileInputRef={primaryFileInputRef}
            secondaryFileInputRef={secondaryFileInputRef}
            comments={comments}
            onCommentsChange={setComments}
            isExistingSupplier={isExistingSupplier}
            onExistingSupplierChange={setIsExistingSupplier}
            onPrimaryDrop={handlePrimaryDrop}
            onSecondaryDrop={handleSecondaryDrop}
            onPrimaryPick={handlePrimaryPick}
            onSecondaryPick={handleSecondaryPick}
            onRemovePrimary={removePrimary}
            onRemoveSecondary={removeSecondary}
            onClearSecondary={clearSecondaryFiles}
            onStart={startAnalysis}
          />
        )}

        {step === 2 && analyzing && briefs.length === 0 && (
          <div className="px-5 sm:px-8 py-7">
            <AnalysisProgressCard
              files={selectedFiles}
              totalBytes={selectedFiles.reduce((acc, f) => acc + f.size, 0)}
              progress={progress}
              matchingPhase={matchingPhase}
              footerDescription={STEP2_ANALYSIS_FOOTER}
            />
          </div>
        )}

        {step === 2 && !analyzing && briefs.length === 0 && serverError && (
          <div className="px-5 sm:px-8 py-7 space-y-4">
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-[13px] text-destructive"
            >
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{serverError}</span>
            </div>
            <button
              type="button"
              onClick={backToUpload}
              className="inline-flex items-center justify-center gap-2 h-11 px-4 rounded-lg border border-border bg-secondary/40 text-[13.5px] text-foreground hover:bg-secondary/70 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Volver
            </button>
          </div>
        )}

        {step === 2 && briefs.length > 0 && (
          <div className="px-5 sm:px-8 pt-5">
            {/* Tabs por documento (solo si hay más de uno) */}
            {briefs.length > 1 && (
              <div className="flex flex-wrap gap-1.5 border-b border-border pb-3">
                {fileLabels.map((label, i) => {
                  const active = i === activeTab;
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setActiveTab(i)}
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-colors ${
                        active
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border bg-secondary/30 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0" />
                      <span className="max-w-[180px] truncate">{label}</span>
                      {refiningTab === i && (
                        <Loader2 className="h-3 w-3 animate-spin text-primary" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Editores: TODOS montados, el inactivo oculto, para no perder
                ediciones al cambiar de tab. */}
            {briefs.map((b, i) => (
              <div key={i} className={i === activeTab ? "" : "hidden"}>
                <ConfigVariablesStep
                  key={`${i}-${briefVersions[i] ?? 0}`}
                  config={b}
                  meta={
                    metas[i] ?? {
                      filename: fileLabels[i] ?? "",
                      size_bytes: 0,
                      model: "",
                      processed_at: "",
                    }
                  }
                  catalogPrefill={catalogPrefill}
                  extracting={extracting}
                  isRefining={refiningTab === i}
                  chatHistory={chatHistories[i] ?? []}
                  serverError={null}
                  onConfirm={() => confirmConfig()}
                  onRefine={(msg) => refineConfig(i, msg)}
                  onBack={backToUpload}
                  onDraftChange={(edited) => handleDraftChange(i, edited)}
                  onCatalogChange={setCatalogPrefill}
                  showActions={false}
                />
              </div>
            ))}

            {/* Acciones GLOBALES (una sola extracción para todos los docs) */}
            <div className="pb-7 space-y-4">
              {serverError && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-[13px] text-destructive"
                >
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{serverError}</span>
                </div>
              )}
              <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2">
                <button
                  type="button"
                  onClick={backToUpload}
                  disabled={extracting || refiningTab !== null}
                  className="inline-flex items-center justify-center gap-2 h-11 px-4 rounded-lg border border-border bg-secondary/40 text-[13.5px] text-foreground hover:bg-secondary/70 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Volver
                </button>
                <button
                  type="button"
                  onClick={() => confirmConfig()}
                  disabled={extracting || refiningTab !== null}
                  className="btn-premium inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-[13.5px]"
                >
                  {extracting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Extrayendo tarifas…
                    </>
                  ) : (
                    <>
                      <Check className="w-4 h-4" />
                      {briefs.length > 1
                        ? "Confirmar todo y extraer tarifas"
                        : "Confirmar y extraer tarifas"}
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {step === 3 && extracting && (
          <div className="px-5 sm:px-8 py-7">
            <AnalysisProgressCard
              files={selectedFiles}
              totalBytes={selectedFiles.reduce((acc, f) => acc + f.size, 0)}
              progress={progress}
              matchingPhase={null}
              getPhase={extractionPhase}
              footerDescription={STEP3_EXTRACT_FOOTER}
            />
          </div>
        )}

        {step === 3 && !extracting && !result && serverError && (
          <div className="px-5 sm:px-8 py-7 space-y-4">
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-[13px] text-destructive"
            >
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{serverError}</span>
            </div>
            <div className="flex flex-col-reverse sm:flex-row sm:items-center gap-2">
              <button
                type="button"
                onClick={backToConfig}
                className="inline-flex items-center justify-center gap-2 h-11 px-4 rounded-lg border border-border bg-secondary/40 text-[13.5px] text-foreground hover:bg-secondary/70 transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
                Volver a configuración
              </button>
              <button
                type="button"
                onClick={() => confirmConfig()}
                className="btn-premium inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-[13.5px]"
              >
                <RotateCcw className="w-4 h-4" />
                Reintentar extracción
              </button>
            </div>
          </div>
        )}

        {step === 3 && preparingGrid && result && (
          <div className="px-5 sm:px-8 py-7">
            <AnalysisProgressCard
              files={selectedFiles}
              totalBytes={selectedFiles.reduce((acc, f) => acc + f.size, 0)}
              progress={progress}
              matchingPhase={null}
              getPhase={gridRenderPhase}
              footerDescription={STEP3_RENDER_FOOTER}
            />
          </div>
        )}

        {step === 3 && result && (
          <div
            className={
              preparingGrid
                ? "fixed opacity-0 pointer-events-none -z-10 h-0 overflow-hidden"
                : undefined
            }
            aria-hidden={preparingGrid}
          >
            <ReviewStep
              result={result}
              catalogPrefill={catalogPrefill}
              onApprove={approve}
              onGridReady={preparingGrid ? handleGridReady : undefined}
            />
          </div>
        )}

        {step === 4 && result && approvedPayload && (
          <DownloadStep
            payload={approvedPayload}
            meta={result.meta}
            onReset={reset}
          />
        )}
      </div>
    </section>

    <div className="text-center mt-4 space-y-1">
      <p className="text-[11px] text-muted-foreground/60">Version 1.6.0 - Junio 17</p>
      <a
        href="https://forms.gle/GANUbdcuAS3P7szS8"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[11px] text-primary/70 hover:text-primary transition-colors"
      >
        ¿Encontraste un bug? Repórtalo
      </a>
    </div>
    </>
  );
}

/* ============================================================================
   STEP 1 — Upload
   ========================================================================== */

function UploadStep({
  primaryFile,
  secondaryFiles,
  uploadError,
  serverError,
  analyzing,
  primaryFileInputRef,
  secondaryFileInputRef,
  comments,
  onCommentsChange,
  isExistingSupplier,
  onExistingSupplierChange,
  onPrimaryDrop,
  onSecondaryDrop,
  onPrimaryPick,
  onSecondaryPick,
  onRemovePrimary,
  onRemoveSecondary,
  onClearSecondary,
  onStart,
}: {
  primaryFile: File | null;
  secondaryFiles: File[];
  uploadError: string | null;
  serverError: string | null;
  analyzing: boolean;
  primaryFileInputRef: React.RefObject<HTMLInputElement | null>;
  secondaryFileInputRef: React.RefObject<HTMLInputElement | null>;
  comments: string;
  onCommentsChange: (value: string) => void;
  isExistingSupplier: boolean | null;
  onExistingSupplierChange: (value: boolean) => void;
  onPrimaryDrop: (e: DragEvent<HTMLDivElement>) => void;
  onSecondaryDrop: (e: DragEvent<HTMLDivElement>) => void;
  onPrimaryPick: (e: ChangeEvent<HTMLInputElement>) => void;
  onSecondaryPick: (e: ChangeEvent<HTMLInputElement>) => void;
  onRemovePrimary: () => void;
  onRemoveSecondary: (index: number) => void;
  onClearSecondary: () => void;
  onStart: () => void;
}) {
  const COMMENTS_MAX = 5000;
  const secondarySlotsLeft = MAX_SECONDARY_FILES - secondaryFiles.length;
  const canAddSecondary = secondarySlotsLeft > 0 && !analyzing;
  const canSubmit = !!primaryFile && !analyzing && isExistingSupplier !== null;

  return (
    <div className="px-5 sm:px-8 py-7 space-y-5">
      <div className="grid gap-5 lg:grid-cols-2">
        <DocumentUploadSection
          title="Documento principal"
          description="El contrato o cotización base. Solo se acepta 1 archivo."
          disabled={analyzing}
          inputRef={primaryFileInputRef}
          multiple={false}
          onDrop={onPrimaryDrop}
          onPick={onPrimaryPick}
          emptyTitle="Arrastra el documento principal aquí"
          emptyHint="o haz click para buscar en tu equipo"
        >
          {primaryFile && (
            <UploadedFileRow file={primaryFile} onRemove={onRemovePrimary} />
          )}
        </DocumentUploadSection>

        <DocumentUploadSection
          title="Documentos secundarios"
          badge="opcional"
          description="Listas de precios, anexos, catálogos u otros archivos de apoyo. Podés subir hasta 9."
          disabled={!canAddSecondary}
          inputRef={secondaryFileInputRef}
          multiple
          onDrop={onSecondaryDrop}
          onPick={onSecondaryPick}
          emptyTitle="Arrastra documentos de apoyo aquí"
          emptyHint={
            secondaryFiles.length > 0
              ? "o haz click para agregar más archivos"
              : "o haz click para buscar en tu equipo"
          }
        >
          {secondaryFiles.length > 0 && (
            <div className="mt-3 rounded-lg border border-border/60 bg-card/40 divide-y divide-border/60">
              <header className="flex items-center justify-between px-3 py-2 border-b border-border/60">
                <p className="text-[11.5px] font-medium text-foreground">
                  {secondaryFiles.length}{" "}
                  {secondaryFiles.length === 1 ? "archivo" : "archivos"}
                </p>
                {secondaryFiles.length > 1 && (
                  <button
                    type="button"
                    onClick={onClearSecondary}
                    className="text-[10.5px] text-muted-foreground hover:text-destructive transition-colors"
                  >
                    Quitar todos
                  </button>
                )}
              </header>
              <ul>
                {secondaryFiles.map((f, idx) => (
                  <UploadedFileRow
                    key={`${f.name}|${f.size}|${idx}`}
                    file={f}
                    onRemove={() => onRemoveSecondary(idx)}
                  />
                ))}
              </ul>
              {canAddSecondary && (
                <div className="px-3 py-2 border-t border-border/60">
                  <button
                    type="button"
                    onClick={() => secondaryFileInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 text-[11.5px] text-primary hover:text-primary/80 transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Agregar otro
                    <span className="text-muted-foreground/80">
                      ({secondarySlotsLeft}{" "}
                      {secondarySlotsLeft === 1 ? "disponible" : "disponibles"})
                    </span>
                  </button>
                </div>
              )}
            </div>
          )}
        </DocumentUploadSection>
      </div>

      {uploadError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-[13px] text-destructive"
        >
          <X className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{uploadError}</span>
        </div>
      )}

      {serverError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-[13px] text-destructive"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{serverError}</span>
        </div>
      )}

      <ExistingSupplierToggle
        value={isExistingSupplier}
        onChange={onExistingSupplierChange}
        disabled={analyzing}
      />

      <CommentsField
        value={comments}
        onChange={onCommentsChange}
        max={COMMENTS_MAX}
        disabled={analyzing}
      />

      <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2">
        <button
          type="button"
          onClick={onStart}
          disabled={!canSubmit}
          className="btn-premium inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-[13.5px]"
        >
          {analyzing ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Analizando contrato…
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4" />
              Analizar con IA
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function DocumentUploadSection({
  title,
  badge,
  description,
  disabled,
  inputRef,
  multiple,
  onDrop,
  onPick,
  emptyTitle,
  emptyHint,
  children,
}: {
  title: string;
  badge?: string;
  description: string;
  disabled: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  multiple: boolean;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
  onPick: (e: ChangeEvent<HTMLInputElement>) => void;
  emptyTitle: string;
  emptyHint: string;
  children?: ReactNode;
}) {
  const [dragActive, setDragActive] = useState(false);
  const hasContent = !!children;

  return (
    <div className="space-y-2">
      <div>
        <p className="text-[13px] font-semibold text-foreground">
          {title}
          {badge && (
            <span className="ml-2 inline-flex items-center rounded border border-border bg-secondary/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {badge}
            </span>
          )}
        </p>
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">{description}</p>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          setDragActive(false);
          if (disabled) {
            e.preventDefault();
            return;
          }
          onDrop(e);
        }}
        onClick={() => {
          if (!disabled) inputRef.current?.click();
        }}
        role="button"
        tabIndex={0}
        aria-disabled={disabled}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !disabled) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        className={`group rounded-2xl border-2 border-dashed p-6 sm:p-7 text-center transition-all ${
          disabled
            ? "cursor-not-allowed opacity-60 border-border bg-secondary/20"
            : dragActive
              ? "cursor-pointer border-primary bg-primary/10 shadow-[0_0_30px_0_hsl(var(--primary)/0.25)]"
              : "cursor-pointer border-border bg-secondary/20 hover:border-primary/50 hover:bg-primary/5"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTR}
          multiple={multiple}
          onChange={onPick}
          className="hidden"
        />
        {!hasContent && (
          <>
            <div className="mx-auto w-12 h-12 rounded-2xl bg-primary/15 border border-primary/30 flex items-center justify-center animate-pulse-glow">
              <CloudUpload className="w-5 h-5 text-primary" />
            </div>
            <p className="mt-3 text-[14px] font-semibold text-foreground">
              {emptyTitle}
            </p>
            <p className="mt-1 text-[12px] text-muted-foreground">
              {emptyHint}
            </p>
            <div className="mt-3 inline-flex flex-wrap items-center justify-center gap-1.5 text-[10.5px] text-muted-foreground/80">
              <Badge label="PDF" />
              <Badge label="DOCX" />
              <Badge label="XLSX" />
              <Badge label="JPG" />
              <Badge label="PNG" />
              <span className="opacity-60">· hasta 20 MB c/u</span>
            </div>
          </>
        )}
        {hasContent && children}
      </div>
    </div>
  );
}

function UploadedFileRow({
  file,
  onRemove,
}: {
  file: File;
  onRemove: () => void;
}) {
  const fkind = inferKind(file.type, file.name);
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="w-8 h-8 rounded-lg bg-secondary/70 border border-border/60 flex items-center justify-center shrink-0">
        {fkind ? (
          fileIcon(fkind)
        ) : (
          <FileText className="w-4 h-4 text-muted-foreground" />
        )}
      </div>
      <div className="flex-1 min-w-0 text-left">
        <p className="text-[13px] text-foreground truncate">{file.name}</p>
        <p className="text-[11px] text-muted-foreground">
          {humanSize(file.size)}
          {fkind ? ` · ${fkind.toUpperCase()}` : ""}
        </p>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        aria-label={`Quitar ${file.name}`}
        className="text-muted-foreground hover:text-destructive transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

function ExistingSupplierToggle({
  value,
  onChange,
  disabled,
}: {
  value: boolean | null;
  onChange: (next: boolean) => void;
  disabled: boolean;
}) {
  const untouched = value === null;
  return (
    <div
      className={`rounded-xl border bg-card/60 transition-colors ${
        untouched ? "border-amber-500/40" : "border-border"
      }`}
    >
      <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-[12.5px] font-semibold text-foreground">
            ¿Es un proveedor existente?{" "}
            <span className="text-rose-300" aria-hidden>
              *
            </span>
          </p>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
            Indica si el proveedor ya existe en el sistema o es uno nuevo.
            Campo requerido.
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label="¿Es un proveedor existente?"
          aria-required="true"
          className="inline-flex shrink-0 self-start rounded-lg border border-border bg-secondary/40 p-0.5 sm:self-auto"
        >
          <ToggleButton
            icon={UserCheck}
            label="Sí, existente"
            active={value === true}
            disabled={disabled}
            onClick={() => onChange(true)}
          />
          <ToggleButton
            icon={UserPlus}
            label="No, es nuevo"
            active={value === false}
            disabled={disabled}
            onClick={() => onChange(false)}
          />
        </div>
      </div>
    </div>
  );
}

function ToggleButton({
  icon: Icon,
  label,
  active,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? "bg-primary text-primary-foreground shadow-[0_0_10px_0_hsl(var(--primary)/0.35)]"
          : "text-muted-foreground hover:text-foreground hover:bg-secondary/70"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function CommentsField({
  value,
  onChange,
  max,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  max: number;
  disabled: boolean;
}) {
  const remaining = max - value.length;
  const showCounter = value.length > Math.floor(max * 0.8);
  const overLimit = value.length > max;

  return (
    <div className="rounded-xl border border-border bg-card/60">
      <div className="px-4 py-3 border-b border-border/60">
        <div className="flex items-center gap-2">
          <MessageSquareText className="h-3.5 w-3.5 text-muted-foreground" />
          <p className="text-[12.5px] font-semibold text-foreground">
            Comentarios adicionales{" "}
            <span className="text-muted-foreground/70 font-normal">
              (opcional)
            </span>
          </p>
        </div>
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">
          A veces el correo trae datos que no están en los documentos
          (cuenta bancaria, referencia, instrucciones). Pégalos aquí y la IA
          los usará como contexto adicional.
        </p>
      </div>
      <div className="px-4 py-3 space-y-1.5">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          rows={3}
          maxLength={max}
          placeholder="Pega aquí cualquier información adicional del cuerpo del correo…"
          aria-label="Comentarios adicionales"
          className="w-full resize-y rounded-lg border border-border bg-secondary/30 px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-primary/60 focus:bg-secondary/50 disabled:cursor-not-allowed disabled:opacity-50"
        />
        {showCounter && (
          <p
            className={`text-right text-[11px] tabular-nums ${
              overLimit ? "text-destructive" : "text-muted-foreground"
            }`}
            aria-live="polite"
          >
            {remaining} caracteres restantes
          </p>
        )}
      </div>
    </div>
  );
}

function Badge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded border border-border bg-secondary/40 text-[10.5px] font-semibold tracking-wider">
      {label}
    </span>
  );
}

/**
 * Fases mostradas durante el análisis. El % es una estimación temporal (no
 * hay streaming del backend), pero los tramos reflejan el flujo real de dos
 * pasadas: pre-análisis rápido (Sonnet 4.6) que detecta las reglas globales,
 * y luego la extracción completa (Opus 4.7) que genera todas las filas — esta
 * última es la que se lleva la mayor parte del tiempo, de ahí el tramo ancho.
 */
function extractionPhase(progress: number): string {
  if (progress < 12) return "Iniciando extracción de tarifas…";
  if (progress < 35) return "Procesando habitaciones y temporadas…";
  if (progress < 70) return "Generando combinaciones habitación × temporada × ocupación…";
  if (progress < 90) return "Estructurando filas para la grilla…";
  if (progress < 100) return "Finalizando extracción…";
  return "Listo";
}

function gridRenderPhase(progress: number): string {
  if (progress < 50) return "Preparando columnas de la tabla…";
  if (progress < 85) return "Cargando filas generadas…";
  return "Aplicando formato a la grilla…";
}

function analysisPhase(progress: number): string {
  if (progress < 14) return "Preparando el documento…";
  if (progress < 32) return "Analizando reglas globales del contrato…";
  if (progress < 88) return "Extrayendo todas las tarifas con IA…";
  if (progress < 100) return "Validando datos extraídos…";
  return "Listo";
}

function AnalysisProgressCard({
  files,
  totalBytes,
  progress,
  matchingPhase,
  footerDescription,
  getPhase,
}: {
  files: File[];
  totalBytes: number;
  progress: number;
  matchingPhase: "local" | "ai" | null;
  footerDescription?: string;
  getPhase?: (progress: number) => string;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(progress)));
  const phase = getPhase
    ? getPhase(progress)
    : matchingPhase === "ai"
      ? "Buscando coincidencia en el maestro con IA…"
      : matchingPhase === "local"
        ? "Buscando coincidencia en el maestro…"
        : analysisPhase(progress);

  const primary = files[0];
  const primaryKind = primary ? inferKind(primary.type, primary.name) : null;
  const headlineName = primary
    ? files.length === 1
      ? primary.name
      : `${primary.name} (+${files.length - 1} más)`
    : "";

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border/50">
        <div className="w-8 h-8 rounded-lg bg-secondary/70 border border-border/60 flex items-center justify-center shrink-0">
          {primaryKind ? (
            fileIcon(primaryKind)
          ) : (
            <FileText className="w-4 h-4 text-muted-foreground" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] text-foreground truncate">{headlineName}</p>
          <p className="text-[11px] text-muted-foreground">
            {files.length === 1
              ? `${humanSize(totalBytes)}${primaryKind ? ` · ${primaryKind.toUpperCase()}` : ""}`
              : `${files.length} documentos · ${humanSize(totalBytes)} total`}
          </p>
        </div>
        <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />
      </div>
      <div className="px-4 py-3.5 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12.5px] text-foreground/90 truncate">{phase}</p>
          <p
            className="text-[12.5px] font-semibold text-primary tabular-nums"
            aria-live="polite"
          >
            {matchingPhase === "ai" ? "—" : `${pct}%`}
          </p>
        </div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label="Progreso del análisis"
          className="relative h-1.5 w-full overflow-hidden rounded-full bg-secondary/70 border border-border/50"
        >
          <div
            className={`h-full rounded-full bg-primary shadow-[0_0_12px_0_hsl(var(--primary)/0.5)] transition-[width] duration-200 ease-out ${
              matchingPhase === "ai" ? "animate-pulse" : ""
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          {footerDescription ??
            (matchingPhase === "ai"
              ? "Pidiéndole a Claude que elija el proveedor del catálogo. Opus 4.7 puede tardar 30-60s para contratos con muchas combinaciones."
              : files.length > 1
                ? `Corre en dos fases: un pre-análisis rápido (Opus) que ` +
                  `detecta las reglas globales y luego la extracción completa ` +
                  `que consolida ${files.length} documentos. Puede ` +
                  `tardar varios minutos — mantené esta pestaña abierta.`
                : "Corre en dos fases: un pre-análisis rápido (Opus) que " +
                  "detecta las reglas globales (impuestos, bancos, persona " +
                  "adicional) y luego la extracción completa. Los " +
                  "contratos densos pueden tardar varios minutos — mantené esta " +
                  "pestaña abierta.")}
        </p>
      </div>
    </div>
  );
}

/* ============================================================================
   COLUMN DEFINITIONS — flat 52-col schema (A..AZ)
   ========================================================================== */

export interface SelectOption {
  codigo: string;
  descripcion: string;
}

/**
 * Scope de cada columna:
 *  - "shared": el mismo valor en TODAS las filas del xlsx. Editar una celda
 *    propaga el cambio al resto de filas. Sub-tipos:
 *      - ai:      la IA la extrae del contrato (mapea a ExtractedSharedFields)
 *      - catalog: viene del prefill contra lista-proveedores
 *      - manual:  no la extrae ni la IA ni el catálogo; el usuario la escribe
 *  - "row": valor independiente por combinación product × season.
 */
type ColumnScope =
  | { kind: "shared"; source: "ai" | "catalog" | "manual" }
  | { kind: "row" };

export interface ColumnDef {
  excelCol: string;
  key: string;
  label: string;
  scope: ColumnScope;
  inputType?: "text" | "date" | "email" | "number";
  multiline?: boolean;
  minWidth: number;
  placeholder?: string;
  /**
   * Marca la columna como monetaria. El render read-only antepone el código
   * de moneda del contrato (`sharedFields.tipo_moneda` — ej. "USD", "CRC",
   * "CAD") al valor; si `tipo_moneda` está vacío, no mostramos prefijo para
   * no inventar una moneda incorrecta (un proveedor de Costa Rica facturando
   * en colones no debería ver "$ 295" por defecto).
   *
   * El valor almacenado y el editor permanecen como número plano — el código
   * de moneda vive solo en el render para no contaminar el payload del
   * backend ni la lógica de comparación de strings.
   */
  currency?: true;
  options?: (ctx: {
    tipoServicio: string | null;
  }) => ReadonlyArray<SelectOption>;
}

const TIPO_UNIDAD_OPTIONS: ReadonlyArray<SelectOption> = [
  { codigo: "N", descripcion: "Por noche" },
  { codigo: "S", descripcion: "Por servicio" },
];

/**
 * Opciones para "Tipo Tarifa" (columnas X, AA, AC, AD, AG).
 *
 * Convención del sistema: el writer xlsx espera literalmente el código
 * "1" o "2" en esas celdas y la inferencia automática
 * (`inferTipoTarifa` en xlsxGenerator.ts) emite los mismos códigos —
 * mantener la UI restringida a "1"/"2" evita free-text como "Por
 * persona" o "Wholesale" que rompía la plantilla downstream. Las cinco
 * columnas (regular X/AA + fin de semana AC/AD/AG) usan el MISMO set
 * de opciones.
 */
const TIPO_TARIFA_OPTIONS: ReadonlyArray<SelectOption> = [
  { codigo: "1", descripcion: "Fija" },
  { codigo: "2", descripcion: "Porcentual" },
];

/**
 * Opciones para "Condiciones Crédito" (columna AP). El maestro espera
 * literalmente el código numérico:
 *   "1" = CONTADO, "2" = CRÉDITO, "3" = PREPAGO
 * El usuario elige la modalidad y el plazo concreto ("30 días neto",
 * etc.) va en la columna AQ (`plazo`).
 */
const COND_CREDITO_OPTIONS: ReadonlyArray<SelectOption> = [
  { codigo: "1", descripcion: "Contado" },
  { codigo: "2", descripcion: "Crédito" },
  { codigo: "3", descripcion: "Prepago" },
];

/**
 * Devuelve la fecha tal cual está guardada (`YYYY-MM-DD`). El sistema
 * mantiene un único formato extremo a extremo — input nativo `<input
 * type="date">` lee/escribe en ISO, el normalizador server-side
 * (`normalizeDate` en validators.ts) garantiza ISO antes de persistir,
 * y la grilla muestra ISO. Si llega algo distinto (ej. una run viejo
 * pre-guardrail) lo dejamos pasar literal — preferible a "Invalid Date".
 */
function formatDateDisplay(value: string): string {
  return value;
}

/**
 * Devuelve el valor formateado para mostrar en la celda read-only:
 *   - Fechas → YYYY-MM-DD (mismo formato que el storage)
 *   - Columnas con `currency` → "<código> <valor>" (ej. "USD 295", "CRC 150000").
 *     `tipoMoneda` viene del contrato. Si está vacío, NO mostramos prefijo —
 *     preferimos un valor sin prefijo a inventar una moneda. Si el valor ya
 *     empieza con el código (porque la IA lo extrajo literal, ej. "USD 295"),
 *     no lo duplicamos.
 */
export function formatCellDisplay(
  col: ColumnDef,
  value: string,
  tipoMoneda: string | null,
): string {
  const formatted = col.inputType === "date" ? formatDateDisplay(value) : value;
  if (col.currency) {
    const code = tipoMoneda?.trim();
    if (!code) return formatted;
    const trimmed = formatted.trimStart();
    if (trimmed.toUpperCase().startsWith(code.toUpperCase())) return formatted;
    return `${code} ${formatted}`;
  }
  return formatted;
}

/**
 * Las 52 columnas A..AZ de la plantilla xlsx en orden. Fuente de verdad para
 * el render de la tabla y para construir el payload del backend.
 */
export const ALL_COLUMNS: ColumnDef[] = [
  { excelCol: "A",  key: "tipo_actividad",    label: "Tipo Actividad",     scope: { kind: "shared", source: "catalog" }, minWidth: 130, placeholder: "Ej: Hospedaje" },
  { excelCol: "B",  key: "zona_turismo",      label: "Zona Turismo",       scope: { kind: "shared", source: "catalog" }, minWidth: 140, placeholder: "Ej: Pacífico Central" },
  { excelCol: "C",  key: "proveedor_codigo",  label: "Proveedor (código)", scope: { kind: "shared", source: "catalog" }, minWidth: 130, placeholder: "Ej: PARADOR" },
  { excelCol: "D",  key: "proveedor",         label: "Razón Social",       scope: { kind: "shared", source: "ai" },      minWidth: 200, placeholder: "Ej: ACME S.A." },
  { excelCol: "E",  key: "cedula",            label: "Cédula Jurídica",    scope: { kind: "shared", source: "ai" },      minWidth: 140, placeholder: "3-101-123456" },
  { excelCol: "F",  key: "fecha",             label: "Contract Date",      scope: { kind: "shared", source: "ai" },      minWidth: 130, inputType: "date" },
  { excelCol: "G",  key: "nombre_comercial",  label: "Nombre Comercial",   scope: { kind: "shared", source: "ai" },      minWidth: 180, placeholder: "Ej: ACME" },
  { excelCol: "H",  key: "pais",              label: "País",               scope: { kind: "shared", source: "ai" },      minWidth: 110, placeholder: "Costa Rica" },
  { excelCol: "I",  key: "state_province",    label: "State / Province",   scope: { kind: "shared", source: "ai" },      minWidth: 130, placeholder: "Puntarenas" },
  { excelCol: "J",  key: "direccion",         label: "Location",           scope: { kind: "shared", source: "ai" },      minWidth: 240, placeholder: "Calle, ciudad…", multiline: true },
  { excelCol: "K",  key: "type_of_business",  label: "Type of Business",   scope: { kind: "shared", source: "ai" },      minWidth: 150, placeholder: "Ej: Hotel" },
  { excelCol: "L",  key: "contract_starts",   label: "Contract Starts",    scope: { kind: "shared", source: "ai" },      minWidth: 140, inputType: "date" },
  { excelCol: "M",  key: "contract_ends",     label: "Contract Ends",      scope: { kind: "shared", source: "ai" },      minWidth: 140, inputType: "date" },
  // Bug #2: codigo_servicio es POR FILA — la IA lo deriva del nombre del
  // producto de cada fila (antes era shared y replicaba "MASTER" para
  // todas). El catálogo lo sigue trayendo como hint via prefill, pero el
  // valor que termina en el xlsx sale de `rows[i].codigo_servicio`.
  { excelCol: "N",  key: "codigo_servicio",   label: "Cod. Servicio",      scope: { kind: "row" },                       minWidth: 130, placeholder: "Ej: MAS, SUI…" },
  { excelCol: "O",  key: "product_name",      label: "Product Name",       scope: { kind: "row" },                       minWidth: 170, placeholder: "Garden, Suites…" },
  // tipo_unidad / tipo_servicio son POR FILA (Bug #1 / #5) — permiten
  // mixed bundles (hotel "HO"/"N" + tours "TO"/"S" en el mismo contrato).
  // El backend modela ambos como shared + override per-row; la UI los trata
  // como row para que cada fila muestre su valor efectivo y el usuario
  // pueda editar los overrides. Igual que codigo_servicio.
  { excelCol: "P",  key: "tipo_unidad",       label: "Tipo Unidad",        scope: { kind: "row" },                       minWidth: 130, options: () => TIPO_UNIDAD_OPTIONS },
  { excelCol: "Q",  key: "tipo_servicio",     label: "Tipo Servicio",      scope: { kind: "row" },                       minWidth: 140, options: () => TIPOS_SERVICIO },
  { excelCol: "R",  key: "categoria",         label: "Categoría",          scope: { kind: "row" },                       minWidth: 140, options: ({ tipoServicio }) => tipoServicio ? (CATEGORIAS_BY_TIPO_SERVICIO[tipoServicio] ?? []) : [] },
  { excelCol: "S",  key: "ocupacion",         label: "Ocupación",          scope: { kind: "row" },                       minWidth: 100, placeholder: "DBL, SGL…" },
  { excelCol: "T",  key: "season_name",       label: "Season Name",        scope: { kind: "row" },                       minWidth: 120, placeholder: "ALTA, BAJA…" },
  { excelCol: "U",  key: "season_starts",     label: "Season Starts",      scope: { kind: "row" },                       minWidth: 140, inputType: "date" },
  { excelCol: "V",  key: "season_ends",       label: "Season Ends",        scope: { kind: "row" },                       minWidth: 140, inputType: "date" },
  { excelCol: "W",  key: "meals_included",    label: "Meals Included",     scope: { kind: "row" },                       minWidth: 140, placeholder: "BREAKFAST…" },
  { excelCol: "X",  key: "tipo_tarifa_neta",  label: "Tipo Tarifa Neta",   scope: { kind: "shared", source: "manual" },  minWidth: 140, options: () => TIPO_TARIFA_OPTIONS, placeholder: "1=Fija, 2=Porcentual" },
  { excelCol: "Y",  key: "precios_neto_iva",  label: "Precios Neto c/IVA", scope: { kind: "row" },                       minWidth: 110, placeholder: "295", currency: true },
  { excelCol: "Z",  key: "precio_rack_iva",   label: "Precio Rack c/IVA",  scope: { kind: "row" },                       minWidth: 110, placeholder: "295", currency: true },
  { excelCol: "AA", key: "tipo_tarifa_mayorista",     label: "Tipo Tarifa Mayorista",     scope: { kind: "shared", source: "manual" }, minWidth: 150, options: () => TIPO_TARIFA_OPTIONS, placeholder: "1=Fija, 2=Porcentual" },
  { excelCol: "AB", key: "porcentaje_comision",       label: "% Comisión",                scope: { kind: "row" },                      minWidth: 90,  placeholder: "0 / 25" },
  { excelCol: "AC", key: "tipo_tarifa_fds",           label: "Tipo Tarifa Fin Semana",    scope: { kind: "shared", source: "manual" }, minWidth: 150, options: () => TIPO_TARIFA_OPTIONS, placeholder: "1=Fija, 2=Porcentual" },
  { excelCol: "AD", key: "t_tar_neta_fds",            label: "T.Tar Neta Fin Semana",     scope: { kind: "shared", source: "manual" }, minWidth: 150, options: () => TIPO_TARIFA_OPTIONS, placeholder: "1=Fija, 2=Porcentual" },
  { excelCol: "AE", key: "precios_neto_iva_fds",      label: "Precios Neto FdS",          scope: { kind: "row" },                      minWidth: 110, placeholder: "295", currency: true },
  { excelCol: "AF", key: "precio_rack_iva_fds",       label: "Precio Rack FdS",           scope: { kind: "row" },                      minWidth: 110, placeholder: "295", currency: true },
  { excelCol: "AG", key: "tipo_tarifa_mayorista_fds", label: "Tipo Tarifa Mayor. FdS",    scope: { kind: "shared", source: "manual" }, minWidth: 150, options: () => TIPO_TARIFA_OPTIONS, placeholder: "1=Fija, 2=Porcentual" },
  { excelCol: "AH", key: "porcentaje_comision_fds",   label: "% Comisión FdS",            scope: { kind: "row" },                      minWidth: 100, placeholder: "0 / 25" },
  { excelCol: "AI", key: "cancellation_policy",       label: "Cancelation Policy",        scope: { kind: "row" },                      minWidth: 280, multiline: true },
  { excelCol: "AJ", key: "range_payment_policy",      label: "Range Payment Policy",      scope: { kind: "row" },                      minWidth: 220, multiline: true },
  { excelCol: "AK", key: "others_payment_cancel",     label: "Others in Payment / Cancel",scope: { kind: "shared", source: "ai" }, minWidth: 220, multiline: true, placeholder: "Periodos especiales (Navidad, etc.)" },
  { excelCol: "AL", key: "kids_policy",               label: "Kids Policy",               scope: { kind: "row" },                      minWidth: 220, multiline: true },
  { excelCol: "AM", key: "other_included",            label: "Other Included",            scope: { kind: "row" },                      minWidth: 200, multiline: true },
  { excelCol: "AN", key: "feeds_adicionales",         label: "Fees Adicionales",          scope: { kind: "row" },                      minWidth: 180, multiline: true },
  { excelCol: "AO", key: "reservations_email",        label: "Reservations Email",        scope: { kind: "shared", source: "ai" },     minWidth: 200, inputType: "email" },
  { excelCol: "AP", key: "cond_credito",              label: "Condiciones Crédito",       scope: { kind: "shared", source: "manual" }, minWidth: 150, options: () => COND_CREDITO_OPTIONS, placeholder: "1=Contado, 2=Crédito, 3=Prepago" },
  { excelCol: "AQ", key: "plazo",                     label: "Plazo",                     scope: { kind: "shared", source: "manual" }, minWidth: 120, placeholder: "30 días" },
  { excelCol: "AR", key: "numero_cuenta",             label: "Cuenta Bancaria 1",         scope: { kind: "shared", source: "ai" },     minWidth: 200, placeholder: "IBAN preferido" },
  { excelCol: "AS", key: "banco",                     label: "Banco 1",                   scope: { kind: "shared", source: "ai" },     minWidth: 150, placeholder: "Ej: BAC" },
  { excelCol: "AT", key: "tipo_moneda",               label: "Moneda 1",                  scope: { kind: "shared", source: "ai" },     minWidth: 100, placeholder: "USD" },
  { excelCol: "AU", key: "cuenta_bancaria_2",         label: "Cuenta Bancaria 2",         scope: { kind: "shared", source: "manual" }, minWidth: 200 },
  { excelCol: "AV", key: "banco_2",                   label: "Banco 2",                   scope: { kind: "shared", source: "manual" }, minWidth: 150 },
  { excelCol: "AW", key: "moneda_2",                  label: "Moneda 2",                  scope: { kind: "shared", source: "manual" }, minWidth: 100 },
  { excelCol: "AX", key: "cuenta_bancaria_3",         label: "Cuenta Bancaria 3",         scope: { kind: "shared", source: "manual" }, minWidth: 200 },
  { excelCol: "AY", key: "banco_3",                   label: "Banco 3",                   scope: { kind: "shared", source: "manual" }, minWidth: 150 },
  { excelCol: "AZ", key: "moneda_3",                  label: "Moneda 3",                  scope: { kind: "shared", source: "manual" }, minWidth: 100 },
  // Columna 53 — NOTAS (Bug #6 → BA). Cláusulas globales que no
  // encajaron en ninguna otra columna. Es shared (mismo valor en cada
  // fila) y multilínea — un punto y coma separa items.
  { excelCol: "BA", key: "notes",                     label: "Notas",                     scope: { kind: "shared", source: "ai" },     minWidth: 320, multiline: true, placeholder: "Cláusulas/notas que no encajaron en otras columnas" },
];

/** Keys del backend ExtractedSharedFields que tienen columna en el xlsx
 *  (telefono se extrae para validación pero NO tiene columna). */
// tipo_unidad / tipo_servicio NO viven en AI_SHARED_KEYS porque la UI los
// trata como row-scoped (ver comentario en ALL_COLUMNS arriba). El valor
// shared original del backend se preserva en `data.shared_fields` y se
// reenvía intacto en handleApprove para mantener el contrato de tipos
// ExtractedSharedFields del backend; los overrides editados viajan en
// `rows[i].tipo_unidad` / `tipo_servicio`.
const AI_SHARED_KEYS: ExtractedSharedFieldKey[] = [
  "fecha", "proveedor", "nombre_comercial", "cedula", "direccion",
  "pais", "state_province", "type_of_business",
  "contract_starts", "contract_ends", "reservations_email",
  "tipo_moneda", "numero_cuenta", "banco",
  "others_payment_cancel",
  "notes",
];

const CATALOG_KEYS = [
  "tipo_actividad", "zona_turismo", "proveedor_codigo",
] as const;
type CatalogKey = (typeof CATALOG_KEYS)[number];

const MANUAL_KEYS = [
  "tipo_tarifa_neta", "tipo_tarifa_mayorista", "tipo_tarifa_fds",
  "t_tar_neta_fds", "tipo_tarifa_mayorista_fds",
  "cond_credito", "plazo",
  "cuenta_bancaria_2", "banco_2", "moneda_2",
  "cuenta_bancaria_3", "banco_3", "moneda_3",
] as const;
type ManualKey = (typeof MANUAL_KEYS)[number];

type SharedKey = CatalogKey | ExtractedSharedFieldKey | ManualKey;

export const COLS_NEEDING_REVIEW = new Set<string>([
  "tipo_actividad",
  "zona_turismo",
  "proveedor_codigo",
  // codigo_servicio (Bug #2): cada fila trae su propio código derivado
  // por la IA del nombre del producto. El match no es perfecto — el
  // warning sign le recuerda al usuario que verifique cada fila.
  "codigo_servicio",
]);

/* ============================================================================
   STEP 2 — Review (flat 52-col table)
   ========================================================================== */

const CONFIANZA_STYLES: Record<
  ExtractionConfianza,
  { label: string; dot: string; bg: string; border: string; text: string }
> = {
  alta: {
    label: "Confianza alta",
    dot: "bg-emerald-400",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/30",
    text: "text-emerald-300",
  },
  media: {
    label: "Confianza media",
    dot: "bg-amber-400",
    bg: "bg-amber-500/10",
    border: "border-amber-500/30",
    text: "text-amber-300",
  },
  baja: {
    label: "Confianza baja",
    dot: "bg-rose-400",
    bg: "bg-rose-500/10",
    border: "border-rose-500/30",
    text: "text-rose-300",
  },
};

/**
 * Construye el estado inicial de los campos compartidos a partir de la
 * extracción IA + catalog prefill. Las claves manual arrancan en null
 * (el usuario las llena en la tabla).
 */
function buildInitialSharedValues(
  data: ExtractedContract,
  prefill: CatalogPrefill | null,
  bankPrefill?: ManualBankPrefill | null,
): Record<SharedKey, string | null> {
  const out: Record<string, string | null> = {};
  // 15 AI shared keys con columna shared en la UI. tipo_unidad y
  // tipo_servicio NO están acá — son row-scoped, se inicializan en el
  // estado `rows` (ver useState abajo).
  for (const k of AI_SHARED_KEYS) {
    out[k] = data.shared_fields[k];
  }
  // 3 catalog keys (codigo_servicio dejó de ser shared en Bug #2 — vive
  // por fila en `rows[i].codigo_servicio`).
  out.tipo_actividad = prefill?.tipo_actividad ?? null;
  out.zona_turismo = prefill?.zona_turismo ?? null;
  out.proveedor_codigo = prefill?.proveedor_codigo ?? null;
  // 14 manual keys → null por defecto.
  for (const k of MANUAL_KEYS) {
    out[k] = null;
  }
  // Pre-llenado de cuentas bancarias 2 y 3 desde el brief (Fase 1). El
  // usuario las puede editar/borrar en Step 2, pero ya no tiene que
  // tipearlas a mano cuando el contrato lista varias cuentas.
  if (bankPrefill) {
    out.cuenta_bancaria_2 = bankPrefill.cuenta_bancaria_2 ?? null;
    out.banco_2 = bankPrefill.banco_2 ?? null;
    out.moneda_2 = bankPrefill.moneda_2 ?? null;
    out.cuenta_bancaria_3 = bankPrefill.cuenta_bancaria_3 ?? null;
    out.banco_3 = bankPrefill.banco_3 ?? null;
    out.moneda_3 = bankPrefill.moneda_3 ?? null;
    // Condición de crédito (1/2/3) + plazo, extraídos de los términos de pago.
    out.cond_credito = bankPrefill.cond_credito ?? null;
    out.plazo = bankPrefill.plazo ?? null;
  }
  return out as Record<SharedKey, string | null>;
}

function ReviewStep({
  result,
  catalogPrefill,
  onApprove,
  onGridReady,
}: {
  result: ExtractContractResponse;
  catalogPrefill: CatalogPrefill | null;
  onApprove: (payload: ApprovedPayload) => void;
  onGridReady?: () => void;
}) {
  const { data, validation, meta } = result;
  const conf = CONFIANZA_STYLES[data.confianza];

  useEffect(() => {
    if (!onGridReady) return;
    let active = true;
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (active) onGridReady();
      });
    });
    return () => {
      active = false;
      cancelAnimationFrame(raf);
    };
  }, [onGridReady]);

  // Shared state (34 keys)
  const [sharedValues, setSharedValues] = useState<
    Record<SharedKey, string | null>
  >(() => buildInitialSharedValues(data, catalogPrefill, meta.manual_prefill));
  const setSharedField = (key: SharedKey, value: string | null) => {
    setSharedValues((prev) => ({ ...prev, [key]: value }));
  };

  // Per-row state (one ContractRow per combinación). tipo_unidad y
  // tipo_servicio se hidratan con el shared default cuando la fila llegó
  // con null — así cada celda muestra su valor efectivo. El override
  // se preserva si la IA lo envió diferente al shared (mixed bundles).
  const [rows, setRows] = useState<ExtractedContractRow[]>(() =>
    data.rows.map((r) => ({
      ...r,
      tipo_unidad: r.tipo_unidad ?? data.shared_fields.tipo_unidad,
      tipo_servicio: r.tipo_servicio ?? data.shared_fields.tipo_servicio,
    })),
  );
  const setRowField = (
    rowIdx: number,
    key: ExtractedRowFieldKey,
    value: string | null,
  ) => {
    setRows((prev) =>
      prev.map((r, i) => (i === rowIdx ? { ...r, [key]: value } : r)),
    );
  };

  const addRow = () => {
    setRows((prev) => {
      const last = prev[prev.length - 1];
      const blank: ExtractedContractRow = {
        product_name: last?.product_name ?? null,
        categoria: last?.categoria ?? null,
        tipo_servicio: last?.tipo_servicio ?? null,
        tipo_unidad: last?.tipo_unidad ?? null,
        codigo_servicio: last?.codigo_servicio ?? null,
        ocupacion: last?.ocupacion ?? null,
        season_name: null,
        season_starts: null,
        season_ends: null,
        meals_included: last?.meals_included ?? null,
        precios_neto_iva: null,
        precio_rack_iva: null,
        porcentaje_comision: last?.porcentaje_comision ?? null,
        precios_neto_iva_fds: null,
        precio_rack_iva_fds: null,
        porcentaje_comision_fds: last?.porcentaje_comision_fds ?? null,
        cancellation_policy: last?.cancellation_policy ?? null,
        range_payment_policy: last?.range_payment_policy ?? null,
        kids_policy: last?.kids_policy ?? null,
        other_included: last?.other_included ?? null,
        feeds_adicionales: last?.feeds_adicionales ?? null,
      };
      return [...prev, blank];
    });
  };

  const removeRow = (rowIdx: number) => {
    setRows((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((_, i) => i !== rowIdx);
    });
  };

  const handleApprove = () => {
    // AI shared fields (incluye telefono que extraemos pero no editamos)
    const sharedFields: ExtractedSharedFields = {
      fecha: sharedValues.fecha,
      proveedor: sharedValues.proveedor,
      nombre_comercial: sharedValues.nombre_comercial,
      cedula: sharedValues.cedula,
      direccion: sharedValues.direccion,
      telefono: data.shared_fields.telefono, // not in table, passed through
      pais: sharedValues.pais,
      state_province: sharedValues.state_province,
      type_of_business: sharedValues.type_of_business,
      contract_starts: sharedValues.contract_starts,
      contract_ends: sharedValues.contract_ends,
      reservations_email: sharedValues.reservations_email,
      // tipo_unidad y tipo_servicio ya no son editables como shared (cada
      // fila tiene el suyo en row scope). Preservamos el valor original
      // del backend en `shared_fields` por compat de tipos — el writer del
      // xlsx (`resolveRowClassification`) usa el row value como fuente
      // primaria y este shared como fallback.
      tipo_unidad: data.shared_fields.tipo_unidad,
      tipo_servicio: data.shared_fields.tipo_servicio,
      tipo_moneda: sharedValues.tipo_moneda,
      numero_cuenta: sharedValues.numero_cuenta,
      banco: sharedValues.banco,
      others_payment_cancel: sharedValues.others_payment_cancel,
      notes: sharedValues.notes,
    };

    // Catalog prefill — null si todos los 4 son null/empty
    const hasAnyCatalog = CATALOG_KEYS.some((k) => {
      const v = sharedValues[k];
      return typeof v === "string" && v.trim() !== "";
    });
    // codigo_servicio ya no es editable como shared (es per-row); igual lo
    // mandamos al backend como hint del catálogo para que el writer lo use
    // como FALLBACK cuando alguna fila venga sin código (ver
    // `resolveRowClassification` en xlsxGenerator).
    const finalCatalogPrefill: GenerateXlsxCatalogPrefill | null =
      hasAnyCatalog || catalogPrefill?.codigo_servicio
        ? {
            tipo_actividad: sharedValues.tipo_actividad,
            zona_turismo: sharedValues.zona_turismo,
            proveedor_codigo: sharedValues.proveedor_codigo,
            codigo_servicio: catalogPrefill?.codigo_servicio ?? null,
          }
        : null;

    // Manual fields — null si todos los 14 son null/empty
    const hasAnyManual = MANUAL_KEYS.some((k) => {
      const v = sharedValues[k];
      return typeof v === "string" && v.trim() !== "";
    });
    const finalManualFields: GenerateXlsxManualFields | null = hasAnyManual
      ? {
          tipo_tarifa_neta: sharedValues.tipo_tarifa_neta,
          tipo_tarifa_mayorista: sharedValues.tipo_tarifa_mayorista,
          tipo_tarifa_fds: sharedValues.tipo_tarifa_fds,
          t_tar_neta_fds: sharedValues.t_tar_neta_fds,
          tipo_tarifa_mayorista_fds: sharedValues.tipo_tarifa_mayorista_fds,
          cond_credito: sharedValues.cond_credito,
          plazo: sharedValues.plazo,
          cuenta_bancaria_2: sharedValues.cuenta_bancaria_2,
          banco_2: sharedValues.banco_2,
          moneda_2: sharedValues.moneda_2,
          cuenta_bancaria_3: sharedValues.cuenta_bancaria_3,
          banco_3: sharedValues.banco_3,
          moneda_3: sharedValues.moneda_3,
        }
      : null;

    onApprove({
      sharedFields,
      rows,
      catalogPrefill: finalCatalogPrefill,
      manualFields: finalManualFields,
    });
  };

  const filledRowCells = useMemo(() => {
    let count = 0;
    const rowCols = ALL_COLUMNS.filter((c) => c.scope.kind === "row");
    for (const r of rows) {
      for (const c of rowCols) {
        const v = r[c.key as ExtractedRowFieldKey];
        if (typeof v === "string" && v.trim() !== "") count++;
      }
    }
    return count;
  }, [rows]);

  const rowCount = rows.length;
  const totalRowCells = rowCount * ALL_COLUMNS.filter((c) => c.scope.kind === "row").length;
  const completionPct =
    totalRowCells === 0 ? 0 : Math.round((filledRowCells / totalRowCells) * 100);

  return (
    <div className="px-5 sm:px-8 py-7 space-y-5">
      {/* Summary banner */}
      <div className="rounded-xl border border-primary/30 bg-gradient-to-br from-primary/12 via-primary/6 to-transparent px-4 py-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center shrink-0">
            <CheckCircle2 className="w-5 h-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center flex-wrap gap-2">
              <p className="text-[14.5px] font-semibold text-foreground">
                Análisis completado
              </p>
              <span
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10.5px] font-semibold uppercase tracking-wider ${conf.bg} ${conf.border} ${conf.text}`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${conf.dot}`} />
                {conf.label}
              </span>
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-[10.5px] font-semibold uppercase tracking-wider text-emerald-300">
                <CheckCircle2 className="w-3 h-3" />
                {rowCount} {rowCount === 1 ? "fila" : "filas"}
              </span>
            </div>
            <p className="text-[12.5px] text-muted-foreground mt-1 truncate">
              {meta.filename} · {humanSize(meta.size_bytes)} · modelo {meta.model}
            </p>
          </div>
        </div>

        <div className="mt-3 space-y-1">
          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-secondary/70 border border-border/50">
            <div
              className="h-full rounded-full bg-gradient-to-r from-primary to-emerald-400 shadow-[0_0_10px_0_hsl(var(--primary)/0.4)] transition-[width] duration-300 ease-out"
              style={{ width: `${completionPct}%` }}
            />
          </div>
          <p className="text-[10.5px] text-muted-foreground tabular-nums">
            {completionPct}% celdas variables con valor — {rowCount} ×{" "}
            {ALL_COLUMNS.filter((c) => c.scope.kind === "row").length} ={" "}
            {totalRowCells} celdas
          </p>
        </div>
      </div>

      {validation.warnings.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[12.5px] text-amber-200">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold text-amber-100 mb-0.5">
              {validation.warnings.length === 1
                ? "1 advertencia"
                : `${validation.warnings.length} advertencias`}
            </p>
            <ul className="space-y-1">
              {validation.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <FullTable
        rows={rows}
        sharedValues={sharedValues}
        paginasOrigenShared={data.paginas_origen_shared}
        paginasOrigenRows={data.paginas_origen_rows}
        camposFaltantes={data.campos_faltantes}
        filename={meta.filename}
        onSharedChange={setSharedField}
        onRowChange={setRowField}
        onAddRow={addRow}
        onRemoveRow={removeRow}
      />

      <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={handleApprove}
          className="btn-premium inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-[13.5px]"
        >
          <Download className="w-4 h-4" />
          Generar y descargar xlsx
        </button>
      </div>
    </div>
  );
}

/* ============================================================================
   Full 52-col table
   ========================================================================== */

function FullTable({
  rows,
  sharedValues,
  paginasOrigenShared,
  paginasOrigenRows,
  camposFaltantes,
  filename,
  onSharedChange,
  onRowChange,
  onAddRow,
  onRemoveRow,
}: {
  rows: ExtractedContractRow[];
  sharedValues: Record<SharedKey, string | null>;
  paginasOrigenShared: Record<string, ExtractionSourcePage>;
  paginasOrigenRows: Record<string, ExtractionSourcePage>[];
  camposFaltantes: string[];
  filename: string;
  onSharedChange: (key: SharedKey, value: string | null) => void;
  onRowChange: (
    rowIdx: number,
    key: ExtractedRowFieldKey,
    value: string | null,
  ) => void;
  onAddRow: () => void;
  onRemoveRow: (rowIdx: number) => void;
}) {
  return (
    <section className="rounded-xl border border-border bg-card/60 overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b border-border/60 gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center shrink-0">
            <FileSpreadsheet className="w-4 h-4 text-emerald-300" />
          </div>
          <div className="min-w-0">
            <p className="text-[14px] font-semibold text-foreground">
              Datos del xlsx · {rows.length} {rows.length === 1 ? "fila" : "filas"}{" "}
              · 52 columnas
            </p>
            <p className="text-[11.5px] text-muted-foreground">
              Clic en una celda para editarla. Las columnas con fondo sutil son{" "}
              <em className="italic">compartidas</em>: editar una propaga a todas
              las filas.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onAddRow}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-primary/40 bg-primary/10 text-primary text-[12.5px] font-semibold hover:bg-primary/15 transition-colors shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          Agregar fila
        </button>
      </header>

      {/*
        Caja de scroll de la tabla.

        Antes era `overflow-x-auto` sin alto: la barra horizontal vivía al
        fondo de la tabla entera, así que con muchas filas había que
        scrollear la página hasta abajo de todo para encontrarla. UX
        terrible (especialmente en contratos con >20 filas).

        Ahora `overflow-auto` + `max-h` acota la caja a ~viewport menos
        margen para nav + header + warnings + botón "Generar". El thead
        (`sticky top-0`) y la columna `#` (`sticky left-0`) ya estaban
        listos para esto — ahora "sticky" se ancla al borde de ESTA caja,
        no del viewport, así que el header se queda visible cuando se
        scrollea vertical adentro de la tabla y las dos scrollbars
        (vertical + horizontal) están siempre a mano.

        Usamos `dvh` (dynamic viewport) cuando esté disponible — en
        Safari móvil 100vh incluye la URL bar y la caja se cortaría.
        Fallback a `vh` para navegadores viejos.
      */}
      <div className="overflow-auto max-h-[calc(100vh-14rem)] supports-[height:100dvh]:max-h-[calc(100dvh-14rem)]">
        <table className="w-full border-collapse text-[12px]">
          <thead className="bg-secondary/40 border-b border-border/60 sticky top-0 z-10">
            <tr>
              <th
                scope="col"
                rowSpan={2}
                className="sticky left-0 z-20 bg-secondary/80 backdrop-blur px-2 py-1 text-left text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/90 border-r border-border/60 align-middle"
                style={{ minWidth: 44 }}
              >
                #
              </th>
              {ALL_COLUMNS.map((col) => {
                const isShared = col.scope.kind === "shared";
                const needsReview = COLS_NEEDING_REVIEW.has(col.key);
                return (
                  <th
                    key={col.excelCol}
                    scope="col"
                    className={`px-1.5 py-1 text-left border-r border-border/40 whitespace-nowrap align-bottom ${
                      isShared ? "bg-secondary/50" : ""
                    }`}
                    style={{ minWidth: col.minWidth }}
                  >
                    <div className="flex items-center gap-1">
                      <span
                        className="inline-flex items-center justify-center min-w-[26px] h-4 px-1 rounded border border-border/70 bg-card text-[10px] font-mono font-bold text-foreground/80 tabular-nums shrink-0"
                        title={`Columna ${col.excelCol}`}
                      >
                        {col.excelCol}
                      </span>
                      {needsReview && (
                        <span
                          title="Revisar — viene del catálogo lista-proveedores y el match es fuzzy."
                          className="text-amber-300 shrink-0"
                        >
                          <AlertTriangle className="w-3 h-3" />
                        </span>
                      )}
                    </div>
                  </th>
                );
              })}
              <th
                scope="col"
                rowSpan={2}
                className="px-1.5 py-1 text-right align-middle"
                style={{ minWidth: 40 }}
              >
                <span className="sr-only">Acciones</span>
              </th>
            </tr>
            <tr>
              {ALL_COLUMNS.map((col) => {
                const isShared = col.scope.kind === "shared";
                return (
                  <th
                    key={col.excelCol + "_label"}
                    scope="col"
                    className={`px-1.5 pb-1.5 text-left border-r border-border/40 whitespace-nowrap font-semibold align-top ${
                      isShared ? "bg-secondary/50" : ""
                    }`}
                  >
                    <span className="text-[10.5px] uppercase tracking-wider text-foreground/90">
                      {col.label}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr
                key={rowIdx}
                className="border-b border-border/30 last:border-b-0 hover:bg-secondary/10 transition-colors"
              >
                <td
                  className="sticky left-0 z-10 bg-card/95 backdrop-blur px-2 py-1 text-[11px] font-mono tabular-nums text-muted-foreground border-r border-border/40 align-top"
                  style={{ minWidth: 44 }}
                >
                  {rowIdx + 1}
                </td>
                {ALL_COLUMNS.map((col) => {
                  const isShared = col.scope.kind === "shared";
                  const value = isShared
                    ? sharedValues[col.key as SharedKey]
                    : row[col.key as ExtractedRowFieldKey];
                  // Source page
                  let source: ExtractionSourcePage | undefined;
                  if (isShared) {
                    source = paginasOrigenShared[col.key];
                  } else {
                    source = paginasOrigenRows[rowIdx]?.[col.key];
                  }
                  // Mark missing if backend listed this AI shared field as faltante
                  const isMarkedMissing =
                    isShared &&
                    col.scope.kind === "shared" &&
                    col.scope.source === "ai" &&
                    camposFaltantes.includes(col.key);

                  // Categoria (R) depende del tipo_servicio efectivo de
                  // ESTA fila (mixed bundles: hotel "HO" + tours "TO" en
                  // el mismo contrato necesitan listas de categorías
                  // distintas por fila).
                  const opts = col.options
                    ? col.options({ tipoServicio: row.tipo_servicio })
                    : undefined;
                  return (
                    <td
                      key={col.excelCol}
                      className={`p-0 align-top border-r border-border/30 ${
                        isShared ? "bg-secondary/15" : ""
                      }`}
                      style={{ minWidth: col.minWidth }}
                    >
                      <CellEditor
                        col={col}
                        value={value}
                        options={opts}
                        source={source}
                        filename={filename}
                        isMarkedMissing={isMarkedMissing}
                        tipoMoneda={sharedValues.tipo_moneda}
                        onSave={(v) => {
                          if (isShared) {
                            onSharedChange(col.key as SharedKey, v);
                          } else {
                            onRowChange(
                              rowIdx,
                              col.key as ExtractedRowFieldKey,
                              v,
                            );
                          }
                        }}
                      />
                    </td>
                  );
                })}
                <td className="px-1 py-1 text-right align-top">
                  <button
                    type="button"
                    onClick={() => onRemoveRow(rowIdx)}
                    disabled={rows.length <= 1}
                    aria-label={`Eliminar fila ${rowIdx + 1}`}
                    title={
                      rows.length <= 1
                        ? "Debe haber al menos 1 fila"
                        : "Eliminar fila"
                    }
                    className="inline-flex items-center justify-center h-7 w-7 rounded border border-transparent text-muted-foreground hover:text-destructive hover:border-destructive/40 hover:bg-destructive/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Editor de celda. Click → modo edit (input/textarea/select). Enter / blur
 * commit. Escape cancel. Source-page se muestra como tooltip al hover.
 */
function CellEditor({
  col,
  value,
  options,
  source,
  filename,
  isMarkedMissing,
  tipoMoneda,
  onSave,
}: {
  col: ColumnDef;
  value: string | null;
  options: ReadonlyArray<SelectOption> | undefined;
  source: ExtractionSourcePage | undefined;
  filename: string;
  isMarkedMissing: boolean;
  /**
   * Código de moneda del contrato (`sharedFields.tipo_moneda`). Solo lo
   * usamos cuando `col.currency` está activo — vive a nivel de contrato,
   * no de fila, así que se prefija a *todas* las columnas monetarias.
   */
  tipoMoneda: string | null;
  onSave: (v: string | null) => void;
}) {
  const isSelect = !!options;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const startEdit = () => {
    setDraft(value ?? "");
    setEditing(true);
  };
  const commit = () => {
    const trimmed = draft.trim();
    onSave(trimmed === "" ? null : trimmed);
    setEditing(false);
    setDraft("");
  };
  const cancel = () => {
    setEditing(false);
    setDraft("");
  };
  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    if (e.key === "Enter" && !e.shiftKey && !col.multiline) {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  const tooltip = useMemo(() => {
    if (source === undefined) return undefined;
    const base =
      typeof source === "number"
        ? `Página ${source}`
        : source === "inferido"
          ? "Inferido"
          : source === "multiple"
            ? "Múltiples páginas"
            : `Página ${source}`;
    return `${base} · ${filename}`;
  }, [source, filename]);

  if (isSelect) {
    const valueInOpts =
      value !== null && options!.some((o) => o.codigo === value);
    return (
      <select
        value={value ?? ""}
        onChange={(e) => onSave(e.target.value === "" ? null : e.target.value)}
        title={tooltip}
        aria-label={col.label}
        className="w-full h-7 rounded border border-transparent bg-transparent px-1 text-[12px] text-foreground outline-none hover:border-border focus:border-primary/60 focus:bg-secondary/40 cursor-pointer"
      >
        <option value="">—</option>
        {options!.map((opt) => (
          <option key={opt.codigo} value={opt.codigo}>
            {opt.codigo} · {opt.descripcion}
          </option>
        ))}
        {value && !valueInOpts && (
          <option value={value} className="italic">
            {value} (fuera de catálogo)
          </option>
        )}
      </select>
    );
  }

  if (editing) {
    return col.multiline ? (
      <textarea
        ref={inputRef as React.RefObject<HTMLTextAreaElement>}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={commit}
        placeholder={col.placeholder}
        rows={3}
        className="w-full resize-y rounded border border-primary/60 bg-secondary/40 px-1.5 py-1 text-[12px] leading-relaxed text-foreground outline-none focus:border-primary"
      />
    ) : (
      <input
        ref={inputRef as React.RefObject<HTMLInputElement>}
        type={col.inputType ?? "text"}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={commit}
        placeholder={col.placeholder}
        className="w-full h-7 rounded border border-primary/60 bg-secondary/40 px-1.5 text-[12px] text-foreground outline-none focus:border-primary"
      />
    );
  }

  const missing = value === null || value === "";
  // Aplicamos formato solo cuando hay valor: las fechas se muestran en
  // YYYY-MM-DD (mismo formato que el storage) y las columnas con
  // `currency` muestran el código de moneda del contrato (ej. "USD 295",
  // "CRC 150000"). El aria-label usa el valor formateado para que un
  // lector de pantalla dicte la misma cifra que ve el usuario.
  const displayValue = missing ? "" : formatCellDisplay(col, value, tipoMoneda);
  return (
    <button
      type="button"
      onClick={startEdit}
      title={tooltip}
      aria-label={`${col.label} — ${missing ? "vacío" : displayValue}. Clic para editar.`}
      className={`w-full min-h-[1.75rem] text-left rounded border border-transparent px-1.5 py-1 text-[12px] leading-snug transition-colors hover:border-border hover:bg-secondary/30 focus:outline-none focus:border-primary/60 focus:bg-secondary/40 ${
        missing
          ? "text-muted-foreground/50 italic"
          : "text-foreground"
      } ${col.multiline ? "whitespace-pre-wrap break-words" : "truncate"}`}
    >
      {missing
        ? isMarkedMissing
          ? "no encontrado"
          : "—"
        : displayValue}
    </button>
  );
}

/* ============================================================================
   STEP 3 — Generate + Download
   ========================================================================== */

function DownloadStep({
  payload,
  meta,
  onReset,
}: {
  payload: ApprovedPayload;
  meta: ExtractContractResponse["meta"];
  onReset: () => void;
}) {
  const [phase, setPhase] = useState<"generating" | "ready" | "error">(
    "generating",
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  /**
   * Blob descargado. Lo mantenemos en state como `objectURL` para que el
   * botón <a download> pueda apuntar a él. El URL se revoca cuando el
   * componente se desmonta (procesar otro contrato) — ver el cleanup del
   * useEffect de abajo.
   */
  const [ready, setReady] = useState<{
    objectUrl: string;
    filename: string;
    sizeBytes: number;
  } | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    // `startedRef` ya garantiza una sola llamada al backend incluso bajo
    // StrictMode (que monta-desmonta-monta el componente). No usamos un flag
    // `cancelled` capturado en el closure porque, al combinarse con el
    // early-return de `startedRef`, dejaba la promesa original cancelada
    // permanentemente: el cleanup del primer mount ponía `cancelled = true`
    // y el segundo mount no relanzaba la fetch — resultado: phase se quedaba
    // en "generating" para siempre y el botón de descarga no aparecía.
    if (startedRef.current) return;
    startedRef.current = true;

    (async () => {
      try {
        const { blob, filename } = await api.supplierIntelligence.generateXlsx({
          shared_fields: payload.sharedFields,
          rows: payload.rows,
          catalog_prefill: payload.catalogPrefill,
          manual_fields: payload.manualFields,
        });

        const objectUrl = URL.createObjectURL(blob);

        // Best-effort: intentamos disparar la descarga automáticamente. Si el
        // navegador la bloquea (algunos lo hacen cuando la descarga ocurre
        // después de un fetch sin "user gesture" inmediato), no pasa nada —
        // el usuario tiene el botón "Descargar xlsx" abajo como fallback.
        try {
          const a = document.createElement("a");
          a.href = objectUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
        } catch {
          // Silent — el botón manual sigue funcionando.
        }

        setReady({ objectUrl, filename, sizeBytes: blob.size });
        setPhase("ready");

        // Fire-and-forget: persistimos el run para Historial + métricas.
        // Un fallo aquí NO debe bloquear al usuario — ya tiene el xlsx
        // descargado. Si el guardado falla, se pierde solo la entrada
        // de Historial (el usuario puede re-procesar el contrato).
        const fileKind = inferKind("", meta.filename);
        if (fileKind) {
          void api.supplierIntelligence
            .saveRun({
              filename: meta.filename,
              file_kind: fileKind,
              file_size: meta.size_bytes,
              ai_model: meta.model,
              shared_fields: payload.sharedFields,
              rows: payload.rows,
              catalog_prefill: payload.catalogPrefill,
              manual_fields: payload.manualFields,
              // Telemetría real del extract — se persiste con el run.
              // Si el backend es viejo y no las trajo en meta, el
              // saveRun las omite y se guarda como null en BD.
              input_tokens: meta.input_tokens,
              output_tokens: meta.output_tokens,
              cost_usd: meta.cost_usd,
            })
            .catch((err) => {
              // Logueamos a console para que sea visible en dev / Sentry,
              // pero no afectamos la UX. Tracking real cuando exista.
              console.warn("saveRun failed (non-blocking):", err);
            });
        }
      } catch (err) {
        if (err instanceof ApiError) {
          setErrorMsg(err.message);
        } else {
          setErrorMsg(
            "No pudimos generar el xlsx. Revisa tu conexión e intenta de nuevo.",
          );
        }
        setPhase("error");
      }
    })();
  }, [payload, meta]);

  // Revoca el blob URL al desmontar el componente (ej. cuando el usuario
  // hace clic en "Procesar otro contrato"). Hasta entonces lo mantenemos
  // vivo para que el botón <a download> siga funcionando si el usuario
  // hace clic varias veces.
  useEffect(() => {
    const url = ready?.objectUrl;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [ready?.objectUrl]);

  if (phase === "generating") {
    return <DownloadInProgressCard rowCount={payload.rows.length} meta={meta} />;
  }
  if (phase === "error") {
    return (
      <DownloadErrorCard
        message={errorMsg ?? "Error desconocido."}
        onReset={onReset}
      />
    );
  }
  return (
    <DownloadReadyCard
      objectUrl={ready?.objectUrl ?? ""}
      filename={ready?.filename ?? "contrato.xlsx"}
      sizeBytes={ready?.sizeBytes ?? 0}
      rowCount={payload.rows.length}
      meta={meta}
      onReset={onReset}
    />
  );
}

function DownloadInProgressCard({
  rowCount,
  meta,
}: {
  rowCount: number;
  meta: ExtractContractResponse["meta"];
}) {
  return (
    <div className="px-5 sm:px-8 py-10 space-y-6">
      <div className="mx-auto max-w-md text-center">
        <div className="relative mx-auto w-20 h-20 rounded-2xl bg-primary/10 border border-primary/30 flex items-center justify-center animate-pulse-glow">
          <Cloud className="w-9 h-9 text-primary" />
          <div className="absolute -bottom-1 -right-1 w-7 h-7 rounded-lg bg-card border border-primary/40 flex items-center justify-center shadow-[0_0_12px_0_hsl(var(--primary)/0.4)]">
            <FileSpreadsheet className="w-4 h-4 text-emerald-300" />
          </div>
        </div>
        <h3 className="mt-5 text-[18px] font-semibold text-foreground">
          Generando xlsx
        </h3>
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          Estamos escribiendo {rowCount} {rowCount === 1 ? "fila" : "filas"}{" "}
          en la plantilla.
        </p>
      </div>

      <div className="mx-auto max-w-xl rounded-xl border border-primary/30 bg-primary/5 px-4 py-4 space-y-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-secondary/70 border border-border flex items-center justify-center shrink-0">
            <FileSpreadsheet className="w-4 h-4 text-emerald-300" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold text-foreground truncate">
              Origen: {meta.filename}
            </p>
            <p className="text-[11.5px] text-muted-foreground truncate">
              {rowCount} {rowCount === 1 ? "combinación" : "combinaciones"} product
              × season
            </p>
          </div>
          <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />
        </div>
        <p className="text-[11px] text-muted-foreground">
          Si tarda más de 10s, verifica que el backend esté corriendo y reinicia{" "}
          <code className="px-1 rounded bg-secondary/60 text-foreground/80">
            npm run dev
          </code>{" "}
          si recién agregaste rutas nuevas.
        </p>
      </div>
    </div>
  );
}

/**
 * Pantalla "xlsx listo para descargar". El CTA principal es un `<a download>`
 * que apunta al blob URL — esto es lo más confiable: el navegador ve la
 * acción como una descarga iniciada por gesto explícito del usuario.
 *
 * Por debajo intentamos disparar la descarga automáticamente cuando llegó la
 * respuesta (ver DownloadStep), pero ese auto-click puede ser bloqueado por
 * el navegador. Este botón siempre funciona.
 */
function DownloadReadyCard({
  objectUrl,
  filename,
  sizeBytes,
  rowCount,
  meta,
  onReset,
}: {
  objectUrl: string;
  filename: string;
  sizeBytes: number;
  rowCount: number;
  meta: ExtractContractResponse["meta"];
  onReset: () => void;
}) {
  return (
    <div className="px-5 sm:px-8 py-10 space-y-7">
      <div className="mx-auto max-w-md text-center">
        <div className="relative mx-auto w-20 h-20 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
          <CheckCircle2 className="w-10 h-10 text-emerald-300" />
          <div
            aria-hidden
            className="absolute inset-0 rounded-2xl ring-2 ring-emerald-400/30 animate-ping pointer-events-none"
          />
        </div>
        <h3 className="mt-5 text-[18px] font-semibold text-foreground">
          xlsx listo para descargar
        </h3>
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          Hacé clic en <strong className="text-foreground">Descargar xlsx</strong> abajo
          para guardar el archivo en tu equipo.
        </p>
      </div>

      <div className="mx-auto max-w-xl rounded-xl border border-emerald-500/30 bg-emerald-500/5 divide-y divide-border/50">
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="w-9 h-9 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center shrink-0">
            <FileSpreadsheet className="w-4 h-4 text-emerald-300" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold text-foreground truncate">
              {filename}
            </p>
            <p className="text-[11.5px] text-muted-foreground truncate">
              {humanSize(sizeBytes)} · {rowCount}{" "}
              {rowCount === 1 ? "fila" : "filas"} · listo
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="w-9 h-9 rounded-lg bg-secondary/70 border border-border flex items-center justify-center shrink-0">
            <CloudUpload className="w-4 h-4 text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[12.5px] text-foreground truncate">
              Origen: {meta.filename}
            </p>
            <p className="text-[11px] text-muted-foreground truncate">
              {humanSize(meta.size_bytes)} · modelo {meta.model}
            </p>
          </div>
        </div>
      </div>

      {/* CTA principal: <a download> apuntando al blob. Más confiable que
          a.click() programático, porque cuenta como user-gesture explícito. */}
      <div className="mx-auto max-w-xl flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2">
        <button
          type="button"
          onClick={onReset}
          className="inline-flex items-center justify-center gap-2 h-11 px-4 rounded-lg border border-border bg-secondary/40 text-[13.5px] text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
        >
          <RotateCcw className="w-4 h-4" />
          Procesar otro contrato
        </button>
        <a
          href={objectUrl}
          download={filename}
          className="btn-premium inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-[13.5px]"
        >
          <Download className="w-4 h-4" />
          Descargar xlsx
        </a>
      </div>
    </div>
  );
}

function DownloadErrorCard({
  message,
  onReset,
}: {
  message: string;
  onReset: () => void;
}) {
  return (
    <div className="px-5 sm:px-8 py-10 space-y-6">
      <div className="mx-auto max-w-md text-center">
        <div className="mx-auto w-20 h-20 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center">
          <AlertTriangle className="w-10 h-10 text-rose-300" />
        </div>
        <h3 className="mt-5 text-[18px] font-semibold text-foreground">
          No pudimos generar el xlsx
        </h3>
        <p className="mt-1.5 text-[13px] text-muted-foreground break-words">
          {message}
        </p>
      </div>
      <div className="mx-auto max-w-xl flex justify-center">
        <button
          type="button"
          onClick={onReset}
          className="btn-premium inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-[13.5px]"
        >
          <RotateCcw className="w-4 h-4" />
          Volver al inicio
        </button>
      </div>
    </div>
  );
}
