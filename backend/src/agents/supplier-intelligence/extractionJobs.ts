import { randomUUID } from "node:crypto";

/**
 * Estado de un job de extracción.
 *   - processing: el pase Opus sigue corriendo en segundo plano.
 *   - done: terminó OK; `result` tiene la envolvente { success, data, ... }.
 *   - error: falló; `error` tiene status/code/message para el cliente.
 */
export type ExtractionJobState = "processing" | "done" | "error";

export interface ExtractionJobError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

export interface ExtractionJob {
  id: string;
  state: ExtractionJobState;
  createdAt: number;
  updatedAt: number;
  /** Envolvente de éxito ({ success, data, validation, meta }) cuando state==="done". */
  result?: unknown;
  /** Info de error cuando state==="error". */
  error?: ExtractionJobError;
}

/**
 * Store en memoria de jobs de extracción.
 *
 * POR QUÉ: la extracción Opus tarda varios minutos y mantener UNA sola
 * conexión HTTP abierta tanto tiempo se cae en los proxies intermedios
 * (edge de Railway, Next.js, etc.), devolviendo errores engañosos (CORS /
 * 5xx) aunque el backend termine bien. Partimos el trabajo: `POST /extract`
 * arranca el job y devuelve un id al instante; el frontend encuesta
 * `GET /extract/:id` con peticiones cortas hasta que termina.
 *
 * SUPUESTO: el backend corre en UNA sola instancia (caso actual en Railway).
 * Si algún día se escala horizontalmente, este store debe migrar a algo
 * compartido (Redis/DB) o el polling puede caer en una réplica sin el job.
 */
const jobs = new Map<string, ExtractionJob>();

/** TTL tras la última actualización; barremos jobs viejos para no fugar memoria. */
const JOB_TTL_MS = 30 * 60 * 1000;

function sweep(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.updatedAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}

export function createExtractionJob(): ExtractionJob {
  sweep();
  const now = Date.now();
  const job: ExtractionJob = {
    id: randomUUID(),
    state: "processing",
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.id, job);
  return job;
}

export function getExtractionJob(id: string): ExtractionJob | undefined {
  return jobs.get(id);
}

export function completeExtractionJob(id: string, result: unknown): void {
  const job = jobs.get(id);
  if (!job) return;
  job.state = "done";
  job.result = result;
  job.updatedAt = Date.now();
}

export function failExtractionJob(id: string, error: ExtractionJobError): void {
  const job = jobs.get(id);
  if (!job) return;
  job.state = "error";
  job.error = error;
  job.updatedAt = Date.now();
}
