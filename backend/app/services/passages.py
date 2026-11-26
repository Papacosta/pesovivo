"""Modo passagem: agrega as estimativas dos quadros de um animal passando.

Fluxo:
1. O celular (câmera fixa) detecta o animal entrando/saindo do quadro e
   envia os melhores quadros da passagem.
2. Cada quadro é segmentado e estimado com o modelo ativo.
3. Quadros discrepantes são descartados (regra robusta da mediana/MAD) e o
   peso final é a MEDIANA dos restantes.

A faixa de incerteza nunca é menor que a do modelo (±1,28 × MAE da validação
agrupada por animal). Os erros dos quadros do mesmo animal são correlacionados,
então não "encolhemos" a faixa por usar vários quadros. Se os quadros
discordarem muito entre si, a faixa é alargada.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

from ..models import Animal, Passage
from ..utils import utcnow
from .estimation import EstimationContext, EstimationUnavailableError
from .estimator import format_interval
from .storage import decode_image, photo_abs_path

# z da normal para ~80% (mesma convenção do restante do app).
Z80 = 1.28
# Desvio robusto mínimo, relativo ao peso: evita descartar quadros quando
# todos são quase idênticos (MAD ~ 0).
MIN_REL_SIGMA = 0.02
OUTLIER_SIGMAS = 3.0
# Celular na mão: distância e ângulo variam a cada foto e o modelo foi
# treinado com o celular fixo. A faixa do modelo é alargada nesse modo.
HANDHELD_INTERVAL_FACTOR = 1.5
HANDHELD_WARNING = (
    "Foto na mão: distância estimada pelo ângulo do celular, faixa de erro maior. "
    "Para mais precisão, use o celular fixo no corredor."
)


def passage_half_width(model_half_width: float, mode: str) -> float:
    """Faixa do modelo ajustada ao modo de captura da passagem."""
    if mode == "handheld":
        return float(model_half_width) * HANDHELD_INTERVAL_FACTOR
    return float(model_half_width)


@dataclass
class AggregateResult:
    weight_kg: Optional[float]
    weight_min_kg: Optional[float]
    weight_max_kg: Optional[float]
    interval_half_width_kg: Optional[float]
    spread_kg: Optional[float]
    used_mask: List[bool] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)

    @property
    def n_used(self) -> int:
        return int(sum(self.used_mask))


def robust_sigma(values: Sequence[float]) -> float:
    """Desvio padrão robusto (1,4826 × MAD)."""
    arr = np.asarray(values, dtype=float)
    if arr.size == 0:
        return 0.0
    med = float(np.median(arr))
    return float(1.4826 * np.median(np.abs(arr - med)))


def aggregate_estimates(
    weights: Sequence[Optional[float]], model_half_width: float
) -> AggregateResult:
    """Combina as estimativas por quadro em um peso da passagem.

    `weights` pode conter None (quadro sem estimativa). A posição é mantida em
    `used_mask` para marcar quais quadros entraram no resultado.
    """
    valid_idx = [i for i, w in enumerate(weights) if w is not None and np.isfinite(w)]
    used = [False] * len(weights)
    if not valid_idx:
        return AggregateResult(None, None, None, None, None, used, ["Nenhum quadro válido para estimar."])

    vals = np.array([float(weights[i]) for i in valid_idx])
    med = float(np.median(vals))
    sigma = max(robust_sigma(vals), MIN_REL_SIGMA * abs(med))
    keep = np.abs(vals - med) <= OUTLIER_SIGMAS * sigma
    for i, k in zip(valid_idx, keep):
        used[i] = bool(k)

    kept = vals[keep]
    weight = float(np.median(kept))
    spread = robust_sigma(kept) if kept.size >= 2 else 0.0
    half = max(float(model_half_width), Z80 * spread)
    weight_kg, w_min, w_max = format_interval(weight, half)

    warnings: List[str] = []
    if kept.size < 2:
        warnings.append("Só 1 quadro válido: estimativa menos estável. Confira o enquadramento.")
    if (~keep).any():
        warnings.append(f"{int((~keep).sum())} quadro(s) discrepante(s) descartado(s).")
    if spread > model_half_width:
        warnings.append(
            "Quadros discordam entre si mais que o erro do modelo: faixa alargada. "
            "Animal pode ter passado rápido, torto ou acompanhado."
        )

    return AggregateResult(
        weight_kg=weight_kg,
        weight_min_kg=w_min,
        weight_max_kg=w_max,
        interval_half_width_kg=round(half, 1),
        spread_kg=round(spread, 1),
        used_mask=used,
        warnings=warnings,
    )


def animal_features(animal: Optional[Animal], category: Optional[str] = None) -> Dict[str, Any]:
    """Dados do cadastro para o modelo. A categoria escolhida antes da foto
    só entra quando o cadastro do animal não tem categoria."""
    info: Dict[str, Any] = {}
    if animal:
        info = {
            "breed": animal.breed,
            "sex": animal.sex,
            "category": animal.category,
            "age_months": animal.age_months,
            "bcs": animal.bcs,
        }
    if not info.get("category") and category:
        info["category"] = category
    return info


def estimate_passage(db, passage: Passage) -> Passage:
    """(Re)estima todos os quadros da passagem e atualiza o resultado.

    Nunca levanta erro por falta de modelo: marca `pending_model` para que a
    passagem seja reestimada quando houver modelo ativo.
    """
    try:
        ctx = EstimationContext(db, passage.capture_point_id, passage.mode)
    except EstimationUnavailableError as exc:
        passage.status = "pending_model"
        passage.message = str(exc)
        return passage

    animal_info = animal_features(passage.animal, passage.category)
    weights: List[Optional[float]] = []
    distances: List[float] = []
    for frame in passage.frames:
        frame.weight_kg = None
        frame.error = None
        try:
            raw = photo_abs_path(frame.file_path).read_bytes()
            image = decode_image(raw)
            camera = (frame.detection or {}).get("camera")
            result = ctx.estimate(image, animal_info, reject_border=True, camera=camera)
            frame.weight_kg = round(result["weight_kg"], 1)
            if result.get("geometry"):
                frame.quality = {**(frame.quality or {}), "geometry": result["geometry"]}
                distances.append(result["geometry"]["ground_distance_cm"])
        except EstimationUnavailableError as exc:
            frame.error = str(exc)
        except Exception as exc:  # um quadro ruim não derruba a passagem
            frame.error = f"Falha ao processar quadro: {exc}"
        weights.append(frame.weight_kg)

    agg = aggregate_estimates(weights, passage_half_width(ctx.half_width, passage.mode))
    if passage.mode == "handheld":
        agg.warnings.insert(0, HANDHELD_WARNING)
        if distances:
            agg.warnings.insert(0, f"Animal a cerca de {np.median(distances) / 100:.0f} m.")
        elif agg.weight_kg is None:
            # Sem nenhum quadro válido: mostra o motivo do primeiro quadro.
            first_error = next((f.error for f in passage.frames if f.error), None)
            if first_error:
                agg.warnings.insert(0, first_error)
    for frame, used in zip(passage.frames, agg.used_mask):
        frame.used = used

    passage.model_version = ctx.model.version
    passage.estimated_at = utcnow()
    passage.n_frames = len(passage.frames)
    passage.n_frames_used = agg.n_used
    passage.weight_kg = agg.weight_kg
    passage.weight_min_kg = agg.weight_min_kg
    passage.weight_max_kg = agg.weight_max_kg
    passage.interval_half_width_kg = agg.interval_half_width_kg
    passage.frame_spread_kg = agg.spread_kg
    passage.status = "estimated" if agg.weight_kg is not None else "failed"
    passage.message = " ".join(agg.warnings) or None
    return passage
