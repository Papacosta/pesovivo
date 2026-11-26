"""Modo passagem: câmera fixa, o gado passa e o app pesa sozinho.

- POST /api/passages: recebe os quadros que o celular capturou
  automaticamente durante uma passagem, salva em disco e estima o peso
  (mediana dos quadros). Idempotente pelo `passage_id` gerado no cliente.
- `mode=handheld`: celular na mão (sem ponto fixo); a faixa de erro é maior.
- PUT /api/passages/{id}/feedback: resposta a "Saiu como esperado?".
- Sem modelo ativo a passagem fica `pending_model` e pode ser reestimada
  depois com POST /api/passages/reestimate.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from ..config import settings
from ..database import get_db
from ..models import Animal, CapturePoint, Passage, PassageFrame
from ..schemas import (
    PASSAGE_MODES,
    PassageDetailOut,
    PassageFeedbackIn,
    PassageOut,
    PassageReestimateOut,
)
from ..services import image_quality as iq
from ..services.passages import estimate_passage
from ..services.storage import decode_image, photo_abs_path, save_photo
from ..utils import ensure_utc, utcnow

router = APIRouter(prefix="/api/passages", tags=["passagens"])


def _parse_dt(value: Optional[str], field: str) -> Optional[datetime]:
    if not value:
        return None
    try:
        return ensure_utc(datetime.fromisoformat(value.replace("Z", "+00:00")))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Data inválida em '{field}'.") from exc


def _clean(value: Optional[str]) -> Optional[str]:
    value = (value or "").strip()
    return value or None


def _load(db: Session, passage_id: str) -> Optional[Passage]:
    return db.scalar(
        select(Passage)
        .options(selectinload(Passage.frames), selectinload(Passage.animal))
        .where(Passage.id == passage_id)
    )


@router.post("", response_model=PassageDetailOut, status_code=201)
async def create_passage(
    frames: List[UploadFile] = File(...),
    capture_point_id: Optional[str] = Form(default=None),
    mode: str = Form(default="fixed"),
    category: Optional[str] = Form(default=None),
    passage_id: Optional[str] = Form(default=None),
    started_at: Optional[str] = Form(default=None),
    ended_at: Optional[str] = Form(default=None),
    ear_tag: Optional[str] = Form(default=None),
    lot: Optional[str] = Form(default=None),
    frames_meta: Optional[str] = Form(default=None),
    db: Session = Depends(get_db),
):
    # Idempotência da fila offline.
    if passage_id:
        existing = _load(db, passage_id)
        if existing:
            return existing

    if mode not in PASSAGE_MODES:
        raise HTTPException(status_code=422, detail="Modo inválido (use 'fixed' ou 'handheld').")
    capture_point_id = _clean(capture_point_id)
    if mode == "fixed":
        if not capture_point_id or not db.get(CapturePoint, capture_point_id):
            raise HTTPException(status_code=422, detail="Ponto de captura não encontrado.")
    elif capture_point_id and not db.get(CapturePoint, capture_point_id):
        capture_point_id = None  # na mão o ponto é só informativo
    cat = (_clean(category) or "").lower() or None
    if cat and len(cat) > 30:
        raise HTTPException(status_code=422, detail="Categoria muito longa.")
    if not frames:
        raise HTTPException(status_code=422, detail="Envie ao menos 1 quadro.")
    if len(frames) > settings.max_frames_per_passage:
        raise HTTPException(
            status_code=422,
            detail=f"Máximo de {settings.max_frames_per_passage} quadros por passagem.",
        )

    meta: list = []
    if frames_meta:
        try:
            meta = json.loads(frames_meta)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=422, detail="'frames_meta' não é JSON válido.") from exc
        if not isinstance(meta, list):
            raise HTTPException(status_code=422, detail="'frames_meta' deve ser uma lista.")

    tag = _clean(ear_tag)
    animal = db.scalar(select(Animal).where(func.lower(Animal.ear_tag) == tag.lower())) if tag else None

    passage = Passage(
        id=passage_id or str(uuid.uuid4()),
        mode=mode,
        capture_point_id=capture_point_id,
        animal_id=animal.id if animal else None,
        category=cat,
        ear_tag=tag,
        lot=_clean(lot),
        started_at=_parse_dt(started_at, "started_at") or utcnow(),
        ended_at=_parse_dt(ended_at, "ended_at"),
        status="pending_model",
        n_frames=0,
        n_frames_used=0,
        created_at=utcnow(),
    )
    passage.animal = animal

    max_bytes = settings.max_upload_mb * 1024 * 1024
    for i, upload in enumerate(frames):
        raw = await upload.read()
        if len(raw) > max_bytes:
            raise HTTPException(status_code=413, detail=f"Quadro {i + 1} maior que {settings.max_upload_mb} MB.")
        try:
            image = decode_image(raw)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=f"Quadro {i + 1}: {exc}") from exc

        info = meta[i] if i < len(meta) and isinstance(meta[i], dict) else {}
        relative_path, digest = save_photo(raw, image)
        h, w = image.shape[:2]
        passage.frames.append(
            PassageFrame(
                id=str(uuid.uuid4()),
                file_path=relative_path,
                sha256=digest,
                width=w,
                height=h,
                captured_at=_parse_dt(info.get("captured_at"), "captured_at") or passage.started_at,
                detection=info.get("detection") or {},
                quality=iq.analyze_image(image),
                used=False,
            )
        )

    passage.n_frames = len(passage.frames)
    estimate_passage(db, passage)
    db.add(passage)
    db.commit()
    return _load(db, passage.id)


@router.get("", response_model=List[PassageOut])
def list_passages(
    limit: int = 100,
    lot: Optional[str] = None,
    ear_tag: Optional[str] = None,
    capture_point_id: Optional[str] = None,
    status: Optional[str] = None,
    db: Session = Depends(get_db),
):
    stmt = select(Passage).order_by(Passage.started_at.desc()).limit(min(max(limit, 1), 1000))
    if lot:
        stmt = stmt.where(Passage.lot == lot)
    if ear_tag:
        stmt = stmt.where(func.lower(Passage.ear_tag) == ear_tag.strip().lower())
    if capture_point_id:
        stmt = stmt.where(Passage.capture_point_id == capture_point_id)
    if status:
        stmt = stmt.where(Passage.status == status)
    return db.scalars(stmt).all()


@router.post("/reestimate", response_model=PassageReestimateOut)
def reestimate_pending(limit: int = 200, db: Session = Depends(get_db)):
    """Reestima passagens sem resultado (ex.: depois do primeiro treino)."""
    ids = db.scalars(
        select(Passage.id)
        .where(Passage.status.in_(["pending_model", "failed"]))
        .order_by(Passage.started_at)
        .limit(min(max(limit, 1), 1000))
    ).all()
    estimated = 0
    for pid in ids:
        passage = _load(db, pid)
        if passage is None:
            continue
        estimate_passage(db, passage)
        db.commit()
        if passage.status == "estimated":
            estimated += 1
        elif passage.status == "pending_model":
            # Sem modelo: as demais também ficarão pendentes.
            break
    still = db.scalar(select(func.count()).select_from(Passage).where(Passage.status == "pending_model")) or 0
    return PassageReestimateOut(processed=len(ids), estimated=estimated, still_pending=int(still))


@router.get("/{passage_id}", response_model=PassageDetailOut)
def get_passage(passage_id: str, db: Session = Depends(get_db)):
    passage = _load(db, passage_id)
    if not passage:
        raise HTTPException(status_code=404, detail="Passagem não encontrada.")
    return passage


@router.post("/{passage_id}/reestimate", response_model=PassageDetailOut)
def reestimate_one(passage_id: str, db: Session = Depends(get_db)):
    passage = _load(db, passage_id)
    if not passage:
        raise HTTPException(status_code=404, detail="Passagem não encontrada.")
    estimate_passage(db, passage)
    db.commit()
    return _load(db, passage_id)


@router.put("/{passage_id}/feedback", response_model=PassageOut)
def set_feedback(passage_id: str, payload: PassageFeedbackIn, db: Session = Depends(get_db)):
    """Registra "Saiu como esperado?" (ok | low | high). `null` apaga a resposta."""
    passage = db.get(Passage, passage_id)
    if not passage:
        raise HTTPException(status_code=404, detail="Passagem não encontrada.")
    passage.feedback = payload.feedback
    passage.feedback_at = utcnow() if payload.feedback else None
    db.commit()
    db.refresh(passage)
    return passage


@router.get("/frames/{frame_id}/file")
def get_frame_file(frame_id: str, db: Session = Depends(get_db)):
    frame = db.get(PassageFrame, frame_id)
    if not frame:
        raise HTTPException(status_code=404, detail="Quadro não encontrado.")
    path = photo_abs_path(frame.file_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Arquivo ausente no disco.")
    return FileResponse(str(path), media_type="image/jpeg", filename=path.name)
