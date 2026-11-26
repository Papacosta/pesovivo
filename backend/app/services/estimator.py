"""Estimador de peso (Fase 2, itens 3, 5 e 7).

Interface própria (`WeightEstimator`) para trocar Ridge/Gradient Boosting por
uma CNN que use a imagem diretamente no futuro, sem alterar a API ou o app.

Entrada: uma linha de características (features da máscara + metadados +
sensores). Saída: peso em kg e faixa de incerteza derivada do MAE da
validação cruzada agrupada por animal.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple

import joblib
import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.model_selection import GroupKFold

from .features import (
    MASK_FEATURE_NAMES,
    METRIC_FEATURE_NAMES,
    SCALE_FREE_FEATURE_NAMES,
    metric_features,
)
from .metrics import interval_half_width, summarize

# Características numéricas: máscara + sensores + cadastro.
NUMERIC_FEATURES = MASK_FEATURE_NAMES + [
    "distance_cm",
    "camera_height_cm",
    "tilt_deg",
    "age_months",
    "bcs",
]
CATEGORICAL_FEATURES = ["breed", "sex", "category"]
FEATURE_NAMES = NUMERIC_FEATURES + CATEGORICAL_FEATURES

# Conjunto "portátil": só medidas em cm e proporções, sem nada que dependa de
# onde a câmera estava. Treinado com as fotos do celular fixo (distância
# medida) e usado nas fotos na mão (distância estimada pela geometria).
PORTABLE_NUMERIC_FEATURES = METRIC_FEATURE_NAMES + SCALE_FREE_FEATURE_NAMES + [
    "age_months",
    "bcs",
]
PORTABLE_FEATURE_NAMES = PORTABLE_NUMERIC_FEATURES + CATEGORICAL_FEATURES
FEATURE_SETS = {"full": NUMERIC_FEATURES, "portable": PORTABLE_NUMERIC_FEATURES}


def build_feature_row(
    mask_features: Dict[str, float],
    *,
    sensors: Optional[Dict[str, Any]] = None,
    animal: Optional[Dict[str, Any]] = None,
    capture_point: Optional[Dict[str, Any]] = None,
    cm_per_px: Optional[float] = None,
) -> Dict[str, Any]:
    """Monta uma linha de features a partir das partes heterogêneas.

    Aceita dicionários (não ORM) para manter o módulo testável e independente
    do banco. Valores ausentes viram None -> imputados pela mediana no treino.
    """
    row: Dict[str, Any] = {name: mask_features.get(name) for name in MASK_FEATURE_NAMES}
    if "length_px" in mask_features:
        row.update(metric_features(mask_features, cm_per_px))
    else:
        row.update({name: None for name in METRIC_FEATURE_NAMES})

    sensors = sensors or {}
    orientation = sensors.get("orientation") or {}
    row["tilt_deg"] = orientation.get("tilt_deg")

    cp = capture_point or {}
    row["distance_cm"] = cp.get("distance_cm")
    row["camera_height_cm"] = cp.get("camera_height_cm")

    a = animal or {}
    row["age_months"] = a.get("age_months")
    row["bcs"] = a.get("bcs")
    row["breed"] = (a.get("breed") or "").strip().lower() or None
    row["sex"] = (a.get("sex") or "").strip().lower() or None
    row["category"] = (a.get("category") or "").strip().lower() or None
    return row


class FeatureEncoder:
    """Imputação + padronização + one-hot, sem depender de pandas."""

    def __init__(self, numeric: Optional[Sequence[str]] = None) -> None:
        self.numeric: List[str] = list(numeric or NUMERIC_FEATURES)
        self.medians: Dict[str, float] = {}
        self.categories: Dict[str, List[str]] = {}

    @property
    def numeric_names(self) -> List[str]:
        # Artefatos antigos não têm `numeric`: usavam a lista completa.
        return getattr(self, "numeric", None) or NUMERIC_FEATURES

    def fit(self, rows: Sequence[Dict[str, Any]]) -> "FeatureEncoder":
        for name in self.numeric_names:
            values = [float(r[name]) for r in rows if r.get(name) is not None]
            self.medians[name] = float(np.median(values)) if values else 0.0

        for name in CATEGORICAL_FEATURES:
            vocab = sorted({str(r[name]) for r in rows if r.get(name)})
            self.categories[name] = vocab
        return self

    def transform(self, rows: Sequence[Dict[str, Any]]) -> np.ndarray:
        out: List[List[float]] = []
        for r in rows:
            vec: List[float] = []
            for name in self.numeric_names:
                v = r.get(name)
                vec.append(float(v) if v is not None and not _is_nan(v) else self.medians[name])
            for name in CATEGORICAL_FEATURES:
                value = r.get(name)
                vocab = self.categories.get(name, [])
                for cat in vocab:
                    vec.append(1.0 if value is not None and str(value) == cat else 0.0)
            out.append(vec)
        return np.asarray(out, dtype=np.float64)

    @property
    def output_dim(self) -> int:
        return len(self.numeric_names) + sum(len(v) for v in self.categories.values())


def _is_nan(value: Any) -> bool:
    try:
        return bool(np.isnan(float(value)))
    except (TypeError, ValueError):
        return True


class WeightEstimator:
    """Contrato do estimador. Implementações devem seguir esta interface."""

    name = "base"

    def fit(self, rows: Sequence[Dict[str, Any]], y: Sequence[float]) -> "WeightEstimator":
        raise NotImplementedError

    def predict(self, rows: Sequence[Dict[str, Any]]) -> np.ndarray:
        raise NotImplementedError


class _SklearnEstimator(WeightEstimator):
    """Base comum: encoder + modelo sklearn + validação cruzada agrupada."""

    name = "sklearn"

    def __init__(self, feature_set: str = "full") -> None:
        if feature_set not in FEATURE_SETS:
            raise ValueError(f"Conjunto de features desconhecido: {feature_set}")
        self.feature_set = feature_set
        self.encoder: Optional[FeatureEncoder] = None
        self.model: Any = None
        self.metrics: Dict[str, Any] = {}
        self.feature_names: List[str] = list(FEATURE_SETS[feature_set]) + CATEGORICAL_FEATURES

    def _new_encoder(self) -> FeatureEncoder:
        return FeatureEncoder(FEATURE_SETS[self.feature_set])

    def _make_model(self):
        raise NotImplementedError

    def fit(self, rows, y):
        self.encoder = self._new_encoder().fit(rows)
        self.model = self._make_model()
        self.model.fit(self.encoder.transform(rows), np.asarray(y, dtype=float))
        return self

    def predict(self, rows: Sequence[Dict[str, Any]]) -> np.ndarray:
        if self.encoder is None or self.model is None:
            raise RuntimeError("Estimador não treinado.")
        return self.model.predict(self.encoder.transform(rows))

    def cross_validate(
        self,
        rows: Sequence[Dict[str, Any]],
        y: Sequence[float],
        groups: Sequence[str],
        max_splits: int = 5,
    ) -> Dict[str, Any]:
        """Validação CRUZADA POR ANIMAL (GroupKFold).

        Cada animal aparece em apenas um fold, impedindo vazamento entre
        treino e teste (várias fotos do mesmo animal não podem se separar).
        Retorna métricas agregadas + métricas por fold + pontos estimado/real.
        """
        n_groups = len(set(groups))
        if n_groups < 3:
            raise ValueError(
                f"Validação por animal exige ao menos 3 animais distintos; há {n_groups}."
            )
        n_splits = min(max_splits, n_groups)
        splitter = GroupKFold(n_splits=n_splits)

        oof_pred = np.zeros(len(rows), dtype=float)
        oof_true = np.asarray(y, dtype=float)
        fold_rows: List[Dict[str, float]] = []
        y_true_by_fold: List[List[float]] = []
        y_pred_by_fold: List[List[float]] = []

        for fold_idx, (train_idx, test_idx) in enumerate(
            splitter.split(np.zeros(len(rows)), oof_true, groups=groups), start=1
        ):
            train_rows = [rows[i] for i in train_idx]
            test_rows = [rows[i] for i in test_idx]
            encoder = self._new_encoder().fit(train_rows)
            model = self._make_model()
            model.fit(encoder.transform(train_rows), oof_true[train_idx])

            preds = model.predict(encoder.transform(test_rows))
            oof_pred[test_idx] = preds

            yt = oof_true[test_idx].tolist()
            yp = preds.tolist()
            y_true_by_fold.append(yt)
            y_pred_by_fold.append(yp)
            fold_rows.append({"fold": fold_idx, **summarize(yt, yp)})

        summary = summarize(oof_true.tolist(), oof_pred.tolist())
        half_width = interval_half_width(summary["mae_kg"])

        self.metrics = {
            **summary,
            "interval_half_width_kg": half_width,
            "n_folds": n_splits,
            "folds": fold_rows,
            # Limita a 300 pontos para não inflar o JSONB.
            "predicted_vs_real": [
                {"real_kg": round(float(t), 1), "estimado_kg": round(float(p), 1)}
                for t, p in zip(oof_true.tolist(), oof_pred.tolist())
            ][:300],
            "grouping": "animal",
        }
        return self.metrics

    # Persistência ---------------------------------------------------------
    def save(self, path: str) -> None:
        joblib.dump(
            {
                "kind": "weight_estimator",
                "name": self.name,
                "feature_set": self.feature_set,
                "encoder": self.encoder,
                "model": self.model,
                "metrics": self.metrics,
                "feature_names": self.feature_names,
            },
            path,
        )

    @classmethod
    def load(cls, path: str) -> "_SklearnEstimator":
        data = joblib.load(path)
        obj = cls(feature_set=data.get("feature_set", "full"))
        obj.encoder = data["encoder"]
        obj.model = data["model"]
        obj.metrics = data.get("metrics", {})
        obj.feature_names = data.get("feature_names", FEATURE_NAMES)
        return obj


class RidgeWeightEstimator(_SklearnEstimator):
    name = "ridge"

    def __init__(self, alpha: float = 1.0, feature_set: str = "full") -> None:
        super().__init__(feature_set)
        self.alpha = alpha

    def _make_model(self):
        return Ridge(alpha=self.alpha)


class GradientBoostingWeightEstimator(_SklearnEstimator):
    name = "gboost"

    def __init__(self, feature_set: str = "full") -> None:
        super().__init__(feature_set)

    def _make_model(self):
        return HistGradientBoostingRegressor(
            max_iter=300,
            learning_rate=0.05,
            max_depth=3,
            min_samples_leaf=5,
            l2_regularization=1.0,
            random_state=42,
        )


ESTIMATORS = {
    "ridge": RidgeWeightEstimator,
    "gboost": GradientBoostingWeightEstimator,
}


def create_estimator(algorithm: str = "ridge", feature_set: str = "full") -> _SklearnEstimator:
    if algorithm not in ESTIMATORS:
        raise ValueError(f"Algoritmo desconhecido: {algorithm}. Use 'ridge' ou 'gboost'.")
    return ESTIMATORS[algorithm](feature_set=feature_set)


def load_estimator(path: str) -> _SklearnEstimator:
    """Carrega o artefato respeitando o algoritmo salvo."""
    data = joblib.load(path)
    algorithm = data.get("name", "ridge")
    cls = ESTIMATORS.get(algorithm, RidgeWeightEstimator)
    return cls.load(path)


def format_interval(weight: float, half_width: float) -> Tuple[float, float, float]:
    """Arredonda para o padrão de exibição do app: 412 kg ± 25 kg."""
    weight = round(float(weight), 1)
    half = round(float(half_width), 1)
    return weight, round(weight - half, 1), round(weight + half, 1)
