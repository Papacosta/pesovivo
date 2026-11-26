/** Gera UUID (com fallback para navegadores sem crypto.randomUUID). */
export function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // eslint-disable-next-line no-bitwise
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256) & 0xff);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export function formatNumber(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return "-";
  return value.toLocaleString("pt-BR", { maximumFractionDigits: digits });
}

/** Peso de 1 arroba (@) de carcaça, em kg. */
export const ARROBA_KG = 15;

/**
 * Peso vivo -> arrobas de carcaça: peso × rendimento ÷ 15.
 * Ex.: 340 kg com 50% de rendimento = 11,3 @.
 */
export function carcassArrobas(liveWeightKg: number, yieldPct: number): number {
  return (liveWeightKg * (yieldPct / 100)) / ARROBA_KG;
}

export const CATEGORY_LABELS: Record<string, string> = {
  bezerro: "Bezerro",
  novilha: "Novilha",
  vaca: "Vaca",
  boi: "Boi",
};

export const SEX_LABELS: Record<string, string> = {
  macho: "Macho",
  femea: "Fêmea",
};

export const LIGHT_LABELS: Record<string, string> = {
  sol: "Sol pleno",
  sombra: "Sombra",
  nebuloso: "Nublado",
  artificial: "Luz artificial",
};

export const TIME_LABELS: Record<string, string> = {
  manha: "Manhã",
  tarde: "Tarde",
  noite: "Noite",
};
