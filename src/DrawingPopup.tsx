import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SWATCHES, type Drawing, type LineWidth } from "./drawings";
import { useI18n } from "./i18n";

interface Props {
  drawing: Drawing;
  /** anchor point, in the coordinate space of the positioned parent (.chart-body) */
  at: { x: number; y: number };
  onChange: (d: Drawing) => void;
  onDelete: () => void;
  onClose: () => void;
}

const WIDTHS: LineWidth[] = [1, 2, 3];

/** Style editor opened by double-clicking a drawing: thickness, dash, colour, extension. */
export default function DrawingPopup({ drawing, at, onChange, onDelete, onClose }: Props) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);

  // keep the popup inside its parent
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent) return;
    const pw = parent.clientWidth;
    const ph = parent.clientHeight;
    const x = Math.max(6, Math.min(at.x + 10, pw - el.offsetWidth - 6));
    const y = Math.max(6, Math.min(at.y + 10, ph - el.offsetHeight - 6));
    setPos({ x, y });
  }, [at]);

  // close on outside pointerdown / Escape
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node | null)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const style = drawing.style;
  const setStyle = (patch: Partial<Drawing["style"]>) => onChange({ ...drawing, style: { ...style, ...patch } });
  const isSwatch = SWATCHES.some((s) => s.toLowerCase() === style.color.toLowerCase());

  return (
    <div className="draw-popup" ref={ref} style={{ left: pos.x, top: pos.y }} role="dialog" aria-label={t("dp.title")}>
      <div className="dp-row">
        <span className="dp-label">{t("dp.thickness")}</span>
        <span className="dp-seg">
          {WIDTHS.map((w) => (
            <button
              key={w}
              className={w === style.width ? "dp-opt on" : "dp-opt"}
              title={`${w}px`}
              aria-pressed={w === style.width}
              onClick={() => setStyle({ width: w })}
            >
              <i className="dp-stroke" style={{ height: w }} />
            </button>
          ))}
        </span>
      </div>

      <div className="dp-row">
        <span className="dp-label">{t("dp.style")}</span>
        <span className="dp-seg">
          <button
            className={!style.dashed ? "dp-opt on" : "dp-opt"}
            title={t("dp.solid")}
            aria-pressed={!style.dashed}
            onClick={() => setStyle({ dashed: false })}
          >
            <i className="dp-stroke" style={{ height: 2 }} />
          </button>
          <button
            className={style.dashed ? "dp-opt on" : "dp-opt"}
            title={t("dp.dashed")}
            aria-pressed={style.dashed}
            onClick={() => setStyle({ dashed: true })}
          >
            <i className="dp-stroke dashed" style={{ height: 2 }} />
          </button>
        </span>
      </div>

      <div className="dp-row">
        <span className="dp-label">{t("dp.colour")}</span>
        <span className="dp-swatches">
          {SWATCHES.map((c) => (
            <button
              key={c}
              className={c.toLowerCase() === style.color.toLowerCase() ? "dp-swatch on" : "dp-swatch"}
              style={{ background: c }}
              title={c}
              aria-label={t("dp.colourX", { c })}
              onClick={() => setStyle({ color: c })}
            />
          ))}
          <label className={isSwatch ? "dp-swatch custom" : "dp-swatch custom on"} title={t("dp.custom")}>
            <span className="dp-custom-fill" style={{ background: style.color }} />
            <input
              type="color"
              value={style.color}
              onChange={(e) => setStyle({ color: e.target.value })}
              aria-label={t("dp.custom")}
            />
          </label>
        </span>
      </div>

      {drawing.kind === "trend" && (
        <div className="dp-row">
          <span className="dp-label">{t("dp.extend")}</span>
          <span className="dp-seg">
            <button
              className={drawing.extendLeft ? "dp-opt text on" : "dp-opt text"}
              aria-pressed={drawing.extendLeft}
              title={t("dp.extendLeft")}
              onClick={() => onChange({ ...drawing, extendLeft: !drawing.extendLeft })}
            >
              {t("dp.left")}
            </button>
            <button
              className={drawing.extendRight ? "dp-opt text on" : "dp-opt text"}
              aria-pressed={drawing.extendRight}
              title={t("dp.extendRight")}
              onClick={() => onChange({ ...drawing, extendRight: !drawing.extendRight })}
            >
              {t("dp.right")}
            </button>
          </span>
        </div>
      )}

      <div className="dp-foot">
        <button className="dp-delete" onClick={onDelete}>
          {t("dp.delete")}
        </button>
        <button className="dp-done" onClick={onClose}>
          {t("dp.done")}
        </button>
      </div>
    </div>
  );
}
