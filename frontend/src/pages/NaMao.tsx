/**
 * Modo na mão: a pessoa fotografa o animal no pasto, de longe, com UM toque.
 *
 * - Sem informar distância e sem objeto de referência: o servidor estima a
 *   distância pelo ângulo do celular (giroscópio) + altura em que a pessoa
 *   segura o celular (ajuste feito uma vez) + onde os cascos tocam o chão.
 * - Zoom 1×–5× para não precisar chegar perto. O zoom de cada foto é
 *   registrado e entra na conta (zoom muda o tamanho em pixels, não o animal).
 * - Um toque tira uma rajada de 3 quadros; os tremidos são descartados e o
 *   peso é a mediana dos que sobram.
 *
 * As fotos viram uma "passagem" com mode=handheld e usam a mesma fila
 * offline do modo passagem.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiError } from "../api";
import {
  getOrientation,
  getVideoTrack,
  onOrientationChange,
  requestOrientationPermission,
  startCamera,
  startOrientation,
  stopCamera,
  stopOrientation,
} from "../sensors";
import { quickQuality } from "../lib/imageQuality";
import { enqueue, localSettings, onQueueChange, queueItems, syncQueue } from "../lib/queue";
import { uuid } from "../lib/format";
import { showToast } from "../lib/toast";
import { cameraPitchDeg, cameraRollDeg, screenAngle } from "../lib/handheldGeometry";
import PageHeader from "../components/PageHeader";
import CategoryPicker from "../components/CategoryPicker";
import PassageResults, { type QueuedPassageSummary } from "../components/PassageResults";
import type { Passage, PassageQueuedFrame } from "../types";

const ZOOM_LEVELS = [1, 2, 3, 5];
const BURST_FRAMES = 3;
const BURST_INTERVAL_MS = 250;
const MAX_ROLL_DEG = 15;

interface ZoomState {
  /** Zoom total pedido pela pessoa. */
  level: number;
  /** Parte feita pela câmera (lente/zoom do aparelho). */
  hardware: number;
  /** Parte feita por recorte da imagem (quando o aparelho não faz zoom). */
  crop: number;
}

interface Tilt {
  pitch: number;
  roll: number;
}

