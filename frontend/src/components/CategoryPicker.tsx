import { CATEGORY_LABELS } from "../lib/format";

interface CategoryPickerProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
}

/**
 * Categoria escolhida antes da foto (bezerro, novilha, vaca, boi). Vai junto
 * com a passagem e entra no modelo quando o animal não tem cadastro.
 */
export default function CategoryPicker({ id, value, onChange, disabled, label = "Categoria dos animais" }: CategoryPickerProps) {
  return (
    <div className="field">
      <span id={`${id}-label`} className="field-label">
        {label}
      </span>
      <div className="chip-group" role="group" aria-labelledby={`${id}-label`} aria-describedby={`${id}-ajuda`}>
        {Object.entries(CATEGORY_LABELS).map(([key, text]) => (
          <button
            key={key}
            type="button"
            className="chip"
            aria-pressed={value === key}
            disabled={disabled}
            onClick={() => onChange(value === key ? "" : key)}
          >
            {text}
          </button>
        ))}
      </div>
      <span id={`${id}-ajuda`} className="field-hint">
        Opcional, mas melhora a estimativa. Se o brinco tiver cadastro, vale a categoria do cadastro.
      </span>
    </div>
  );
}
