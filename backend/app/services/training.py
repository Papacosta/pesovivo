"""Pipeline de treino da Fase 2.

- Monta o dataset a partir das pesagens reais cadastradas.
- Segmenta cada foto (YOLO genérico, classe "cow") e extrai features.
- Valida com GroupKFold por ANIMAL e treina a versão final.
- Guarda artefato (.joblib) + métricas/histórico no PostgreSQL.

Só roda quando há dados suficientes (MIN_ANIMALS_FOR_MODEL).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List

import cv2
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..config import settings
from ..models import Animal, CapturePoint, ModelVersion, Photo, Weighing
from .estimator import FEATURE_NAMES, build_feature_row, create_estimator
from .features import extract_mask_features
from .geometry import fixed_point_cm_per_px
from .image_quality import mask_touches_border
from .segmentation import get_segmenter
from .storage import photo_abs_path


class TrainingUnavailableError(RuntimeError):
    """Falta de dados, segmentação desligada ou falha recuperável."""


@dataclass
class TrainingDataset:
    rows: List[Dict[str, Any]] = field(default_factory=list)
    y: List[float] = field(default_factory=list)
    groups: List[str] = field(default_factory=list)
    n_photos: int = 0
    skipped: List[str] = field(default_factory=list)

    @property
    def n_animals(self) -> int:
        return len(set(self.groups))


def load_training_dataset(db: Session) -> TrainingDataset:
    """Lê fotos + pesagens e transforma em linhas de features."""
    segmenter = get_segmenter()
    if segmenter.name == "none":
        raise TrainingUnavailableError(
            "Segmentação desativada. Ative com SEGMENTATION_ENABLED=true e instale "
            "requirements-ml.txt (YOLO) para treinar o estimador."
        )

    stmt = (
        select(Photo, Weighing, Animal)
        .join(Weighing, Photo.weighing_id == Weighing.id)
        .join(Animal, Photo.animal_id == Animal.id)
        .order_by(Photo.captured_at.asc())
    )
    records = db.execute(stmt).all()
    if not records:
        raise TrainingUnavailableError(
            "Nenhuma foto com pesagem real cadastrada. Colete dados na Fase 1."
        )

    # Cache de pontos de captura para evitar N queries.
    capture_points = {
        cp.id: {"distance_cm": cp.distance_cm, "camera_height_cm": cp.camera_height_cm}
        for cp in db.scalars(select(CapturePoint)).all()
    }

    dataset = TrainingDataset()
    for photo, weighing, animal in records:
        image_path = photo_abs_path(photo.file_path)
        image = cv2.imread(str(image_path))
        if image is None:
            dataset.skipped.append(f"{photo.id}: arquivo ausente/ilegível")
            continue

        mask = segmenter.segment(image)
        if mask is None or not mask.any():
            dataset.skipped.append(f"{photo.id}: nenhum bovino segmentado")
            continue

        h, w = image.shape[:2]
        mask_feats = extract_mask_features(mask, w, h)

        # Qualidade de enquadramento (silhueta encostando na borda).
        if mask_touches_border(mask):
            dataset.skipped.append(f"{photo.id}: animal cortado na borda")
            continue

        cp_id = photo.capture_point_id or weighing.capture_point_id
        cp = capture_points.get(cp_id)
        row = build_feature_row(
            mask_feats,
            sensors=photo.sensors,
            animal={
                "breed": animal.breed,
                "sex": animal.sex,
                "category": animal.category,
                "age_months": animal.age_months,
                "bcs": animal.bcs,
            },
            capture_point=cp,
            cm_per_px=fixed_point_cm_per_px(cp["distance_cm"] if cp else None, w, h),
        )
        dataset.rows.append(row)
        dataset.y.append(float(weighing.weight_kg))
        dataset.groups.append(animal.id)
        dataset.n_photos += 1

    if not dataset.rows:
        raise TrainingUnavailableError(
            "Nenhuma foto aproveitável após a segmentação. "
            "Verifique enquadramento e ative a segmentação."
        )
    return dataset


def train_model(
    db: Session,
    algorithm: str = "ridge",
    activate: bool = True,
) -> ModelVersion:
    """Treina, avalia por animal e registra uma nova versão do modelo."""
    dataset = load_training_dataset(db)
    if dataset.n_animals < settings.min_animals_for_model:
        raise TrainingUnavailableError(
            f"São necessários ao menos {settings.min_animals_for_model} animais "
            f"com fotos válidas; há {dataset.n_animals}."
        )

    estimator = create_estimator(algorithm)
    metrics = estimator.cross_validate(dataset.rows, dataset.y, dataset.groups)
    estimator.fit(dataset.rows, dataset.y)

    now = datetime.now(timezone.utc)
    version = f"{algorithm}-{now:%Y%m%d-%H%M%S}"
    artifact_path = settings.models_dir / f"{version}.joblib"
    settings.models_dir.mkdir(parents=True, exist_ok=True)
    estimator.save(str(artifact_path))

    # Modelo "portátil" (medidas em cm + proporções) para as fotos na mão.
    portable = _train_portable(dataset, algorithm, version)
    if portable:
        metrics = {**metrics, "portable": portable}

    if activate:
        db.execute(update(ModelVersion).values(active=False))

    model = ModelVersion(
        version=version,
        algorithm=algorithm,
        artifact_path=str(artifact_path),
        metrics=metrics,
        feature_names=FEATURE_NAMES,
        n_animals=dataset.n_animals,
        n_photos=dataset.n_photos,
        active=activate,
        trained_at=now,
    )
    db.add(model)
    db.commit()
    db.refresh(model)
    return model


def _train_portable(dataset: TrainingDataset, algorithm: str, version: str) -> Dict[str, Any] | None:
    """Treina o modelo usado no modo na mão. Só fotos com escala conhecida entram.

    Devolve o resumo para guardar em `metrics["portable"]`, ou None se não houver
    animais suficientes com ponto de captura (distância medida).
    """
    idx = [i for i, r in enumerate(dataset.rows) if r.get("length_cm") is not None]
    groups = [dataset.groups[i] for i in idx]
    if len(set(groups)) < max(3, min(settings.min_animals_for_model, 10)):
        return None
    rows = [dataset.rows[i] for i in idx]
    y = [dataset.y[i] for i in idx]
    estimator = create_estimator(algorithm, feature_set="portable")
    cv = estimator.cross_validate(rows, y, groups)
    estimator.fit(rows, y)
    path = settings.models_dir / f"{version}-portable.joblib"
    estimator.save(str(path))
    return {
        "artifact_path": str(path),
        "mae_kg": cv.get("mae_kg"),
        "mape_pct": cv.get("mape_pct"),
        "interval_half_width_kg": cv.get("interval_half_width_kg"),
        "n_photos": len(rows),
        "n_animals": len(set(groups)),
    }


def model_status(db: Session) -> Dict[str, Any]:
    """Estado atual do estimador + motivo de estar indisponível."""
    active = db.scalars(
        select(ModelVersion).where(ModelVersion.active.is_(True)).order_by(
            ModelVersion.trained_at.desc()
        )
    ).first()

    from sqlalchemy import func

    n_animals = int(
        db.scalar(
            select(func.count(func.distinct(Photo.animal_id)))
            .select_from(Photo)
            .join(Weighing, Photo.weighing_id == Weighing.id)
        )
        or 0
    )

    can_train = n_animals >= settings.min_animals_for_model and settings.segmentation_enabled
    reason = None
    if not settings.segmentation_enabled:
        reason = "Segmentação desligada no servidor (SEGMENTATION_ENABLED=false)."
    elif n_animals < settings.min_animals_for_model:
        reason = (
            f"Faltam {settings.min_animals_for_model - n_animals} animais com fotos "
            f"para o primeiro treino (mínimo {settings.min_animals_for_model})."
        )

    return {
        "active": active,
        "can_train": can_train,
        "min_animals_for_model": settings.min_animals_for_model,
        "animals_with_photos": n_animals,
        "reason": reason,
    }