export default function NaMao() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const [category, setCategory] = useState<string>(localSettings.passageCategory);
  const [earTag, setEarTag] = useState("");
  const [zoom, setZoom] = useState<ZoomState>({ level: 1, hardware: 1, crop: 1 });
  const [tilt, setTilt] = useState<Tilt | null>(null);
  const [needsMotionPermission, setNeedsMotionPermission] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const [history, setHistory] = useState<Passage[]>([]);
  const [queued, setQueued] = useState<QueuedPassageSummary[]>([]);

  // ---------------- dados ----------------
  const refresh = useCallback(() => {
    api
      .listPassages({ limit: 50 })
      .then((list) => setHistory(list.filter((p) => p.mode === "handheld")))
      .catch(() => undefined);
    queueItems()
      .then((items) =>
        setQueued(
          items.flatMap((it) =>
            it.kind === "passage" && it.mode === "handheld"
              ? [{ id: it.id, startedAt: it.startedAt, earTag: it.earTag, frames: it.frames.length }]
              : []
          )
        )
      )
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    return onQueueChange(refresh);
  }, [refresh]);

  useEffect(() => {
    localSettings.passageCategory = category;
  }, [category]);

  // ---------------- câmera ----------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!videoRef.current) return;
      try {
        // Resolução alta: o zoom por recorte precisa de pixels sobrando.
        await startCamera(videoRef.current, {
          video: { width: { ideal: 3840 }, height: { ideal: 2160 } },
        });
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
    };
  }, []);

  // ---------------- ângulo do celular ----------------
  useEffect(() => {
    const ios = typeof (window as unknown as { DeviceOrientationEvent?: { requestPermission?: unknown } })
      .DeviceOrientationEvent?.requestPermission === "function";
    setNeedsMotionPermission(ios && !getOrientation().available);
    if (!ios) startOrientation();
    let last = 0;
    const off = onOrientationChange(() => {
      const now = performance.now();
      if (now - last < 200) return;
      last = now;
      const o = getOrientation();
      if (o.beta === null || o.gamma === null) return;
      setNeedsMotionPermission(false);
      setTilt({ pitch: cameraPitchDeg(o.beta, o.gamma), roll: cameraRollDeg(o.beta, o.gamma, screenAngle()) });
    });
    return () => {
      off();
      stopOrientation();
    };
  }, []);

  async function enableMotion(): Promise<boolean> {
    const ok = await requestOrientationPermission();
    if (!ok) {
      showToast("Sem acesso ao movimento do celular não dá para estimar a distância.", "warning");
      return false;
    }
    startOrientation();
    // Espera a primeira leitura chegar.
    for (let i = 0; i < 10 && !getOrientation().available; i++) await sleep(100);
    setNeedsMotionPermission(!getOrientation().available);
    return getOrientation().available;
  }

  // ---------------- zoom ----------------
  async function chooseZoom(level: number) {
    const track = getVideoTrack();
    const caps = (track?.getCapabilities?.() ?? {}) as { zoom?: { min: number; max: number } };
    let hardware = 1;
    if (track && caps.zoom && caps.zoom.max > 1) {
      hardware = Math.min(level, caps.zoom.max);
      try {
        await track.applyConstraints({ advanced: [{ zoom: hardware }] } as unknown as MediaTrackConstraints);
        const actual = (track.getSettings() as MediaTrackSettings & { zoom?: number }).zoom;
        if (typeof actual === "number" && actual > 0) hardware = actual;
      } catch {
        hardware = 1;
      }
    }
    setZoom({ level, hardware, crop: Math.max(1, level / hardware) });
  }

  // ---------------- foto ----------------
  async function grabFrame(): Promise<PassageQueuedFrame | null> {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return null;
    const o = getOrientation();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const cw = Math.round(vw / zoom.crop);
    const ch = Math.round(vh / zoom.crop);
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, cw, ch);

    const q = quickQuality(canvas);
    if (q.isBlurry || q.isDark) return null;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) return null;
    return {
      blob,
      capturedAt: new Date().toISOString(),
      detection: {
        source: "handheld",
        blur_score: Math.round(q.blurScore),
        brightness: Math.round(q.brightness),
        camera: {
          beta: o.beta,
          gamma: o.gamma,
          alpha: o.alpha,
          screen_angle: screenAngle(),
          zoom: Number((zoom.hardware * zoom.crop).toFixed(3)),
          hardware_zoom: zoom.hardware,
          crop_zoom: Number(zoom.crop.toFixed(3)),
          focal_eq_mm: localSettings.focalEqMm,
          phone_height_cm: localSettings.phoneHeightCm,
        },
      },
    };
  }

  async function weigh() {
    if (busy || !cameraReady) return;
    if (!getOrientation().available && !(await enableMotion())) return;
    setBusy(true);
    setHint(null);
    try {
      const startedAt = new Date().toISOString();
      const frames: PassageQueuedFrame[] = [];
      for (let i = 0; i < BURST_FRAMES; i++) {
        if (i > 0) await sleep(BURST_INTERVAL_MS);
        const f = await grabFrame();
        if (f) frames.push(f);
      }
      if (frames.length === 0) {
        setHint("As fotos saíram tremidas ou escuras. Segure firme com as duas mãos e toque de novo.");
        return;
      }
      await enqueue({
        kind: "passage",
        id: uuid(),
        createdAt: Date.now(),
        mode: "handheld",
        capturePointId: null,
        category: category || null,
        startedAt,
        endedAt: new Date().toISOString(),
        earTag: earTag.trim() || null,
        lot: null,
        frames,
      });
      setEarTag("");

      if (!navigator.onLine) {
        showToast("Foto guardada no celular. O peso é calculado quando a internet voltar.", "info");
        return;
      }
      const res = await syncQueue();
      showToast(
        res.errors.length ? "Foto guardada no celular. Será enviada quando a conexão voltar." : "Pronto! Veja o peso abaixo.",
        res.errors.length ? "info" : "success"
      );
      refresh();
      document.getElementById("nm-result")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      showToast(apiError(e), "error");
    } finally {
      setBusy(false);
    }
  }

  async function reestimate() {
    try {
      const r = await api.reestimatePassages();
      showToast(
        r.estimated > 0
          ? `${r.estimated} pesagem(ns) calculada(s).`
          : r.still_pending > 0
            ? "Ainda sem modelo ativo para estimar."
            : "Nada pendente.",
        r.estimated > 0 ? "success" : "info"
      );
      refresh();
    } catch (e) {
      showToast(apiError(e), "error");
    }
  }

  // ---------------- orientação para a pessoa ----------------
  const pendingCount = history.filter((p) => p.status === "pending_model").length;
  let tiltMsg: { text: string; ok: boolean } | null = null;
  if (tilt) {
    if (Math.abs(tilt.roll) > MAX_ROLL_DEG) tiltMsg = { text: "Celular torto: deixe o horizonte reto", ok: false };
    else if (tilt.pitch < 0.5) tiltMsg = { text: "Aponte um pouco para baixo", ok: false };
    else if (tilt.pitch > 45) tiltMsg = { text: "Levante o celular", ok: false };
    else tiltMsg = { text: "Celular no ângulo certo", ok: true };
  }

  // ---------------- render ----------------
  return (
    <div>
      <PageHeader
        title="Pesar na mão"
        description="Fotografe o animal de lado, de onde você estiver. Use o zoom se ele estiver longe. Um toque basta."
      />

      <section className="card" aria-labelledby="nm-animal">
        <h2 id="nm-animal" className="card-title" style={{ marginTop: 0 }}>1. Animal</h2>
        <div className="form-row">
          <CategoryPicker id="nm-cat" label="Categoria do animal" value={category} onChange={setCategory} />
          <div className="field">
            <label htmlFor="nm-tag" className="field-label">Brinco</label>
            <input
              id="nm-tag"
              type="text"
              autoComplete="off"
              value={earTag}
              onChange={(e) => setEarTag(e.target.value)}
              placeholder="Número do brinco"
              aria-describedby="nm-tag-ajuda"
            />
            <span id="nm-tag-ajuda" className="field-hint">Opcional.</span>
          </div>
        </div>
      </section>

      {cameraError && (
        <div className="alert alert-error" role="alert">
          <strong>Não foi possível usar a câmera.</strong>
          {cameraError}
        </div>
      )}

      <h2 className="card-title" style={{ margin: "4px 0 8px" }}>2. Foto</h2>
      <div style={{ position: "relative", borderRadius: 12, overflow: "hidden", background: "#000" }}>
        <video
          ref={videoRef}
          playsInline
          muted
          aria-label="Imagem ao vivo da câmera"
          style={{
            width: "100%",
            display: "block",
            minHeight: 220,
            transform: zoom.crop > 1 ? `scale(${zoom.crop})` : undefined,
            transformOrigin: "center",
          }}
        />
        {/* Guia: animal inteiro, com os cascos visíveis, dentro do retângulo. */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: "15% 6% 12%",
            border: "3px dashed rgba(255,255,255,0.8)",
            borderRadius: 12,
            pointerEvents: "none",
          }}
        />
        {tiltMsg && (
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              top: 8,
              left: 8,
              padding: "6px 12px",
              borderRadius: 999,
              background: tiltMsg.ok ? "rgba(27,94,32,0.85)" : "rgba(180,83,9,0.9)",
              color: "#fff",
              fontSize: "0.9rem",
              fontWeight: 600,
            }}
          >
            {tiltMsg.ok ? "✓ " : ""}
            {tiltMsg.text}
          </div>
        )}
      </div>
      <div
        role="group"
        aria-label="Zoom"
        style={{ display: "flex", justifyContent: "center", gap: 10, marginTop: 8 }}
      >
        {ZOOM_LEVELS.map((z) => (
          <button
            key={z}
            type="button"
            aria-pressed={zoom.level === z}
            aria-label={`Zoom ${z} vezes`}
            onClick={() => void chooseZoom(z)}
            disabled={!cameraReady}
            style={{
              width: 48,
              height: 48,
              borderRadius: "50%",
              border: "none",
              fontWeight: 700,
              background: zoom.level === z ? "var(--primary)" : "var(--card)",
              color: zoom.level === z ? "#fff" : "var(--text)",
              boxShadow: "var(--shadow)",
            }}
          >
            {z}×
          </button>
        ))}
      </div>
      <p className="sr-only" aria-live="polite">
        {tiltMsg?.text ?? ""}
      </p>
      <p className="small muted" style={{ margin: "6px 0 0" }}>
        {cameraReady || cameraError
          ? "Animal inteiro de lado, com os cascos aparecendo no chão. Celular na altura de sempre."
          : "Abrindo a câmera…"}
      </p>

      {needsMotionPermission && (
        <div className="alert alert-warn" style={{ marginTop: 10 }} role="status">
          <strong>Permita o movimento do celular</strong>
          O app usa o ângulo do celular para calcular a distância até o animal.
          <div style={{ marginTop: 8 }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void enableMotion()}>
              Permitir
            </button>
          </div>
        </div>
      )}

      {hint && (
        <div className="alert alert-warn" style={{ marginTop: 10 }} role="status">
          <strong>Tente de novo</strong>
          {hint}
        </div>
      )}

      <button
        type="button"
        className="btn btn-primary btn-block btn-lg"
        style={{ marginTop: 10 }}
        onClick={() => void weigh()}
        disabled={!cameraReady || busy}
        aria-describedby="nm-pesar-ajuda"
      >
        {busy ? "Fotografando…" : "📷 Pesar este animal"}
      </button>
      <p id="nm-pesar-ajuda" className="small muted" style={{ margin: "6px 0 0" }}>
        Fique parado ao tocar: o app tira 3 fotos seguidas e usa as melhores. A distância é calculada sozinha pelo
        ângulo do celular e pela{" "}
        <a href="#/ajustes">altura em que você o segura ({localSettings.phoneHeightCm} cm)</a>. Funciona melhor em
        pasto plano. Sem internet, a foto fica guardada e o peso sai depois.
      </p>

      <section className="card" style={{ marginTop: 12 }} aria-labelledby="nm-result">
        <h2 id="nm-result" className="card-title" style={{ margin: 0 }}>3. Resultados na mão</h2>
        {pendingCount > 0 && (
          <button type="button" className="btn btn-secondary btn-block" style={{ marginTop: 8 }} onClick={reestimate}>
            Calcular peso de {pendingCount} pesagem(ns) pendente(s)
          </button>
        )}
        <PassageResults
          history={history}
          queued={queued}
          onChanged={(up) => setHistory((list) => list.map((p) => (p.id === up.id ? up : p)))}
          emptyText="Nenhum animal pesado na mão ainda."
        />
      </section>
    </div>
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
