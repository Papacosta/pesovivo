"""Testes da distância pela geometria do chão (foto na mão)."""
import math

import numpy as np
import pytest

from app.services.geometry import (
    DEFAULT_FOCAL_EQ_MM,
    GeometryError,
    focal_length_px,
    geometry_from_mask,
    ground_geometry,
)

W, H = 1080, 1920  # foto em pé (retrato)


def cam(beta, gamma=0.0, **kw):
    return {"beta": beta, "gamma": gamma, "screen_angle": 0, "zoom": 1.0, "phone_height_cm": 140.0, **kw}


def test_cascos_no_centro_da_foto():
    # Celular em pé inclinado 10° para baixo: o centro da foto desce 10°.
    g = ground_geometry(hoof_x=W / 2, hoof_y=H / 2, image_width=W, image_height=H, camera=cam(80.0))
    assert g.depression_deg == pytest.approx(10.0, abs=1e-6)
    assert g.ground_distance_cm == pytest.approx(140.0 / math.tan(math.radians(10.0)))
    assert abs(g.roll_deg) < 1e-6


def test_cascos_abaixo_do_centro_somam_angulo():
    f = focal_length_px(W, H)
    dv = f * math.tan(math.radians(5.0))
    g = ground_geometry(hoof_x=W / 2, hoof_y=H / 2 + dv, image_width=W, image_height=H, camera=cam(85.0))
    assert g.depression_deg == pytest.approx(10.0, abs=1e-6)


def test_zoom_nao_muda_a_distancia_quando_o_animal_e_o_mesmo():
    # Mesmo ângulo dos cascos: com zoom 3× o deslocamento em pixels triplica.
    f1 = focal_length_px(W, H, zoom=1.0)
    f3 = focal_length_px(W, H, zoom=3.0)
    assert f3 == pytest.approx(3 * f1)
    dv1 = f1 * math.tan(math.radians(2.0))
    dv3 = f3 * math.tan(math.radians(2.0))
    g1 = ground_geometry(hoof_x=W / 2, hoof_y=H / 2 + dv1, image_width=W, image_height=H, camera=cam(86.0, zoom=1.0))
    g3 = ground_geometry(hoof_x=W / 2, hoof_y=H / 2 + dv3, image_width=W, image_height=H, camera=cam(86.0, zoom=3.0))
    assert g1.ground_distance_cm == pytest.approx(g3.ground_distance_cm)
    # Com zoom cada pixel vale menos centímetros.
    assert g3.cm_per_px == pytest.approx(g1.cm_per_px / 3)


def test_celular_deitado():
    # Paisagem: beta ~ 0 e gamma perto de ±90; o eixo da câmera desce 10°.
    c = {"beta": 0.0, "gamma": -80.0, "screen_angle": 90, "zoom": 1.0, "phone_height_cm": 140.0}
    g = ground_geometry(hoof_x=H / 2, hoof_y=W / 2, image_width=H, image_height=W, camera=c)
    assert g.depression_deg == pytest.approx(10.0, abs=1e-6)
    assert abs(g.roll_deg) < 1e-6


def test_altura_do_celular_escala_a_distancia():
    g140 = ground_geometry(hoof_x=W / 2, hoof_y=H / 2, image_width=W, image_height=H, camera=cam(80.0))
    g160 = ground_geometry(
        hoof_x=W / 2, hoof_y=H / 2, image_width=W, image_height=H, camera=cam(80.0, phone_height_cm=160.0)
    )
    assert g160.ground_distance_cm / g140.ground_distance_cm == pytest.approx(160 / 140)


@pytest.mark.parametrize(
    "camera, msg",
    [
        ({"beta": None, "gamma": None}, "ângulo"),
        (cam(90.5), "longe"),          # olhando quase no horizonte
        (cam(30.0), "perto"),          # apontando para o chão
        (cam(45.0, gamma=-70.0), "torto"),  # imagem girada ~43°
    ],
)
def test_fotos_que_nao_servem(camera, msg):
    with pytest.raises(GeometryError, match=msg):
        ground_geometry(hoof_x=W / 2, hoof_y=H / 2, image_width=W, image_height=H, camera=camera)


def test_geometria_pela_mascara():
    mask = np.zeros((H, W), dtype=bool)
    mask[800:960, 200:880] = True  # cascos na linha ~959 (centro = 960)
    g = geometry_from_mask(mask, cam(80.0))
    assert g.depression_deg == pytest.approx(10.0, abs=0.05)


def test_lente_padrao():
    assert focal_length_px(1920, 1080) == pytest.approx(1920 * DEFAULT_FOCAL_EQ_MM / 34.6)
