/**
 * Topo da tela Pesar: escolha grande entre "Na mão" e "No corredor".
 * O app lembra a escolha e, ao abrir, vai direto para ela.
 * Sem modelo treinado, avisa que o peso só sai depois da coleta com balança.
 */
import { useEffect, useState } from "react";
import { api } from "../api";
import { cacheGet, cacheSet, localSettings } from "../lib/queue";

type Mode = "na-mao" | "passagem";

const OPTIONS: { mode: Mode; label: string; hint: string }[] = [
  { mode: "na-mao", label: "Na mão", hint: "no pasto, de longe" },
  { mode: "passagem", label: "No corredor", hint: "celular no tripé" },
];

export default function WeighModeBar({ current }: { current: Mode }) {
  // null = ainda não se sabe (sem internet e sem leitura anterior).
  const [modelActive, setModelActive] = useState<boolean | null>(() => cacheGet<boolean | null>("modelActive", null));

  useEffect(() => {
    localSettings.weighMode = current;
  }, [current]);

  useEffect(() => {
    api
      .modelStatus()
      .then((s) => {
        const active = Boolean(s.active);
        setModelActive(active);
        cacheSet("modelActive", active);
      })
      .catch(() => undefined);
  }, []);

  return (
    <>
      <nav className="mode-switch" aria-label="Modo de pesar">
        {OPTIONS.map((o) => (
          <a
            key={o.mode}
            href={`#/${o.mode}`}
            className="mode-option"
            aria-current={o.mode === current ? "page" : undefined}
          >
            <span className="mode-label">{o.label}</span>
            <span className="mode-hint">{o.hint}</span>
          </a>
        ))}
      </nav>
      {modelActive === false && (
        <div className="alert alert-warn" role="note" style={{ marginTop: 10 }}>
          <strong>O peso ainda não sai na hora</strong>
          O app ainda está aprendendo: as fotos ficam guardadas e o peso é calculado depois que 30 animais forem pesados
          na balança.
          <div style={{ marginTop: 8 }}>
            <a className="btn btn-secondary btn-sm" href="#/coletar">
              Ir para Coletar com balança
            </a>
          </div>
        </div>
      )}
    </>
  );
}
