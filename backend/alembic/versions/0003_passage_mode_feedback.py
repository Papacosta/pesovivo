"""Passagens: modo na mão, categoria informada e retorno do produtor.

- `mode`: "fixed" (celular fixo no corredor) ou "handheld" (celular na mão).
  No modo na mão não há ponto de captura, então `capture_point_id` vira opcional.
- `category`: categoria escolhida antes da foto (bezerro, novilha, vaca, boi).
- `feedback`: resposta a "Saiu como esperado?" (ok | low | high).
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003_passage_mode_feedback"
down_revision: Union[str, None] = "0002_passages"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "passages",
        sa.Column("mode", sa.String(length=20), nullable=False, server_default="fixed"),
    )
    op.add_column("passages", sa.Column("category", sa.String(length=30), nullable=True))
    op.add_column("passages", sa.Column("feedback", sa.String(length=20), nullable=True))
    op.add_column("passages", sa.Column("feedback_at", sa.DateTime(timezone=True), nullable=True))
    op.alter_column("passages", "capture_point_id", existing_type=sa.String(length=36), nullable=True)
    op.create_index("ix_passages_feedback", "passages", ["feedback"])


def downgrade() -> None:
    op.drop_index("ix_passages_feedback", table_name="passages")
    op.execute("DELETE FROM passages WHERE capture_point_id IS NULL")
    op.alter_column("passages", "capture_point_id", existing_type=sa.String(length=36), nullable=False)
    op.drop_column("passages", "feedback_at")
    op.drop_column("passages", "feedback")
    op.drop_column("passages", "category")
    op.drop_column("passages", "mode")
