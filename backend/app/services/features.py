"""Características da máscara do animal (Fase 2, item 2).

Funções puras sobre uma máscara binária (numpy bool/0-1), fáceis de testar.
A foto é LATERAL e a câmera é FIXA, portanto:

- "comprimento" = extensão horizontal do animal no enquadramento;
- "altura do corpo" = extensão vertical no enquadramento;
- "altura do tórax" = maior extensão vertical na região central do corpo
  (suposição: a barriga/caixa torácica tem a maior profundidade vertical
  na porção central; cabeça e pernas ficam nas extremidades).
- Todas as medidas em pixels são também normalizadas pelo tamanho da imagem,
  para o modelo tolerar pequenas variações de resolução.
"""
from __future__ import annotations

from typing import Dict

import numpy as np


def extract_mask_features(mask: np.ndarray, image_width: int, image_height: int) -> Dict[str, float]:
    """Extrai características morfológicas da silhueta.

    Levanta ValueError se a máscara estiver vazia (o chamador decide
    registrar a foto sem características ou avisar o usuário).
    """
    if mask is None or mask.size == 0:
        raise ValueError("Máscara vazia.")
    m = mask.astype(bool)
    if not m.any():
        raise ValueError("Máscara sem pixels: nenhum animal segmentado.")

    ys, xs = np.nonzero(m)
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())

    length_px = x1 - x0 + 1          # comprimento do corpo (lateral)
    body_height_px = y1 - y0 + 1     # altura total do animal
    area_px = int(m.sum())

    # Extensão vertical de cada coluna dentro do bbox.
    extents = np.zeros(length_px, dtype=np.float64)
    for i, xi in enumerate(range(x0, x1 + 1)):
        col = ys[xs == xi]
        extents[i] = (col.max() - col.min() + 1) if col.size else 0.0

    # Região central (25%-75% do comprimento) -> profundidade torácica.
    lo, hi = int(length_px * 0.25), int(length_px * 0.75)
    thorax_area = extents[lo : max(hi, lo + 1)] if hi > lo else extents
    thorax_height_px = float(thorax_area.max()) if thorax_area.size else 0.0

    denom = max(body_height_px, 1)
    if image_width <= 0 or image_height <= 0:
        raise ValueError("Dimensões da imagem inválidas para normalização.")
    image_area = float(image_width * image_height)

    return {
        # Em pixels (brutos)
        "area_px": area_px,
        "length_px": float(length_px),
        "body_height_px": float(body_height_px),
        "thorax_height_px": thorax_height_px,
        # Normalizadas (dimensão da imagem)
        "area_norm": area_px / image_area,
        "length_norm": length_px / float(image_width),
        "body_height_norm": body_height_px / float(image_height),
        "thorax_height_norm": thorax_height_px / float(image_height),
        # Proporções invariantes à escala da imagem
        "length_height_ratio": length_px / denom,
        "thorax_height_ratio": thorax_height_px / denom,
        "fill_ratio": area_px / max(float(length_px * body_height_px), 1.0),
        "area_per_length": area_px / max(float(length_px), 1.0),
        # Centro de massa relativo (informação de alinhamento)
        "centroid_x": float(xs.mean()) / float(image_width),
        "centroid_y": float(ys.mean()) / float(image_height),
    }


# Nomes estáveis para construir a matriz do modelo.
MASK_FEATURE_NAMES = [
    "area_norm",
    "length_norm",
    "body_height_norm",
    "thorax_height_norm",
    "length_height_ratio",
    "thorax_height_ratio",
    "fill_ratio",
    "area_per_length",
    "centroid_x",
    "centroid_y",
]


# Medidas em centímetros (exigem escala cm/pixel: distância conhecida ou
# estimada pela geometria do chão). Independem de zoom e distância, por isso
# servem tanto para o celular fixo quanto para a foto na mão.
METRIC_FEATURE_NAMES = [
    "length_cm",
    "body_height_cm",
    "thorax_height_cm",
    "area_m2",
]

# Proporções da silhueta que não mudam com distância nem zoom.
SCALE_FREE_FEATURE_NAMES = [
    "length_height_ratio",
    "thorax_height_ratio",
    "fill_ratio",
]


def metric_features(mask_features: Dict[str, float], cm_per_px: float | None) -> Dict[str, float | None]:
    """Converte as medidas em pixels para centímetros com a escala dada."""
    if not cm_per_px or cm_per_px <= 0:
        return {name: None for name in METRIC_FEATURE_NAMES}
    s = float(cm_per_px)
    return {
        "length_cm": mask_features["length_px"] * s,
        "body_height_cm": mask_features["body_height_px"] * s,
        "thorax_height_cm": mask_features["thorax_height_px"] * s,
        "area_m2": mask_features["area_px"] * s * s / 10_000.0,
    }
