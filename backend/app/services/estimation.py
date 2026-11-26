"""Serviço de estimativa (endpoint POST /api/estimate).

Carrega o modelo ativo, segmenta a foto, extrai features e prevê.
Retorna peso ± faixa (baseada no MAE da validação cruzada).
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from ..config import settings
from ..models import CapturePoint, ModelVersion
from .estimator import (
    build_feature_row,
    format_interval,
    load_estimator,
)
from .features import extract_mask_features
from .geometry import GeometryError, fixed_point_cm_per_px, geometry_from_mask
from .image_quality import mask_touches_border
from .segmentation import get_segmenter


# Comprimento plausível da silhueta de um bovino (cabeça ao rabo, de lado).
MIN_BODY_LENGTH_CM = 80.0
MAX_BODY_LENGTH_CM = 420.0


class EstimationUnavailableError(RuntimeError):
    """Modelo não pronto ou segmentação indisponível."""

    def __init__(self, message: str, status_code: int = 409):
        super().__init__(message)
        self.status_code = status_code


def get_active_model(db) -> ModelVersion:
    from sqlalchemy import select

    model = db.scalar(
        select(ModelVersion)
        .where(ModelVersion.active.is_(True))
        .order_by(ModelVersion.trained_at.desc())
    )
    if not model:
        raise EstimationUnavailableError(
            f"Nenhum modelo treinado ainda. São necessários ao menos "
            f"{settings.min_animals_for_model} animais com fotos válidas para treinar.",
            409,
        )
    return model


class EstimationContext:
    """Modelo, segmentador e ponto de captura carregados uma única vez.

    Usado para estimar vários quadros seguidos (modo passagem) sem recarregar
    o artefato do modelo a cada foto.
    """

    def __init__(self, db, capture_point_id: Optional[str], mode: str = "fixed"):
        self.mode = mode
        self.model = get_active_model(db)
        self.segmenter = get_segmenter()
        if self.segmenter.name == "none":
            raise EstimationUnavailableError(
                "Segmentação desativada no servidor (SEGMENTATION_ENABLED=false).",
                503,
            )
        if capture_point_id is None:
            # Celular na mão: distância e altura desconhecidas. O encoder
            # imputa a mediana do treino (a faixa é alargada por quem chama).
            self.capture_point: Dict[str, Any] = {"distance_cm": None, "camera_height_cm": None}
        else:
            cp = db.get(CapturePoint, capture_point_id)
            if not cp:
                raise EstimationUnavailableError("Ponto de captura não encontrado.", 422)
            self.capture_point = {
                "distance_cm": cp.distance_cm,
                "camera_height_cm": cp.camera_height_cm,
            }
        if mode == "handheld":
            # Foto na mão: modelo "portátil" (medidas em cm + proporções).
            portable = (self.model.metrics or {}).get("portable") or {}
            if not portable.get("artifact_path"):
                raise EstimationUnavailableError(
                    "O modelo ativo é anterior à foto na mão. Treine o modelo de novo "
                    "(tela Modelo) para calcular estas pesagens.",
                    409,
                )
            self.estimator = load_estimator(portable["artifact_path"])
            self.half_width = float(portable.get("interval_half_width_kg") or 25.0)
        else:
            self.estimator = load_estimator(self.model.artifact_path)
            self.half_width = float(self.model.metrics.get("interval_half_width_kg", 15.0))

    def estimate(
        self,
        image_bgr,
        animal: Optional[Dict[str, Any]] = None,
        *,
        reject_border: bool = False,
        camera: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Estima um quadro. Levanta EstimationUnavailableError (422) se não houver bovino."""
        mask = self.segmenter.segment(image_bgr)
        if mask is None or not mask.any():
            raise EstimationUnavailableError(
                "Nenhum bovino detectado na foto. Verifique o enquadramento.",
                422,
            )
        if reject_border and mask_touches_border(mask):
            raise EstimationUnavailableError(
                "Animal cortado na borda da imagem.",
                422,
            )
        h, w = image_bgr.shape[:2]
        mask_feats = extract_mask_features(mask, w, h)
        geometry: Optional[Dict[str, Any]] = None
        capture_point = self.capture_point
        if self.mode == "handheld":
            try:
                geo = geometry_from_mask(mask, camera or {})
            except GeometryError as exc:
                raise EstimationUnavailableError(str(exc), 422) from exc
            cm_per_px = geo.cm_per_px
            geometry = geo.as_dict()
            capture_point = {"distance_cm": geo.ground_distance_cm, "camera_height_cm": geo.phone_height_cm}
            length_cm = mask_feats["length_px"] * cm_per_px
            if not (MIN_BODY_LENGTH_CM <= length_cm <= MAX_BODY_LENGTH_CM):
                raise EstimationUnavailableError(
                    f"Medida incoerente ({length_cm:.0f} cm de comprimento): o chão entre você e o "
                    "animal pode ser inclinado, ou o animal não está inteiro na foto.",
                    422,
                )
        else:
            cm_per_px = fixed_point_cm_per_px(self.capture_point.get("distance_cm"), w, h)
        row = build_feature_row(
            mask_feats,
            sensors=None,
            animal=animal or {},
            capture_point=capture_point,
            cm_per_px=cm_per_px,
        )
        weight = float(self.estimator.predict([row])[0])
        return {"weight_kg": weight, "features": row, "geometry": geometry}


def estimate_photo(
    db,
    image_bgr,
    *,
    capture_point_id: str,
    breed: Optional[str] = None,
    sex: Optional[str] = None,
    category: Optional[str] = None,
    age_months: Optional[int] = None,
    bcs: Optional[float] = None,
) -> Dict[str, Any]:
    """Estima o peso de um animal a partir de uma foto BGR (OpenCV)."""
    ctx = EstimationContext(db, capture_point_id)
    result = ctx.estimate(
        image_bgr,
        {
            "breed": breed,
            "sex": sex,
            "category": category,
            "age_months": age_months,
            "bcs": bcs,
        },
    )
    weight_kg, w_min, w_max = format_interval(result["weight_kg"], ctx.half_width)
    return {
        "weight_kg": weight_kg,
        "interval_half_width_kg": round(ctx.half_width, 1),
        "weight_min_kg": w_min,
        "weight_max_kg": w_max,
        "model_version": ctx.model.version,
        "expected_mae_kg": ctx.model.metrics.get("mae_kg"),
        "features": result["features"],
    }
