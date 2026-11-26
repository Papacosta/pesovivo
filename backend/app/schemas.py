"""Schemas Pydantic (contratos da API)."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field

# Categorias sugeridas. A API aceita qualquer string para não travar o campo.
CATEGORIES = ["bezerro", "novilha", "vaca", "boi"]
SEXES = ["macho", "femea"]


class CapturePointIn(BaseModel):
    id: Optional[str] = Field(default=None, max_length=36)
    name: str = Field(min_length=1, max_length=120)
    device_model: Optional[str] = Field(default=None, max_length=120)
    distance_cm: float = Field(gt=0, le=5000, description="Distância câmera-animal em cm")
    camera_height_cm: float = Field(gt=0, le=5000, description="Altura da câmera em cm")
    notes: Optional[str] = None


class CapturePointOut(CapturePointIn):
    model_config = ConfigDict(from_attributes=True)
    id: str
    created_at: datetime


class AnimalIn(BaseModel):
    id: Optional[str] = Field(default=None, max_length=36)
    ear_tag: str = Field(min_length=1, max_length=60)
    breed: Optional[str] = Field(default=None, max_length=60)
    sex: Optional[str] = Field(default=None, max_length=20)
    category: Optional[str] = Field(default=None, max_length=30)
    age_months: Optional[int] = Field(default=None, ge=0, le=400)
    bcs: Optional[float] = Field(default=None, ge=0, le=9)
    notes: Optional[str] = None


class AnimalOut(AnimalIn):
    model_config = ConfigDict(from_attributes=True)
    id: str
    created_at: datetime


class WeighingIn(BaseModel):
    id: Optional[str] = Field(default=None, max_length=36)
    animal_id: str
    capture_point_id: Optional[str] = None
    weight_kg: float = Field(gt=0, le=2000)
    weighed_at: Optional[datetime] = None
    light_condition: Optional[str] = Field(default=None, max_length=40)
    time_of_day: Optional[str] = Field(default=None, max_length=20)
    fasting: Optional[bool] = None
    notes: Optional[str] = None


class PhotoOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    weighing_id: str
    animal_id: str
    capture_point_id: Optional[str]
    file_path: str
    sha256: str
    width: Optional[int]
    height: Optional[int]
    sensors: Dict[str, Any]
    quality: Dict[str, Any]
    captured_at: datetime
    created_at: datetime


class WeighingOut(WeighingIn):
    model_config = ConfigDict(from_attributes=True)
    id: str
    created_at: datetime
    photos: List[PhotoOut] = []


class WeightBucket(BaseModel):
    label: str
    min_kg: Optional[float]
    max_kg: Optional[float]
    count: int


class DashboardOut(BaseModel):
    total_animals: int
    total_photos: int
    total_weighings: int
    min_animals_for_model: int
    weights: List[WeightBucket]
    by_breed: Dict[str, int]
    by_category: Dict[str, int]
    by_sex: Dict[str, int]
    warnings: List[str]
    model_status: "ModelStatusOut"


class ModelMetrics(BaseModel):
    mae_kg: Optional[float] = None
    mape_pct: Optional[float] = None
    rmse_kg: Optional[float] = None
    bias_kg: Optional[float] = None
    interval_half_width_kg: Optional[float] = None
    n_folds: Optional[int] = None
    folds: List[Dict[str, Any]] = []
    predicted_vs_real: List[Dict[str, float]] = []


class ModelStatusOut(BaseModel):
    active: Optional["ModelVersionOut"] = None
    can_train: bool
    min_animals_for_model: int
    animals_with_photos: int
    reason: Optional[str] = None


class ModelVersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    version: str
    algorithm: str
    metrics: Dict[str, Any]
    feature_names: List[str] = []
    n_animals: int
    n_photos: int
    active: bool
    trained_at: datetime


class TrainRequest(BaseModel):
    algorithm: Optional[str] = Field(default="ridge", pattern="^(ridge|gboost)$")
    activate: bool = True


class TrainOut(BaseModel):
    model: ModelVersionOut
    message: str


class EstimateOut(BaseModel):
    weight_kg: float
    interval_half_width_kg: float
    weight_min_kg: float
    weight_max_kg: float
    model_version: str
    expected_mae_kg: float
    features: Dict[str, Any]


class PassageFrameOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    captured_at: datetime
    width: Optional[int]
    height: Optional[int]
    detection: Dict[str, Any]
    quality: Dict[str, Any]
    weight_kg: Optional[float]
    used: bool
    error: Optional[str]


PASSAGE_MODES = ["fixed", "handheld"]
FEEDBACK_VALUES = ["ok", "low", "high"]


class PassageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    mode: str = "fixed"
    capture_point_id: Optional[str]
    animal_id: Optional[str]
    category: Optional[str] = None
    ear_tag: Optional[str]
    lot: Optional[str]
    started_at: datetime
    ended_at: Optional[datetime]
    status: str
    message: Optional[str]
    weight_kg: Optional[float]
    weight_min_kg: Optional[float]
    weight_max_kg: Optional[float]
    interval_half_width_kg: Optional[float]
    frame_spread_kg: Optional[float]
    n_frames: int
    n_frames_used: int
    model_version: Optional[str]
    estimated_at: Optional[datetime]
    feedback: Optional[str] = None
    feedback_at: Optional[datetime] = None
    created_at: datetime


class PassageFeedbackIn(BaseModel):
    """Resposta a "Saiu como esperado?": ok, low (achei baixo) ou high (achei alto)."""

    feedback: Optional[str] = Field(default=None, pattern="^(ok|low|high)$")


class PassageDetailOut(PassageOut):
    frames: List[PassageFrameOut] = []


class PassageReestimateOut(BaseModel):
    processed: int
    estimated: int
    still_pending: int


DashboardOut.model_rebuild()
ModelStatusOut.model_rebuild()
