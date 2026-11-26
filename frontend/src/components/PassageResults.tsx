/**
 * Lista de resultados de pesagem sem balança (modo passagem e modo na mão):
 * peso com faixa, arrobas de carcaça e "Saiu como esperado?".
 */
import { useState, type CSSProperties } from "react";
import { api, apiError } from "../api";
import { CATEGORY_LABELS, carcassArrobas, formatDateTime, formatNumber } from "../lib/format";
import { localSettings } from "../lib/queue";
import { showToast } from "../lib/toast";
import type { Passage, PassageFeedback } from "../types";

export interface QueuedPassageSummary {
  id: string;
  startedAt: string;
  earTag: string | null;
  frames: number;
}

interface PassageResultsProps {
  history: Passage[];
  queued: QueuedPassageSummary[];
  onChanged: (updated: Passage) => void;
  emptyText?: string;
}

const STATUS_LABEL: Record<string, string> = {
  estimated: "estimado",
  pending_model: "aguardando modelo",
  failed: "não foi possível",
};

const FEEDBACK_OPTIONS: { value: PassageFeedback; label: string }[] = [
  { value: "ok", label: "Sim" },
  { value: "low", label: "Achei baixo" },
  { value: "high", label: "Achei alto" },
];

const subStyle: CSSProperties = { fontSize: "0.85rem", color: "var(--text-muted)" };

export default function PassageResults({ history, queued, onChanged, emptyText }: PassageResultsProps) {
  const yieldPct = localSettings.carcassYield;

  return (
    <ul className="list">
      {queued.map((q) => (
        <li key={q.id}>
          <div>
            <div style={{ fontWeight: 600 }}>Salvo no celular</div>
            <div style={subStyle}>
              {formatDateTime(q.startedAt)} · {q.earTag ? `brinco ${q.earTag}` : "sem brinco"} · {q.frames} foto(s)
            </div>
          </div>
          <span className="badge badge-neutral">aguardando envio</span>
        </li>
      ))}
      {history.map((p) => (
        <ResultItem key={p.id} passage={p} yieldPct={yieldPct} onChanged={onChanged} />
      ))}
      {history.length === 0 && queued.length === 0 && (
        <li className="small muted">{emptyText ?? "Nenhum animal pesado ainda."}</li>
      )}
    </ul>
  );
}

function ResultItem({
  passage: p,
  yieldPct,
  onChanged,
}: {
  passage: Passage;
  yieldPct: number;
  onChanged: (updated: Passage) => void;
}) {
  const [saving, setSaving] = useState(false);

  async function answer(value: PassageFeedback) {
    const next = p.feedback === value ? null : value;
    setSaving(true);
    try {
      onChanged(await api.setPassageFeedback(p.id, next));
      if (next) showToast("Obrigado! Sua resposta ajuda a melhorar a estimativa.", "success");
    } catch (e) {
      showToast(`Não foi possível salvar a resposta: ${apiError(e)}`, "error");
    } finally {
      setSaving(false);
    }
  }

  const estimated = p.status === "estimated" && p.weight_kg !== null;
  const details = [
    formatDateTime(p.started_at),
    p.ear_tag ? `brinco ${p.ear_tag}` : "sem brinco",
    p.category ? CATEGORY_LABELS[p.category] ?? p.category : null,
    p.lot,
    p.mode === "handheld" ? "na mão" : null,
    `${p.n_frames_used} de ${p.n_frames} fotos usadas`,
  ].filter(Boolean);

  return (
    <li style={{ display: "block" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: "1.1rem" }}>
            {estimated
              ? `${p.weight_kg!.toFixed(0)} kg ± ${(p.interval_half_width_kg ?? 0).toFixed(0)}`
              : "Peso ainda não calculado"}
          </div>
          {estimated && (
            <div style={{ fontWeight: 600, color: "var(--primary-dark)" }}>
              ≈ {formatNumber(carcassArrobas(p.weight_kg!, yieldPct), 1)} @ de carcaça
              <span style={{ ...subStyle, fontWeight: 400 }}>
                {" "}
                ({formatNumber(carcassArrobas(p.weight_min_kg ?? p.weight_kg!, yieldPct), 1)} a{" "}
                {formatNumber(carcassArrobas(p.weight_max_kg ?? p.weight_kg!, yieldPct), 1)} @ · rendimento{" "}
                {formatNumber(yieldPct, 1)}%)
              </span>
            </div>
          )}
          <div style={subStyle}>{details.join(" · ")}</div>
          {p.message && <div style={{ ...subStyle, color: "var(--warning)" }}>{p.message}</div>}
        </div>
        <span className={`badge ${p.status === "estimated" ? "badge-ok" : p.status === "failed" ? "badge-danger" : "badge-neutral"}`}>
          {STATUS_LABEL[p.status] ?? p.status}
        </span>
      </div>
      {estimated && (
        <div style={{ marginTop: 8 }}>
          <span id={`fb-${p.id}`} className="small" style={{ fontWeight: 600 }}>
            Saiu como esperado?
          </span>
          <div className="chip-group" role="group" aria-labelledby={`fb-${p.id}`} style={{ marginTop: 4 }}>
            {FEEDBACK_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className="chip"
                aria-pressed={p.feedback === opt.value}
                disabled={saving}
                onClick={() => void answer(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </li>
  );
}
