"""Modelos ORM (SQLAlchemy 2).

Decisão: todas as chaves primárias são UUID gerados pelo CLIENTE quando
possível. Isso permite coleta offline (fila no IndexedDB) e sincronização
idempotente: reenviar a mesma foto/pesagem não duplica registros.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class CapturePoint(Base):
    """Perfil do "ponto de captura": posição fixa da câmera.

    Trocar distância/altura invalida a comparação entre fotos, por isso
    cada foto é sempre ligada a um perfil aqui.
    """

    __tablename__ = "capture_points"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    device_model: Mapped[Optional[str]] = mapped_column(String(120))
    distance_cm: Mapped[float] = mapped_column(Float, nullable=False)
    camera_height_cm: Mapped[float] = mapped_column(Float, nullable=False)
    notes: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    photos: Mapped[list["Photo"]] = relationship(back_populates="capture_point")
    weighings: Mapped[list["Weighing"]] = relationship(back_populates="capture_point")


class Animal(Base):
    """Cadastro do animal (brinco/ID, raça, sexo, categoria...)."""

    __tablename__ = "animals"
    __table_args__ = (UniqueConstraint("ear_tag", name="uq_animal_ear_tag"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    ear_tag: Mapped[str] = mapped_column(String(60), nullable=False, index=True)
    breed: Mapped[Optional[str]] = mapped_column(String(60))
    sex: Mapped[Optional[str]] = mapped_column(String(20))  # macho | femea
    category: Mapped[Optional[str]] = mapped_column(String(30))
    # bezerro | novilha | vaca | boi (aberto, para Cabanha/EAD acontecer)
    age_months: Mapped[Optional[int]] = mapped_column(Integer)
    bcs: Mapped[Optional[float]] = mapped_column(Float)  # escore 1-9 (opacional)
    notes: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    weighings: Mapped[list["Weighing"]] = relationship(back_populates="animal")
    photos: Mapped[list["Photo"]] = relationship(back_populates="animal")


class Weighing(Base):
    """Registro de pesagem real na balança + condições da sessão."""

    __tablename__ = "weighings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    animal_id: Mapped[str] = mapped_column(ForeignKey("animals.id"), nullable=False, index=True)
    capture_point_id: Mapped[Optional[str]] = mapped_column(ForeignKey("capture_points.id"))
    weight_kg: Mapped[float] = mapped_column(Float, nullable=False)
    weighed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)
    light_condition: Mapped[Optional[str]] = mapped_column(String(40))  # sol | sombra | artificial...
    time_of_day: Mapped[Optional[str]] = mapped_column(String(20))  # manha | tarde | noite
    fasting: Mapped[Optional[bool]] = mapped_column(Boolean)  # jejum ou não
    notes: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    animal: Mapped[Animal] = relationship(back_populates="weighings")
    capture_point: Mapped[Optional[CapturePoint]] = relationship(back_populates="weighings")
    photos: Mapped[list["Photo"]] = relationship(
        back_populates="weighing", cascade="all, delete-orphan"
    )


class Photo(Base):
    """Foto de uma sessão de pesagem, com metadados e sensores (JSONB)."""

    __tablename__ = "photos"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    weighing_id: Mapped[str] = mapped_column(ForeignKey("weighings.id"), nullable=False, index=True)
    animal_id: Mapped[str] = mapped_column(ForeignKey("animals.id"), nullable=False, index=True)
    capture_point_id: Mapped[Optional[str]] = mapped_column(ForeignKey("capture_points.id"))

    file_path: Mapped[str] = mapped_column(String(500), nullable=False, unique=True)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    width: Mapped[Optional[int]] = mapped_column(Integer)
    height: Mapped[Optional[int]] = mapped_column(Integer)

    # Leituras brutas + disponibilidade de cada sensor (interface única).
    sensors: Mapped[Dict[str, Any]] = mapped_column(JSONB, default=dict)
    # Resultado da análise de qualidade (blur, brilho, cortes, avisos).
    quality: Mapped[Dict[str, Any]] = mapped_column(JSONB, default=dict)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    weighing: Mapped[Weighing] = relationship(back_populates="photos")
    animal: Mapped[Animal] = relationship(back_populates="photos")
    capture_point: Mapped[Optional[CapturePoint]] = relationship(back_populates="photos")


class ModelVersion(Base):
    """Versão treinada do estimador (Fase 2), com métricas da validação."""

    __tablename__ = "model_versions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    version: Mapped[str] = mapped_column(String(60), nullable=False, index=True)
    algorithm: Mapped[str] = mapped_column(String(60), nullable=False)  # ridge | gboost
    artifact_path: Mapped[str] = mapped_column(String(500), nullable=False)
    metrics: Mapped[Dict[str, Any]] = mapped_column(JSONB, default=dict)
    feature_names: Mapped[list] = mapped_column(JSONB, default=list)
    n_animals: Mapped[int] = mapped_column(Integer, default=0)
    n_photos: Mapped[int] = mapped_column(Integer, default=0)
    active: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    trained_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Passage(Base):
    """Passagem de um animal em frente à câmera fixa ("modo passagem").

    Cada passagem junta vários quadros capturados automaticamente; o peso
    final é a mediana das estimativas dos quadros válidos. Os quadros ficam
    salvos em disco mesmo sem modelo ativo, para reestimar depois.
    """

    __tablename__ = "passages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    # fixed = celular fixo no corredor | handheld = celular na mão (sem ponto)
    mode: Mapped[str] = mapped_column(String(20), nullable=False, default="fixed", server_default="fixed")
    capture_point_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("capture_points.id"), nullable=True, index=True
    )
    animal_id: Mapped[Optional[str]] = mapped_column(ForeignKey("animals.id"), index=True)
    # Categoria escolhida antes da foto (usada quando o animal não tem cadastro).
    category: Mapped[Optional[str]] = mapped_column(String(30))
    ear_tag: Mapped[Optional[str]] = mapped_column(String(60), index=True)
    lot: Mapped[Optional[str]] = mapped_column(String(60), index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)
    ended_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    # estimated | pending_model | failed
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending_model", index=True)
    message: Mapped[Optional[str]] = mapped_column(Text)
    weight_kg: Mapped[Optional[float]] = mapped_column(Float)
    weight_min_kg: Mapped[Optional[float]] = mapped_column(Float)
    weight_max_kg: Mapped[Optional[float]] = mapped_column(Float)
    interval_half_width_kg: Mapped[Optional[float]] = mapped_column(Float)
    # Dispersão entre os quadros (desvio robusto) — alto = estimativa instável.
    frame_spread_kg: Mapped[Optional[float]] = mapped_column(Float)
    n_frames: Mapped[int] = mapped_column(Integer, default=0)
    n_frames_used: Mapped[int] = mapped_column(Integer, default=0)
    model_version: Mapped[Optional[str]] = mapped_column(String(60))
    estimated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    # Retorno do produtor: "Saiu como esperado?" -> ok | low (achou baixo) | high (achou alto)
    feedback: Mapped[Optional[str]] = mapped_column(String(20), index=True)
    feedback_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    animal: Mapped[Optional[Animal]] = relationship()
    capture_point: Mapped[Optional[CapturePoint]] = relationship()
    frames: Mapped[list["PassageFrame"]] = relationship(
        back_populates="passage",
        cascade="all, delete-orphan",
        order_by="PassageFrame.captured_at",
    )


class PassageFrame(Base):
    """Quadro capturado automaticamente durante uma passagem."""

    __tablename__ = "passage_frames"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    passage_id: Mapped[str] = mapped_column(
        ForeignKey("passages.id", ondelete="CASCADE"), nullable=False, index=True
    )
    file_path: Mapped[str] = mapped_column(String(500), nullable=False, unique=True)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    width: Mapped[Optional[int]] = mapped_column(Integer)
    height: Mapped[Optional[int]] = mapped_column(Integer)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    # Métricas do detector no celular (posição, nitidez, movimento...).
    detection: Mapped[Dict[str, Any]] = mapped_column(JSONB, default=dict)
    quality: Mapped[Dict[str, Any]] = mapped_column(JSONB, default=dict)
    weight_kg: Mapped[Optional[float]] = mapped_column(Float)
    used: Mapped[bool] = mapped_column(Boolean, default=False)
    error: Mapped[Optional[str]] = mapped_column(Text)

    passage: Mapped[Passage] = relationship(back_populates="frames")
