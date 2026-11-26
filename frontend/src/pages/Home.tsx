import { useCallback, useEffect, useState } from "react";
import { api, apiError } from "../api";
import PageHeader from "../components/PageHeader";
import { formatNumber } from "../lib/format";
import { cacheGet } from "../lib/queue";
import { APP_NAME } from "../lib/brand";
import type { CapturePoint, DashboardStats } from "../types";

export default function Home() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasPoint, setHasPoint] = useState(() => cacheGet<CapturePoint[]>("capturePoints", []).length > 0);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api.listCapturePoints()
      .then((list) => list.length > 0 && setHasPoint(true))
      .catch(() => undefined);
    api.dashboard()
      .then(setStats)
      .catch((e) => setError(apiError(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const animals = stats?.total_animals ?? 0;
  const weighings = stats?.total_weighings ?? 0;
  const modelActive = Boolean(stats?.model_status.active);

  return (
    <div>
      <PageHeader title="Início" description={`Resumo do rebanho e próximos passos no ${APP_NAME}.`} />

      {loading && (
        <p className="card" role="status">
          Carregando resumo…
        </p>
      )}

      {error && !loading && (
        <div className="alert alert-warn" role="alert">
          <strong>Não foi possível falar com o servidor.</strong>
          Você pode continuar coletando: tudo fica salvo no celular e é enviado quando a conexão voltar.
          <div style={{ marginTop: 8 }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={load}>
              Tentar de novo
            </button>
          </div>
          <details style={{ marginTop: 6 }}>
            <summary className="small">Detalhe técnico</summary>
            <p className="small muted" style={{ margin: 0 }}>{error}</p>
          </details>
        </div>
      )}

      <section className="card" aria-labelledby="como-funciona">
        <h2 id="como-funciona" className="card-title" style={{ margin: 0 }}>
          Como funciona
        </h2>
        <ol style={{ margin: "8px 0 0", paddingLeft: 20, display: "grid", gap: 8 }}>
          <Step done={hasPoint} href="#/pontos" label="Cadastre o ponto de captura">
            onde o celular fica fixo (tripé ou suporte), com distância e altura.
          </Step>
          <Step done={animals > 0} href="#/animais" label="Cadastre os animais">
            pelo número do brinco.
          </Step>
          <Step done={weighings >= 30} href="#/coletar" label="Colete com balança">
            pese na balança e tire as fotos. O app aprende com essas pesagens (meta: 30 animais).
          </Step>
          <Step done={modelActive} href="#/passagem" label="Pese sem balança">
            com o modelo treinado, o celular estima o peso de cada animal que passa. Sem corredor?{" "}
            <a href="#/na-mao">Pese com o celular na mão</a>.
          </Step>
        </ol>
      </section>

      {stats && (
        <>
          <section className="card" aria-labelledby="resumo">
            <h2 id="resumo" className="card-title" style={{ margin: 0 }}>
              Resumo
            </h2>
            <dl style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, margin: "8px 0 0" }}>
              <StatCard label="Animais" value={stats.total_animals} />
              <StatCard label="Pesagens" value={stats.total_weighings} />
              <StatCard label="Fotos" value={stats.total_photos} />
            </dl>
          </section>

          <section className="card" aria-labelledby="dist">
            <h2 id="dist" className="card-title" style={{ margin: 0 }}>
              Pesagens por faixa de peso
            </h2>
            <ul className="list">
              {stats.weights.map((b) => (
                <li key={b.label}>
                  <span style={{ minWidth: 110, fontSize: "0.9rem" }}>{b.label}</span>
                  <div
                    aria-hidden="true"
                    style={{ flex: 1, height: 14, background: "#e8f5e9", borderRadius: 8, overflow: "hidden" }}
                  >
                    <div
                      style={{
                        width: `${Math.min(100, (b.count / Math.max(1, stats.total_weighings)) * 100)}%`,
                        height: "100%",
                        background: "var(--primary)",
                      }}
                    />
                  </div>
                  <span style={{ minWidth: 36, textAlign: "right", fontWeight: 700 }}>{b.count}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="card" aria-labelledby="avisos">
            <h2 id="avisos" className="card-title" style={{ margin: 0 }}>
              Avisos
            </h2>
            {stats.warnings.length === 0 ? (
              <p className="small" style={{ color: "var(--success)", marginBottom: 0 }}>
                ✓ Nenhum problema encontrado na coleta.
              </p>
            ) : (
              <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                {stats.warnings.map((w, i) => (
                  <li key={i} className="small" style={{ marginBottom: 6 }}>
                    {w}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-labelledby="modelo">
            <h2 id="modelo" className="card-title" style={{ margin: 0 }}>
              Estimativa de peso
            </h2>
            <p className="small" style={{ margin: "8px 0 0" }}>
              {stats.model_status.active ? (
                <>
                  <span className="badge badge-ok">Ligada</span>{" "}
                  {stats.model_status.active.metrics.mae_kg != null &&
                    `Erro médio esperado: cerca de ${stats.model_status.active.metrics.mae_kg.toFixed(0)} kg.`}
                </>
              ) : (
                <>
                  <span className="badge badge-neutral">Ainda não disponível</span>{" "}
                  {stats.model_status.reason}
                </>
              )}
            </p>
            <a href="#/painel" className="btn btn-ghost btn-sm" style={{ marginTop: 4, paddingLeft: 0 }}>
              Ver painel completo →
            </a>
          </section>
        </>
      )}
    </div>
  );
}

function Step({ done, href, label, children }: { done: boolean; href: string; label: string; children: React.ReactNode }) {
  return (
    <li>
      <a href={href} style={{ fontWeight: 700 }}>
        {label}
      </a>
      {done && (
        <span className="badge badge-ok" style={{ marginLeft: 6 }}>
          ✓ feito
        </span>
      )}
      <div className="small muted">{children}</div>
    </li>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column-reverse",
        textAlign: "center",
        padding: "12px 4px",
        background: "#f7fbf2",
        borderRadius: 10,
      }}
    >
      <dt className="small muted">{label}</dt>
      <dd style={{ margin: 0, fontSize: "1.7rem", fontWeight: 800, color: "var(--primary-dark)" }}>
        {formatNumber(value, 0)}
      </dd>
    </div>
  );
}
