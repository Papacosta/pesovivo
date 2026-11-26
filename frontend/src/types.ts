/** Tipos compartilhados com a API e com a camada de sensores. */

export interface CapturePoint {
  id: string;
  name: string;
  device_model?: string | null;
  distance_cm: number;
  camera_height_cm: number;
  notes?: string | null;
  created_at: string;
}

export interface Animal {
  id: string;
  ear_tag: string;
  breed?: string | null;
  sex?: string | null;
  category?: string | null;
  age_months?: number | null;
  bcs?: number | null;
  notes?: string | null;
  created_at: string;
}

export interface OrientationReading {
  available: boolean;
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  absolute: boolean | null;
  tilt_deg: number | null;
}

export interface MotionReading {
  available: boolean;
  acceleration: { x: number | null; y: number | null; z: number | null };
  acceleration_including_gravity: { x: number | null; y: number | null; z: number | null };
  rotation_rate: { alpha: number | null; beta: number | null; gamma: number | null };
}

export interface CameraReading {
  available: boolean;
  settings: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  zoom: number | null;
  image_capture_supported: boolean;
}

export interface GeolocationReading {
  available: boolean;
  latitude: number | null;
  longitude: number | null;
  accuracy_m: number | null;
  timestamp: number | null;
}

export interface AmbientLightReading {
  available: boolean;
  lux: number | null;
  source: "sensor" | "image_fallback";
}

export interface DepthReading {
  available: boolean;
  distance_m: number | null;
  method: string | null;
}

export interface SensorSnapshot {
  orientation: OrientationReading;
  motion: MotionReading;
  camera: CameraReading;
  geolocation: GeolocationReading;
  ambient_light: AmbientLightReading;
  depth: DepthReading;
  device: { user_agent: string | null; platform: string | null };
  quality?: { warnings: string[]; sensor_score: number };
}

export interface PhotoQuality {
  blur_score: number;
  is_blurry: boolean;
  brightness: number;
  is_dark: boolean;
  is_overexposed: boolean;
  bright_fraction: number;
  dark_fraction: number;
  is_glary: boolean;
  width: number;
  height: number;
  mask_touches_border: boolean | null;
  warnings: string[];
}

export interface Photo {
  id: string;
  weighing_id: string;
  animal_id: string;
  capture_point_id: string | null;
  file_path: string;
  sha256: string;
  width: number | null;
  height: number | null;
  sensors: SensorSnapshot;
  quality: PhotoQuality;
  captured_at: string;
  created_at: string;
}

export interface Weighing {
  id: string;
  animal_id: string;
  capture_point_id: string | null;
  weight_kg: number;
  weighed_at: string;
  light_condition?: string | null;
  time_of_day?: string | null;
  fasting?: boolean | null;
  notes?: string | null;
  created_at: string;
  photos: Photo[];
}

export interface WeightBucket {
  label: string;
  min_kg: number | null;
  max_kg: number | null;
  count: number;
}

export interface ModelVersion {
  id: string;
  version: string;
  algorithm: string;
  metrics: {
    mae_kg?: number;
    mape_pct?: number;
    rmse_kg?: number;
    bias_kg?: number;
    interval_half_width_kg?: number;
    n_folds?: number;
    folds?: Array<Record<string, number>>;
    predicted_vs_real?: Array<{ real_kg: number; estimado_kg: number }>;
    grouping?: string;
  };
  feature_names: string[];
  n_animals: number;
  n_photos: number;
  active: boolean;
  trained_at: string;
}

export interface ModelStatus {
  active: ModelVersion | null;
  can_train: boolean;
  min_animals_for_model: number;
  animals_with_photos: number;
  reason: string | null;
}

export interface DashboardStats {
  total_animals: number;
  total_photos: number;
  total_weighings: number;
  min_animals_for_model: number;
  weights: WeightBucket[];
  by_breed: Record<string, number>;
  by_category: Record<string, number>;
  by_sex: Record<string, number>;
  warnings: string[];
  model_status: ModelStatus;
}

export interface Estimate {
  weight_kg: number;
  interval_half_width_kg: number;
  weight_min_kg: number;
  weight_max_kg: number;
  model_version: string;
  expected_mae_kg: number | null;
  features: Record<string, number | string | null>;
}

/** Item da fila offline (IndexedDB). */
export type QueueItem =
  | {
      kind: "capturePoint";
      id: string;
      createdAt: number;
      payload: Record<string, unknown>;
    }
  | {
      kind: "animal";
      id: string;
      createdAt: number;
      payload: Record<string, unknown>;
    }
  | {
      kind: "weighing";
      id: string;
      createdAt: number;
      payload: Record<string, unknown>;
    }
  | {
      kind: "photo";
      id: string;
      createdAt: number;
      weighingId: string;
      blob: Blob;
      capturedAt: string;
      sensors: SensorSnapshot;
      width: number;
      height: number;
    }
  | {
      kind: "passage";
      id: string;
      createdAt: number;
      /** Ausente em itens antigos da fila: tratar como "fixed". */
      mode?: PassageMode;
      capturePointId: string | null;
      category?: string | null;
      startedAt: string;
      endedAt: string;
      earTag: string | null;
      lot: string | null;
      frames: PassageQueuedFrame[];
    };

export interface PassageQueuedFrame {
  blob: Blob;
  capturedAt: string;
  detection: Record<string, unknown>;
}

export type PassageMode = "fixed" | "handheld";
/** "Saiu como esperado?": ok = sim; low = achei baixo; high = achei alto. */
export type PassageFeedback = "ok" | "low" | "high";

export interface Passage {
  id: string;
  mode: PassageMode;
  capture_point_id: string | null;
  animal_id: string | null;
  category: string | null;
  ear_tag: string | null;
  lot: string | null;
  started_at: string;
  ended_at: string | null;
  status: "estimated" | "pending_model" | "failed";
  message: string | null;
  weight_kg: number | null;
  weight_min_kg: number | null;
  weight_max_kg: number | null;
  interval_half_width_kg: number | null;
  frame_spread_kg: number | null;
  n_frames: number;
  n_frames_used: number;
  model_version: string | null;
  estimated_at: string | null;
  feedback: PassageFeedback | null;
  feedback_at: string | null;
  created_at: string;
}
