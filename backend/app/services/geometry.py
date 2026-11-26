"""Distância até o animal sem medir nada: geometria do chão.

Foto com o celular na mão, no pasto. A pessoa não informa a distância nem
usa objeto de referência. O que se sabe:

- a altura em que a pessoa segura o celular (ajuste feito uma vez, padrão 1,40 m);
- o ângulo do celular no instante da foto (giroscópio: beta/gamma do
  DeviceOrientation) e se a tela estava em pé ou deitada;
- o campo de visão da câmera (lente equivalente em mm × zoom);
- onde os cascos tocam o chão na foto (parte de baixo da silhueta).

Com o chão plano, o raio que sai da câmera e passa pelos cascos desce num
ângulo conhecido. Distância no chão = altura ÷ tangente desse ângulo.

Com a distância, o tamanho em pixels vira tamanho em centímetros:
cm = pixels × profundidade ÷ distância focal em pixels. É isso que permite
usar zoom (o zoom muda a distância focal, e a conta compensa).

Limites (ditos ao usuário pela faixa de erro maior):
- pasto inclinado ou animal em buraco/morro distorce a distância;
- erro de 10 cm na altura do celular ≈ 7% na distância ≈ 20% no peso,
  por isso a altura é um ajuste do aparelho e não um chute por foto.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, Optional

import numpy as np

# Lente principal típica de celular: ~26 mm equivalentes ao filme 35 mm.
DEFAULT_FOCAL_EQ_MM = 26.0
# Lado maior de um sensor 4:3 com a diagonal do filme 35 mm (43,27 mm).
SENSOR_LONG_EQ_MM = 34.6
DEFAULT_PHONE_HEIGHT_CM = 140.0

# Abaixo disso o raio dos cascos fica quase paralelo ao chão (animal longe
# demais ou celular apontando para cima do horizonte): distância instável.
MIN_DEPRESSION_DEG = 1.5
MAX_ROLL_DEG = 20.0
MAX_DISTANCE_CM = 4000.0
MIN_DISTANCE_CM = 150.0


class GeometryError(ValueError):
    """Não dá para estimar a distância com esta foto (mensagem para o usuário)."""


@dataclass
class GroundGeometry:
    ground_distance_cm: float   # distância no chão, dos pés da pessoa aos cascos
    depth_cm: float             # profundidade ao longo do eixo da câmera
    depression_deg: float       # ângulo do raio dos cascos abaixo do horizonte
    roll_deg: float             # giro do celular em torno da lente
    focal_px: float
    cm_per_px: float
    phone_height_cm: float

    def as_dict(self) -> Dict[str, float]:
        return {k: round(float(v), 3) for k, v in self.__dict__.items()}


def focal_length_px(
    image_width: int,
    image_height: int,
    focal_eq_mm: float = DEFAULT_FOCAL_EQ_MM,
    zoom: float = 1.0,
) -> float:
    """Distância focal em pixels.

    Supõe que o lado maior da imagem corresponde ao lado maior do sensor (vale
    para foto 4:3 e vídeo 16:9 recortado do sensor 4:3). Recorte digital
    (zoom por corte) reduz a imagem e aumenta o zoom na mesma proporção, então
    o resultado continua certo se `zoom` for o zoom total.
    """
    if image_width <= 0 or image_height <= 0:
        raise GeometryError("Dimensões da imagem inválidas.")
    long_px = float(max(image_width, image_height))
    return long_px * (float(focal_eq_mm) * max(float(zoom), 1e-6)) / SENSOR_LONG_EQ_MM


def _up_component(vec, beta_deg: float, gamma_deg: float) -> float:
    """Componente vertical (para cima) no mundo de um vetor nas coordenadas do aparelho.

    Convenção W3C DeviceOrientation: R = Rz(alpha)·Rx(beta)·Ry(gamma); a
    linha vertical de R não depende de alpha (bússola).
    x = direita da tela, y = topo do aparelho, z = saindo da tela.
    """
    b = math.radians(beta_deg)
    g = math.radians(gamma_deg)
    vx, vy, vz = vec
    return -math.cos(b) * math.sin(g) * vx + math.sin(b) * vy + math.cos(b) * math.cos(g) * vz


def _pixel_ray_device(du: float, dv: float, focal_px: float, screen_angle: int):
    """Raio do pixel (deslocamento du→direita, dv→baixo do centro) no referencial do aparelho.

    A câmera traseira olha para -z. O vídeo segue a orientação da tela:
    - 0°  (em pé):           direita da imagem = +x, baixo da imagem = -y
    - 90° (deitado, topo à esquerda): direita = -y, baixo = +x
    - 270° (deitado, topo à direita): direita = +y, baixo = -x
    - 180° (de cabeça para baixo):     direita = -x, baixo = +y
    """
    a = int(round(screen_angle / 90.0)) % 4 * 90
    x, y = du / focal_px, dv / focal_px
    if a == 0:
        return (x, -y, -1.0)
    if a == 90:
        return (y, -x, -1.0)
    if a == 270:
        return (-y, x, -1.0)
    return (-x, y, -1.0)


def _roll_deg(beta_deg: float, gamma_deg: float, screen_angle: int) -> float:
    """Quanto o "para baixo" da imagem está torto em relação à vertical."""
    down_img = _pixel_ray_device(0.0, 1.0, 1.0, screen_angle)
    right_img = _pixel_ray_device(1.0, 0.0, 1.0, screen_angle)
    # Só as direções (sem o -1 do eixo óptico).
    down = (down_img[0], down_img[1], 0.0)
    right = (right_img[0], right_img[1], 0.0)
    up_of_down = -_up_component(down, beta_deg, gamma_deg)
    up_of_right = _up_component(right, beta_deg, gamma_deg)
    return math.degrees(math.atan2(up_of_right, max(up_of_down, 1e-9)))


def hoof_row(mask: np.ndarray) -> float:
    """Linha (pixel) onde os cascos tocam o chão: parte de baixo da silhueta.

    Usa um percentil alto em vez do máximo para ignorar respingos da máscara.
    """
    ys = np.nonzero(mask)[0]
    if ys.size == 0:
        raise GeometryError("Silhueta vazia.")
    return float(np.percentile(ys, 99.5))


def ground_geometry(
    *,
    hoof_x: float,
    hoof_y: float,
    image_width: int,
    image_height: int,
    camera: Dict[str, Any],
) -> GroundGeometry:
    """Calcula a distância pelo ângulo do celular e pela linha dos cascos.

    `camera` vem do celular: beta, gamma (graus), screen_angle (0/90/180/270),
    zoom (total, hardware × recorte), focal_eq_mm e phone_height_cm.
    """
    beta = camera.get("beta")
    gamma = camera.get("gamma")
    if beta is None or gamma is None:
        raise GeometryError(
            "Sem o ângulo do celular nesta foto. Permita o acesso ao movimento do aparelho e tente de novo."
        )
    screen_angle = int(camera.get("screen_angle") or 0)
    zoom = float(camera.get("zoom") or 1.0)
    focal_eq = float(camera.get("focal_eq_mm") or DEFAULT_FOCAL_EQ_MM)
    height_cm = float(camera.get("phone_height_cm") or DEFAULT_PHONE_HEIGHT_CM)

    roll = _roll_deg(float(beta), float(gamma), screen_angle)
    if abs(roll) > MAX_ROLL_DEG:
        raise GeometryError("Celular muito torto na foto. Segure reto, com o horizonte na horizontal.")

    f = focal_length_px(image_width, image_height, focal_eq, zoom)
    du = hoof_x - image_width / 2.0
    dv = hoof_y - image_height / 2.0
    ray = _pixel_ray_device(du, dv, f, screen_angle)
    norm = math.sqrt(sum(c * c for c in ray))
    up = _up_component(ray, float(beta), float(gamma)) / norm
    depression = math.degrees(math.asin(max(-1.0, min(1.0, -up))))
    if depression < MIN_DEPRESSION_DEG:
        raise GeometryError(
            "Animal longe demais ou celular apontado para cima. Chegue um pouco mais perto ou use o zoom."
        )

    ground = height_cm / math.tan(math.radians(depression))
    if ground > MAX_DISTANCE_CM:
        raise GeometryError("Animal longe demais (mais de 40 m). Chegue mais perto ou use o zoom.")
    if ground < MIN_DISTANCE_CM:
        raise GeometryError("Animal perto demais. Afaste-se até o animal inteiro caber na foto.")

    slant = height_cm / math.sin(math.radians(depression))
    # Profundidade ao longo do eixo óptico (o eixo é -z; o raio tem z = -1).
    depth = slant / norm
    return GroundGeometry(
        ground_distance_cm=ground,
        depth_cm=depth,
        depression_deg=depression,
        roll_deg=roll,
        focal_px=f,
        cm_per_px=depth / f,
        phone_height_cm=height_cm,
    )


def geometry_from_mask(mask: np.ndarray, camera: Dict[str, Any]) -> GroundGeometry:
    """Atalho: acha a linha dos cascos na máscara e calcula a geometria."""
    h, w = mask.shape[:2]
    ys, xs = np.nonzero(mask)
    if ys.size == 0:
        raise GeometryError("Silhueta vazia.")
    return ground_geometry(
        hoof_x=float(xs.mean()),
        hoof_y=hoof_row(mask),
        image_width=w,
        image_height=h,
        camera=camera,
    )


def fixed_point_cm_per_px(
    distance_cm: Optional[float], image_width: int, image_height: int, zoom: float = 1.0
) -> Optional[float]:
    """Escala cm/pixel do celular fixo (distância medida no ponto de captura)."""
    if not distance_cm:
        return None
    return float(distance_cm) / focal_length_px(image_width, image_height, DEFAULT_FOCAL_EQ_MM, zoom)
