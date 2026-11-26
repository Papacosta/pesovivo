import { useEffect, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from "recharts";
import { api, apiError } from "../api";
import { showToast } from "../lib/toast";
import { cacheGet } from "../lib/queue";
import type { CapturePoint, DashboardStats } from "../types";
import PageHeader from "../components/PageHeader";

const COLORS = ["#2e7d32", "#43a047", "#66bb6a", "#9ccc65", "#c0ca33", "#ffb300", "#f4511e", "#6d4c41"];

export default function Painel() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [training, setTraining] = useState(false);

  useEffect(() => {
    api.dashboard().then(setStats).catch((e) => setError(apiError(e)));
  }, []);

  if (error || !stats) {
    return (
      <div>
        <PageHeader title="Painel" />
        {error ? (
          <div className="alert alert-warn" role="alert">
            <strong>Não foi possível carregar o painel.</strong>
            O painel precisa de conexão com o servidor. Verifique a internet e tente de novo.
            <details style={{ marginTop: 6 }}>
              <summary className="small">Detalhe técnico</summary>
              <p className="small muted" style={{ margin: 0 }}>{error}</p>
            </details>
          </div>
        ) : (
          <p className="card" role="status">Carregando painel…</p>
        )}
      </div>
    );
  }

  const weightData = stats.weights;

  const breedData = Object.entries(stats.by_breed).map(([label, value]) => ({ name: label, value }));

  async function handleTrain(algorithm: "ridge" | "gboost") {
    if (stats?.model_status.active && !confirm("Treinar uma nova versão do modelo? A versão atual continua no histórico e pode ser reativada.")) return;
    setTraining(true);
    try {
      const res = await api.train(algorithm);
      showToast(res.message, "success");
      const updated = await api.dashboard();
      setStats(updated);
    } catch (e) {
      showToast(apiError(e), "error");
    } finally {
      setTraining(false);
    }
  }

  const m = stats.model_status.active?.metrics;

  const total = weightData.reduce((acc, b) => acc + b.count, 0);

  return (
    <div>
      <PageHeader title="Painel" description="Andamento da coleta e qualidade do modelo de estimativa." />

      {!stats.model_status.active && (
        <section className="card" aria-labelledby="pn-passos">
          <h2 id="pn-passos" className="card-title" style={{ margin: 0 }}>Primeiros passos</h2>
          <p className="small muted" style={{ margin: "4px 0 0" }}>
            Some daqui quando o primeiro modelo for treinado.
          </p>
          <ol style={{ margin: "8px 0 0", paddingLeft: 20, display: "grid", gap: 8 }}>
            <Step done={cacheGet<CapturePoint[]>("capturePoints", []).length > 0} href="#/pontos" label="Cadastre o ponto de captura">
              onde o celular fica fixo (tripé ou suporte) na coleta com balança, com distância e altura.
            </Step>
            <Step done={stats.total_animals > 0} href="#/animais" label="Cadastre os animais">
              pelo número do brinco.
            </Step>
            <Step
              done={stats.total_animals >= stats.min_animals_for_model}
              href="#/coletar"
              label="Colete com balança"
            >
              pese na balança e tire as fotos. O app aprende com essas pesagens (mínimo {stats.min_animals_for_model} animais).
            </Step>
            <Step done={false} href="#pn-modelo" label="Treine o modelo">
              aqui no Painel. Depois disso, a tela Pesar mostra o peso na hora, na mão ou no corredor.
            </Step>
          </ol>
        </section>
      )}

      <section className="card" aria-labelledby="pn-metas">
        <h2 id="pn-metas" className="card-title" style={{ marginTop: 0 }}>Metas de coleta</h2>
        <div style={{ display: "grid", gap: 12, marginTop: 10 }}>
          <Progress label="Mínimo para treinar o modelo" current={stats.total_animals} target={stats.min_animals_for_model} />
          <Progress label="Recomendado para boa precisão" current={stats.total_animals} target={100} />
        </div>
      </section>

      <section className="card" aria-labelledby="pn-hist">
        <h2 id="pn-hist" className="card-title" style={{ marginTop: 0 }}>Pesagens por faixa de peso</h2>
        <div aria-hidden="true">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={weightData} margin={{ left: -20, right: 10 }}>
              <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={0} angle={-20} textAnchor="end" height={60} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
              <Tooltip formatter={(v) => [`${v} animais`, ""]} />
              <Bar dataKey="count" fill="var(--primary)" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <table className="sr-only">
          <caption>Pesagens por faixa de peso ({total} no total)</caption>
          <thead>
            <tr><th scope="col">Faixa</th><th scope="col">Pesagens</th></tr>
          </thead>
          <tbody>
            {weightData.map((b) => (
              <tr key={b.label}><td>{b.label}</td><td>{b.count}</td></tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card" aria-labelledby="pn-raca">
        <h2 id="pn-raca" className="card-title" style={{ marginTop: 0 }}>Animais por raça</h2>
        {breedData.length === 0 ? (
          <p className="small muted">Sem dados ainda.</p>
        ) : (
          <>
            <div aria-hidden="true">
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={breedData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={36} outerRadius={62} label>
                    {breedData.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Legend wrapperStyle={{ fontSize: "0.85rem" }} />
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <ul className="sr-only">
              {breedData.map((b) => (
                <li key={b.name}>{b.name}: {b.value}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="card" aria-labelledby="pn-modelo">
        <h2 id="pn-modelo" className="card-title" style={{ marginTop: 0 }}>Modelo de estimativa</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <span className={`badge ${stats.model_status.active ? "badge-ok" : "badge-neutral"}`}>
            {stats.model_status.active ? `Versão ${stats.model_status.active.version} em uso` : "Nenhum modelo em uso"}
          </span>
          <span className="badge badge-neutral">
            {stats.model_status.animals_with_photos} de {stats.min_animals_for_model} animais com foto
          </span>
        </div>
        {stats.model_status.reason && <p className="small muted" style={{ marginTop: 8 }}>{stats.model_status.reason}</p>}
        {m && (
          <dl className="small" style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", marginTop: 10 }}>
            <dt>Erro médio</dt>
            <dd style={{ margin: 0 }}><strong>{m.mae_kg?.toFixed(1)} kg</strong> ({m.mape_pct?.toFixed(1)}% do peso)</dd>
            <dt>Tendência</dt>
            <dd style={{ margin: 0 }}>
              {m.bias_kg == null ? "—" : m.bias_kg > 0 ? `estima ${m.bias_kg.toFixed(1)} kg a mais, em média` : `estima ${Math.abs(m.bias_kg).toFixed(1)} kg a menos, em média`}
            </dd>
            <dt>Margem mostrada</dt>
            <dd style={{ margin: 0 }}>± {m.interval_half_width_kg} kg</dd>
          </dl>
        )}
        <button
          type="button"
          className="btn btn-primary btn-block"
          style={{ marginTop: 12 }}
          disabled={training || !stats.model_status.can_train}
          aria-describedby="treino-ajuda"
          onClick={() => handleTrain("ridge")}
        >
          {training ? "Treinando… (pode levar alguns minutos)" : stats.model_status.active ? "Treinar nova versão" : "Treinar modelo"}
        </button>
        <p id="treino-ajuda" className="small muted" style={{ margin: "6px 0 0" }}>
          {stats.model_status.can_train
            ? "Use depois de coletar novas pesagens com balança."
            : `Disponível a partir de ${stats.min_animals_for_model} animais com foto.`}
        </p>
        <details style={{ marginTop: 8 }}>
          <summary className="small">Opções avançadas</summary>
          <p className="small muted" style={{ marginTop: 0 }}>
            O treino padrão usa regressão Ridge (validação cruzada por animal, {m?.n_folds ?? "5"} partes). Com muitos
            dados, o Gradient Boosting pode errar menos.
          </p>
          <button
            type="button"
            className="btn btn-secondary btn-block"
            disabled={training || !stats.model_status.can_train}
            onClick={() => handleTrain("gboost")}
          >
            Treinar com Gradient Boosting
          </button>
        </details>
        <a href="#/modelo" className="btn btn-secondary btn-block" style={{ marginTop: 8 }}>
          Estimar uma foto e ver histórico →
        </a>
      </section>

      <section className="card" aria-labelledby="pn-avisos">
        <h2 id="pn-avisos" className="card-title" style={{ marginTop: 0 }}>Avisos da coleta</h2>
        {stats.warnings.length === 0 ? (
          <p className="small" style={{ color: "var(--success)" }}>✓ Nenhum problema encontrado.</p>
        ) : (
          <ul style={{ paddingLeft: 18 }}>
            {stats.warnings.map((w, i) => (
              <li key={i} className="small" style={{ marginBottom: 6 }}>{w}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Step({ done, href, label, children }: { done: boolean; href: string; label: string; children: React.ReactNode }) {
  return (
    <li>
      <a
        href={href}
        style={{ fontWeight: 700 }}
        onClick={(e) => {
          // Âncora dentro desta tela: rola sem trocar de tela (o app usa o # para navegar).
          if (!href.startsWith("#pn-")) return;
          e.preventDefault();
          document.getElementById(href.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
      >
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

function Progress({ label, current, target }: { label: string; current: number; target: number }) {
  const pct = Math.min(100, (current / Math.max(1, target)) * 100);
  return (
    <div>
      <div className="small" style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span>{label}</span>
        <strong>{current} de {target} animais</strong>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={target}
        aria-valuenow={Math.min(current, target)}
        style={{ height: 14, background: "#e8f5e9", borderRadius: 8, overflow: "hidden" }}
      >
        <div style={{ width: `${pct}%`, height: "100%", background: "var(--primary)" }} />
      </div>
    </div>
  );
}
