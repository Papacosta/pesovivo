/**
 * Modo passagem: o celular fica FIXO (tripé/suporte) apontado para o
 * corredor ou brete. O app aprende o fundo vazio, detecta cada animal que
 * passa, fotografa sozinho os melhores quadros e envia para estimar o peso.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiError } from "../api";
import { startCamera, stopCamera, captureFrame } from "../sensors";
import { quickQuality } from "../lib/imageQuality";
import { cacheGet, cacheSet, enqueue, localSettings, onQueueChange, queueItems, syncQueue } from "../lib/queue";
import { uuid } from "../lib/format";
import { showToast } from "../lib/toast";
import { setUnsavedWork } from "../lib/navGuard";
import PageHeader from "../components/PageHeader";
import CategoryPicker from "../components/CategoryPicker";
import PassageResults from "../components/PassageResults";
import {
  DEFAULT_DETECTOR_CONFIG,
  PassageTracker,
  analyzeFrame,
  frameScore,
  keepBest,
  toGray,
  updateBackground,
  type FrameMetrics,
  type TrackerEvent,
} from "../lib/passageDetector";
import type { CapturePoint, Passage, PassageQueuedFrame } from "../types";

const ANALYSIS_WIDTH = 160;
const TICK_MS = 100;
const CFG = DEFAULT_DETECTOR_CONFIG;

interface BestFrame extends PassageQueuedFrame {
  score: number;
}

interface WakeLockSentinelLike {
  release: () => Promise<void>;
}

type Status = "parado" | "aguardando" | "presente";

export default function Passagem() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const smallRef = useRef<HTMLCanvasElement | null>(null);

  const [points, setPoints] = useState<CapturePoint[]>(() => cacheGet<CapturePoint[]>("capturePoints", []));
  const [capturePointId, setCapturePointId] = useState<string>(localSettings.capturePointId ?? "");
  const [lot, setLot] = useState<string>(() => cacheGet<string>("passageLot", ""));
  const [category, setCategory] = useState<string>(localSettings.passageCategory);
  const [tagInput, setTagInput] = useState("");

  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<Status>("parado");
  const [metrics, setMetrics] = useState<FrameMetrics | null>(null);
  const [frameCount, setFrameCount] = useState(0);
  const [currentTag, setCurrentTag] = useState<string | null>(null);
  const [pendingTag, setPendingTag] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const [history, setHistory] = useState<Passage[]>([]);
  const [queuedPassages, setQueuedPassages] = useState<{ id: string; startedAt: string; earTag: string | null; frames: number }[]>([]);
  const [sessionCount, setSessionCount] = useState(0);

  // Estado do laço de análise (refs: não re-renderizam a cada quadro)
  const backgroundRef = useRef<Float32Array | null>(null);
  const prevGrayRef = useRef<Float32Array | null>(null);
  const trackerRef = useRef(new PassageTracker(CFG));
  const framesRef = useRef<BestFrame[]>([]);
  const capturingRef = useRef(false);
  const calibrateRef = useRef(false);
  const currentTagRef = useRef<string | null>(null);
  const pendingTagRef = useRef<string | null>(null);
  const passageIdRef = useRef<string>(uuid());
  const startedAtRef = useRef<string>(new Date().toISOString());
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const settingsRef = useRef({ capturePointId, lot, category });
  settingsRef.current = { capturePointId, lot, category };

  // ---------------- dados ----------------
  const refreshHistory = useCallback(() => {
    api.listPassages({ limit: 30 }).then(setHistory).catch(() => undefined);
    queueItems()
      .then((items) =>
        setQueuedPassages(
          items.flatMap((it) =>
            it.kind === "passage" ? [{ id: it.id, startedAt: it.startedAt, earTag: it.earTag, frames: it.frames.length }] : []
          )
        )
      )
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    api
      .listCapturePoints()
      .then((list) => {
        setPoints(list);
        cacheSet("capturePoints", list);
        setCapturePointId((cur) => cur || list[0]?.id || "");
      })
      .catch(() => undefined);
    refreshHistory();
    const off = onQueueChange(refreshHistory);
    return off;
  }, [refreshHistory]);

  useEffect(() => {
    cacheSet("passageLot", lot);
  }, [lot]);

  useEffect(() => {
    localSettings.passageCategory = category;
  }, [category]);

  // ---------------- câmera ----------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!videoRef.current) return;
      try {
        await startCamera(videoRef.current);
        if (!cancelled) setCameraReady(true);
      } catch (err) {
        if (cancelled) return;
        const name = (err as DOMException)?.name ?? "";
        setCameraError(
          name === "NotAllowedError"
            ? "Permissão da câmera negada. Habilite o acesso nas configurações do navegador."
            : `Falha ao abrir a câmera${name ? ` (${name})` : ""}. O site precisa estar em HTTPS.`
        );
      }
    })();
    return () => {
      cancelled = true;
      stopCamera();
      void wakeLockRef.current?.release().catch(() => undefined);
    };
  }, []);

  // Sair da tela com a captura ligada interrompe a pesagem: pergunta antes.
  useEffect(() => {
    setUnsavedWork(
      running ? "A pesagem automática está ligada. Sair desta tela para a captura e descarta o animal que estiver passando." : null
    );
    return () => setUnsavedWork(null);
  }, [running]);

  // ---------------- tela sempre ligada ----------------
  async function acquireWakeLock() {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<WakeLockSentinelLike> } };
    if (!nav.wakeLock) return;
    try {
      wakeLockRef.current = await nav.wakeLock.request("screen");
    } catch {
      /* sem suporte ou negado: segue sem */
    }
  }

  useEffect(() => {
    if (!running) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void acquireWakeLock();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [running]);

  // ---------------- fim de passagem ----------------
  const finishPassage = useCallback(
    async (endedAtMs: number) => {
      const frames = framesRef.current;
      const tag = currentTagRef.current;
      const passageId = passageIdRef.current;
      const startedAt = startedAtRef.current;
      framesRef.current = [];
      currentTagRef.current = null;
      setCurrentTag(null);
      setFrameCount(0);
      passageIdRef.current = uuid();

      if (frames.length < CFG.minFrames) {
        setWarning(
          frames.length === 0
            ? "Animal passou sem nenhuma foto boa (cortado na borda, longe ou borrado)."
            : `Só ${frames.length} foto boa nessa passagem — descartada (mínimo ${CFG.minFrames}).`
        );
        return;
      }
      const { capturePointId: cp, lot: currentLot, category: cat } = settingsRef.current;
      await enqueue({
        kind: "passage",
        id: passageId,
        createdAt: Date.now(),
        mode: "fixed",
        capturePointId: cp,
        category: cat || null,
        startedAt,
        endedAt: new Date(endedAtMs).toISOString(),
        earTag: tag,
        lot: currentLot.trim() || null,
        frames: [...frames]
          .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
          .map(({ blob, capturedAt, detection }) => ({ blob, capturedAt, detection })),
      });
      setSessionCount((n) => n + 1);
      setWarning(null);
      if (navigator.onLine) {
        const res = await syncQueue();
        if (res.errors.length) showToast("Passagem salva no celular. Será enviada quando a conexão voltar.", "info");
        refreshHistory();
      }
    },
    [refreshHistory]
  );

  const handleEvents = useCallback(
    (events: TrackerEvent[], m: FrameMetrics) => {
      for (const ev of events) {
        if (ev.type === "enter") {
          startedAtRef.current = new Date().toISOString();
          framesRef.current = [];
          if (pendingTagRef.current) {
            currentTagRef.current = pendingTagRef.current;
            pendingTagRef.current = null;
            setCurrentTag(currentTagRef.current);
            setPendingTag(null);
          }
          setStatus("presente");
        } else if (ev.type === "exit") {
          setStatus("aguardando");
          void finishPassage(Date.now());
        } else if (ev.type === "stuck") {
          setWarning(
            "Animal parado há muito tempo ou o fundo mudou (sombra, luz, objeto). " +
              "Se o corredor estiver vazio, toque em “Calibrar fundo”."
          );
        } else if (ev.type === "candidate" && !capturingRef.current && videoRef.current) {
          capturingRef.current = true;
          const video = videoRef.current;
          const capturedAt = new Date().toISOString();
          captureFrame(video, 0.9)
            .then((frame) => {
              const q = quickQuality(frame.canvas);
              if (q.isBlurry || q.isDark) return;
              const score = frameScore(m, q.blurScore, CFG);
              const item: BestFrame = {
                blob: frame.blob,
                capturedAt,
                score,
                detection: {
                  score: Number(score.toFixed(3)),
                  foreground: Number(m.foreground.toFixed(3)),
                  motion: Number(m.motion.toFixed(2)),
                  off_center: Number(m.offCenter.toFixed(3)),
                  box: m.box,
                  blur_score: Math.round(q.blurScore),
                  brightness: Math.round(q.brightness),
                },
              };
              framesRef.current = keepBest(framesRef.current, item, CFG.maxFrames).kept;
              setFrameCount(framesRef.current.length);
            })
            .catch(() => undefined)
            .finally(() => {
              capturingRef.current = false;
            });
        }
      }
    },
    [finishPassage]
  );

  // ---------------- laço de análise ----------------
  useEffect(() => {
    if (!running || !cameraReady) return;
    const video = videoRef.current;
    if (!video) return;
    if (!smallRef.current) smallRef.current = document.createElement("canvas");
    const small = smallRef.current;
    let lastUi = 0;

    const id = window.setInterval(() => {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;
      const w = ANALYSIS_WIDTH;
      const h = Math.max(1, Math.round((vh / vw) * w));
      if (small.width !== w || small.height !== h) {
        small.width = w;
        small.height = h;
        backgroundRef.current = null;
      }
      const ctx = small.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, w, h);
      const gray = toGray(ctx.getImageData(0, 0, w, h).data, w, h);

      if (calibrateRef.current || !backgroundRef.current) {
        // Sem fundo (início, calibração manual ou o vídeo mudou de tamanho,
        // ex.: celular girou): o quadro atual vira o fundo.
        const automatic = !calibrateRef.current;
        backgroundRef.current = gray;
        prevGrayRef.current = gray;
        calibrateRef.current = false;
        trackerRef.current.reset();
        framesRef.current = [];
        setFrameCount(0);
        setStatus("aguardando");
        setWarning(
          automatic
            ? "A imagem da câmera mudou de tamanho e o fundo foi recalibrado. Confira se o corredor está vazio."
            : null
        );
        return;
      }

      const { metrics: m } = analyzeFrame(gray, backgroundRef.current, prevGrayRef.current, w, h, CFG);
      prevGrayRef.current = gray;
      const tracker = trackerRef.current;
      const now = performance.now();
      const events = tracker.step(m, now, 200);
      // Converte o instante para relógio de parede nos eventos de saída.
      handleEvents(events, m);
      // Fundo se adapta à luz só quando o corredor está vazio.
      if (tracker.state === "idle" && m.foreground < CFG.exitFraction) {
        updateBackground(backgroundRef.current, gray, CFG.backgroundLearningRate);
      }

      if (now - lastUi > 250) {
        lastUi = now;
        setMetrics(m);
        drawOverlay(overlayRef.current, m, tracker.state === "present");
      }
    }, TICK_MS);

    return () => window.clearInterval(id);
  }, [running, cameraReady, handleEvents]);

  // ---------------- ações ----------------
  function start() {
    if (!capturePointId) {
      showToast("Escolha o ponto de captura antes de iniciar (é a posição fixa do celular).", "warning");
      document.getElementById("ps-ponto")?.focus();
      return;
    }
    localSettings.capturePointId = capturePointId;
    calibrateRef.current = true;
    trackerRef.current.reset();
    setRunning(true);
    setStatus("aguardando");
    void acquireWakeLock();
    showToast("Aprendendo o fundo com o corredor vazio… Pode soltar os animais.", "info");
  }

  function stop() {
    if (trackerRef.current.state === "present") void finishPassage(Date.now());
    trackerRef.current.reset();
    setRunning(false);
    setStatus("parado");
    drawOverlay(overlayRef.current, null, false);
    void wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
  }

  function calibrate() {
    if (trackerRef.current.state === "present" && framesRef.current.length > 0) {
      if (!window.confirm("Há um animal sendo registrado. Calibrar agora descarta essa passagem. Continuar?")) return;
    }
    calibrateRef.current = true;
  }

  function nextAnimal() {
    handleEvents(trackerRef.current.split(performance.now()), metrics ?? emptyMetrics());
  }

  function submitTag() {
    const tag = tagInput.trim();
    if (!tag) return;
    setTagInput("");
    const tracker = trackerRef.current;
    if (running && tracker.state === "present") {
      if (!currentTagRef.current) {
        currentTagRef.current = tag;
        setCurrentTag(tag);
        return;
      }
      // Já tinha brinco: é o próximo animal da fila encostado no anterior.
      pendingTagRef.current = tag;
      setPendingTag(tag);
      handleEvents(tracker.split(performance.now()), metrics ?? emptyMetrics());
      return;
    }
    pendingTagRef.current = tag;
    setPendingTag(tag);
  }

  async function reestimate() {
    try {
      const r = await api.reestimatePassages();
      showToast(
        r.estimated > 0
          ? `${r.estimated} passagem(ns) estimada(s).`
          : r.still_pending > 0
            ? "Ainda sem modelo ativo para estimar."
            : "Nada pendente.",
        r.estimated > 0 ? "success" : "info"
      );
      refreshHistory();
    } catch (e) {
      showToast(apiError(e), "error");
    }
  }

  // ---------------- render ----------------
  const statusText: Record<Status, string> = {
    parado: "Parado",
    aguardando: "Aguardando animal",
    presente: `Animal passando · ${frameCount} foto(s)`,
  };
  const statusColor = status === "presente" ? "var(--accent)" : status === "aguardando" ? "#66bb6a" : "#bdbdbd";
  const pendingCount = history.filter((p) => p.status === "pending_model").length;

  return (
    <div>
      <PageHeader
        title="Pesar animais"
        description="Deixe o celular fixo no tripé, de lado para o corredor. O app fotografa sozinho cada animal que passar e estima o peso."
      />

      <section className="card" aria-labelledby="ps-config">
        <h2 id="ps-config" className="card-title" style={{ marginTop: 0 }}>1. Antes de começar</h2>
        <div className="form-row">
          <div className="field">
            <label htmlFor="ps-ponto" className="field-label">
              Ponto de captura <span className="req">*</span>
            </label>
            {points.length === 0 ? (
              <p className="small" style={{ margin: 0 }}>
                Nenhum ponto cadastrado. <a href="#/pontos">Cadastre o ponto fixo da câmera</a> primeiro.
              </p>
            ) : (
              <select
                id="ps-ponto"
                required
                value={capturePointId}
                onChange={(e) => setCapturePointId(e.target.value)}
                disabled={running}
                aria-describedby={running ? "ps-ponto-ajuda" : undefined}
              >
                <option value="">Selecione o ponto…</option>
                {points.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.distance_cm} cm / {p.camera_height_cm} cm
                  </option>
                ))}
              </select>
            )}
            {running && (
              <span id="ps-ponto-ajuda" className="field-hint">
                Para trocar o ponto, toque em Parar.
              </span>
            )}
          </div>
          <div className="field">
            <label htmlFor="ps-lote" className="field-label">Lote</label>
            <input id="ps-lote" type="text" value={lot} onChange={(e) => setLot(e.target.value)} placeholder="Ex.: Lote 3 – engorda" aria-describedby="ps-lote-ajuda" />
            <span id="ps-lote-ajuda" className="field-hint">Opcional. Ajuda a separar os resultados.</span>
          </div>
          <CategoryPicker id="ps-cat" value={category} onChange={setCategory} />
        </div>
        <p className="small muted" style={{ margin: "10px 0 0" }}>
          Sem corredor ou tripé? <a href="#/na-mao">Pese com o celular na mão</a>.
        </p>
      </section>

      {cameraError && (
        <div className="alert alert-error" role="alert">
          <strong>Não foi possível usar a câmera.</strong>
          {cameraError}
        </div>
      )}

      <h2 className="card-title" style={{ margin: "4px 0 8px" }}>2. Captura</h2>
      <div style={{ position: "relative", borderRadius: 12, overflow: "hidden", background: "#000" }}>
        <video ref={videoRef} playsInline muted aria-label="Imagem ao vivo do corredor" style={{ width: "100%", display: "block", minHeight: 220 }} />
        <canvas
          ref={overlayRef}
          aria-hidden="true"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
        />
        <div
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            padding: "6px 12px",
            borderRadius: 999,
            background: "rgba(0,0,0,0.7)",
            color: "#fff",
            fontSize: "0.9rem",
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span aria-hidden="true" style={{ width: 12, height: 12, borderRadius: "50%", background: statusColor, display: "inline-block" }} />
          {statusText[status]}
        </div>
        {running && metrics && (
          <div aria-hidden="true" style={{ position: "absolute", bottom: 6, right: 8, color: "rgba(255,255,255,0.85)", fontSize: "0.75rem" }}>
            ocupação {(metrics.foreground * 100).toFixed(0)}% · movimento {metrics.motion.toFixed(1)}
          </div>
        )}
      </div>
      {/* Anuncia só a troca de estado (não cada foto) para leitores de tela. */}
      <p className="sr-only" aria-live="polite">
        {status === "presente" ? "Animal passando." : status === "aguardando" ? "Aguardando animal." : "Captura parada."}
      </p>

      <div className="btn-row" style={{ marginTop: 10 }}>
        {!running ? (
          <button type="button" className="btn btn-primary btn-lg" style={{ gridColumn: "1 / -1" }} onClick={start} disabled={!cameraReady}>
            ▶ Iniciar (com o corredor vazio)
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-danger btn-lg" style={{ gridColumn: "1 / -1" }} onClick={stop}>
              ■ Parar captura
            </button>
            <button type="button" className="btn btn-secondary" onClick={calibrate}>
              Recalibrar fundo
            </button>
            <button type="button" className="btn btn-secondary" onClick={nextAnimal} disabled={status !== "presente"}>
              Separar próximo animal
            </button>
          </>
        )}
      </div>
      <p className="small muted" style={{ margin: "6px 0 0" }}>
        {!cameraReady && !cameraError
          ? "Abrindo a câmera…"
          : running
            ? "Use “Separar próximo animal” quando dois animais passarem encostados."
            : "O app aprende como é o corredor vazio e depois detecta cada animal sozinho."}
      </p>

      {warning && (
        <div className="alert alert-warn" style={{ marginTop: 10 }} role="status">
          <strong>Atenção</strong>
          {warning}
        </div>
      )}

      <section className="card" style={{ marginTop: 12 }} aria-labelledby="ps-brinco">
        <h2 id="ps-brinco" className="card-title" style={{ marginTop: 0 }}>Brinco do animal (opcional)</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitTag();
          }}
          style={{ display: "flex", gap: 8, alignItems: "flex-end" }}
        >
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="ps-tag" className="field-label sr-only">Número do brinco</label>
            <input
              id="ps-tag"
              type="text"
              autoComplete="off"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              placeholder="Número do brinco"
              aria-describedby="ps-tag-ajuda"
            />
          </div>
          <button className="btn btn-secondary" type="submit" disabled={!tagInput.trim()}>
            Registrar
          </button>
        </form>
        <p id="ps-tag-ajuda" className="small muted" style={{ margin: "6px 0 0" }}>
          Digite ou use um leitor de brinco eletrônico (Bluetooth). O número vai para o animal que está passando, ou para o
          próximo que entrar.
        </p>
        {(currentTag || pendingTag) && (
          <div className="small" style={{ marginTop: 6 }} aria-live="polite">
            {currentTag && <span className="badge badge-ok">Passando agora: {currentTag}</span>}{" "}
            {pendingTag && <span className="badge badge-neutral">Próximo: {pendingTag}</span>}
          </div>
        )}
      </section>

      <section className="card" style={{ marginTop: 10 }} aria-labelledby="ps-result">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <h2 id="ps-result" className="card-title" style={{ margin: 0 }}>3. Resultados</h2>
          <span className="small muted" aria-live="polite">{sessionCount} nesta sessão</span>
        </div>
        {pendingCount > 0 && (
          <button type="button" className="btn btn-secondary btn-block" style={{ marginTop: 8 }} onClick={reestimate}>
            Calcular peso de {pendingCount} passagem(ns) sem estimativa
          </button>
        )}
        <PassageResults
          history={history}
          queued={queuedPassages}
          onChanged={(up) => setHistory((list) => list.map((p) => (p.id === up.id ? up : p)))}
        />
      </section>
    </div>
  );
}

function emptyMetrics(): FrameMetrics {
  return { foreground: 0, motion: 0, box: null, fullyInside: false, offCenter: 1 };
}

function drawOverlay(canvas: HTMLCanvasElement | null, m: FrameMetrics | null, present: boolean) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);

  // Faixas laterais: o animal precisa ficar entre elas para a foto valer.
  const margin = CFG.edgeMargin * w;
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  ctx.fillRect(0, 0, margin, h);
  ctx.fillRect(w - margin, 0, margin, h);

  if (!m?.box) return;
  const good = m.fullyInside && m.box.x1 - m.box.x0 >= CFG.minBoxWidth;
  ctx.strokeStyle = good ? "#66bb6a" : present ? "#ffb300" : "rgba(255,255,255,0.6)";
  ctx.lineWidth = 3;
  ctx.strokeRect(m.box.x0 * w, m.box.y0 * h, (m.box.x1 - m.box.x0) * w, (m.box.y1 - m.box.y0) * h);
}
