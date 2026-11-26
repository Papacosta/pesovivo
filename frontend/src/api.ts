/** Cliente HTTP da API. Base vazia = mesma origem (nginx/proxy). */
import type {
  Animal,
  CapturePoint,
  DashboardStats,
  Estimate,
  ModelStatus,
  ModelVersion,
  Passage,
  PassageFeedback,
  PassageMode,
  PassageQueuedFrame,
  Weighing,
} from "./types";

export const API_BASE: string = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * fetch com tratamento de sessão: se o servidor responder 401 (login
 * expirado ou nunca feito), leva para a tela de login. Os dados da fila
 * offline continuam no celular e são enviados depois de entrar.
 */
async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, { credentials: "same-origin", ...init });
  if (res.status === 401 && !API_BASE && !url.includes("/api/auth/")) {
    window.location.replace("/login.html");
  }
  return res;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = `Erro ${res.status}`;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* corpo não-JSON */
    }
    throw new ApiError(detail, res.status);
  }
  return (await res.json()) as T;
}

export function apiError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export const api = {
  logout: () => apiFetch(`${API_BASE}/api/auth/logout`, { method: "POST" }),
  health: () => request<{ status: string }>("/api/health"),

  // Pontos de captura -----------------------------------------------------
  listCapturePoints: () => request<CapturePoint[]>("/api/capture-points"),
  createCapturePoint: (payload: Partial<CapturePoint> & { name: string; distance_cm: number; camera_height_cm: number }) =>
    request<CapturePoint>("/api/capture-points", { method: "POST", body: JSON.stringify(payload) }),

  // Animais ---------------------------------------------------------------
  listAnimals: (q = "") => request<Animal[]>(`/api/animals${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  createAnimal: (payload: Partial<Animal> & { ear_tag: string }) =>
    request<Animal>("/api/animals", { method: "POST", body: JSON.stringify(payload) }),

  // Pesagens --------------------------------------------------------------
  listWeighings: (limit = 200) => request<Weighing[]>(`/api/weighings?limit=${limit}`),
  createWeighing: (payload: Record<string, unknown>) =>
    request<Weighing>("/api/weighings", { method: "POST", body: JSON.stringify(payload) }),
  weighingStatus: (id: string) =>
    request<{ photos: number; complete: boolean; warnings: string[] }>(`/api/weighings/${id}/status`),

  // Fotos -----------------------------------------------------------------
  uploadPhoto: async (args: {
    photoId: string;
    weighingId: string;
    blob: Blob;
    capturedAt: string;
    sensors: unknown;
    width: number;
    height: number;
  }) => {
    const form = new FormData();
    form.append("file", args.blob, `${args.photoId}.jpg`);
    form.append("photo_id", args.photoId);
    form.append("weighing_id", args.weighingId);
    form.append("captured_at", args.capturedAt);
    form.append("sensors", JSON.stringify(args.sensors));
    form.append("width", String(args.width));
    form.append("height", String(args.height));
    const res = await apiFetch(`${API_BASE}/api/photos`, { method: "POST", body: form });
    if (!res.ok) {
      let detail = `Erro ${res.status}`;
      try {
        const body = await res.json();
        detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
      } catch {
        /* ignore */
      }
      throw new ApiError(detail, res.status);
    }
    return res.json();
  },

  // Painel ----------------------------------------------------------------
  dashboard: () => request<DashboardStats>("/api/dashboard/stats"),

  // Modelo (Fase 2) -------------------------------------------------------
  modelStatus: () => request<ModelStatus>("/api/model/status"),
  modelVersions: () => request<ModelVersion[]>("/api/model/versions"),
  train: (algorithm: "ridge" | "gboost" = "ridge") =>
    request<{ model: ModelVersion; message: string }>("/api/model/train", {
      method: "POST",
      body: JSON.stringify({ algorithm, activate: true }),
    }),

  estimate: async (args: {
    file: Blob;
    capturePointId: string;
    breed?: string;
    sex?: string;
    category?: string;
    ageMonths?: number;
    bcs?: number;
  }): Promise<Estimate> => {
    const form = new FormData();
    form.append("file", args.file, "animal.jpg");
    form.append("capture_point_id", args.capturePointId);
    if (args.breed) form.append("breed", args.breed);
    if (args.sex) form.append("sex", args.sex);
    if (args.category) form.append("category", args.category);
    if (args.ageMonths !== undefined) form.append("age_months", String(args.ageMonths));
    if (args.bcs !== undefined) form.append("bcs", String(args.bcs));
    const res = await apiFetch(`${API_BASE}/api/model/estimate`, { method: "POST", body: form });
    if (!res.ok) {
      let detail = `Erro ${res.status}`;
      try {
        const body = await res.json();
        detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
      } catch {
        /* ignore */
      }
      throw new ApiError(detail, res.status);
    }
    return res.json();
  },

  // Modo passagem --------------------------------------------------------
  createPassage: async (args: {
    passageId: string;
    mode: PassageMode;
    capturePointId: string | null;
    category: string | null;
    startedAt: string;
    endedAt: string;
    earTag: string | null;
    lot: string | null;
    frames: PassageQueuedFrame[];
  }): Promise<Passage> => {
    const form = new FormData();
    form.append("passage_id", args.passageId);
    form.append("mode", args.mode);
    if (args.capturePointId) form.append("capture_point_id", args.capturePointId);
    if (args.category) form.append("category", args.category);
    form.append("started_at", args.startedAt);
    form.append("ended_at", args.endedAt);
    if (args.earTag) form.append("ear_tag", args.earTag);
    if (args.lot) form.append("lot", args.lot);
    form.append(
      "frames_meta",
      JSON.stringify(args.frames.map((f) => ({ captured_at: f.capturedAt, detection: f.detection })))
    );
    args.frames.forEach((f, i) => form.append("frames", f.blob, `${args.passageId}-${i}.jpg`));
    const res = await apiFetch(`${API_BASE}/api/passages`, { method: "POST", body: form });
    if (!res.ok) {
      let detail = `Erro ${res.status}`;
      try {
        const body = await res.json();
        detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
      } catch {
        /* ignore */
      }
      throw new ApiError(detail, res.status);
    }
    return res.json();
  },
  listPassages: (params: { limit?: number; lot?: string } = {}) => {
    const q = new URLSearchParams();
    q.set("limit", String(params.limit ?? 50));
    if (params.lot) q.set("lot", params.lot);
    return request<Passage[]>(`/api/passages?${q.toString()}`);
  },
  setPassageFeedback: (id: string, feedback: PassageFeedback | null) =>
    request<Passage>(`/api/passages/${id}/feedback`, { method: "PUT", body: JSON.stringify({ feedback }) }),
  reestimatePassages: () =>
    request<{ processed: number; estimated: number; still_pending: number }>("/api/passages/reestimate", {
      method: "POST",
    }),

  // Exportação (links diretos) -------------------------------------------
  exportCsvUrl: () => `${API_BASE}/api/export/csv`,
  exportZipUrl: () => `${API_BASE}/api/export/zip`,
  photoUrl: (photoId: string) => `${API_BASE}/api/photos/${photoId}/file`,
};
