/**
 * Leituras do celular para a foto na mão. A conta da distância é feita no
 * servidor (backend/app/services/geometry.py); aqui só o necessário para
 * orientar a pessoa na hora da foto. Mesma convenção W3C DeviceOrientation.
 */

/** Ângulo da tela em relação ao aparelho (0, 90, 180, 270). */
export function screenAngle(): number {
  const so = (screen as Screen & { orientation?: { angle?: number } }).orientation;
  if (so && typeof so.angle === "number") return ((so.angle % 360) + 360) % 360;
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === "number" ? ((legacy % 360) + 360) % 360 : 0;
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Componente vertical (para cima) de um vetor do aparelho no mundo. */
function up(v: [number, number, number], beta: number, gamma: number): number {
  const b = rad(beta);
  const g = rad(gamma);
  return -Math.cos(b) * Math.sin(g) * v[0] + Math.sin(b) * v[1] + Math.cos(b) * Math.cos(g) * v[2];
}

function imageAxes(angle: number): { right: [number, number, number]; down: [number, number, number] } {
  const a = (Math.round(angle / 90) % 4) * 90;
  if (a === 0) return { right: [1, 0, 0], down: [0, -1, 0] };
  if (a === 90) return { right: [0, -1, 0], down: [1, 0, 0] };
  if (a === 270) return { right: [0, 1, 0], down: [-1, 0, 0] };
  return { right: [-1, 0, 0], down: [0, 1, 0] };
}

/** Quantos graus a câmera aponta para baixo do horizonte (negativo = para cima). */
export function cameraPitchDeg(beta: number, gamma: number): number {
  return deg(Math.asin(Math.max(-1, Math.min(1, -up([0, 0, -1], beta, gamma)))));
}

/** Giro da imagem em torno da lente (0 = horizonte reto). */
export function cameraRollDeg(beta: number, gamma: number, angle: number): number {
  const { right, down } = imageAxes(angle);
  return deg(Math.atan2(up(right, beta, gamma), Math.max(-up(down, beta, gamma), 1e-9)));
}
