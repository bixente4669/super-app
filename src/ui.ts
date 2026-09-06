/**
 * The pieces of card chrome that appear in more than one place. They live here so a
 * change reaches every copy at once: the card face is drawn in the grid, the dense
 * list and the editor preview, and the symbol panel in the viewer and the preview.
 * Keeping them apart is what let the preview drift out of step with a real card.
 */
import type { Card } from "./cards.js";
import { renderBarcode } from "./barcode/render.js";

/** A card being previewed has no id or order yet, so only the drawn parts are needed. */
type CardLike = Pick<Card, "name" | "payload" | "display" | "color" | "live"> & {
  logo?: Blob | null;
};

// Choose whichever text colour has the higher WCAG contrast against the background.
export function textColor(hex: string): string {
  const linear = (hex.slice(1).match(/../g) ?? []).map((part) => {
    const value = parseInt(part, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  return luminance > 0.179 ? "#000000" : "#ffffff";
}

export function paint(element: HTMLElement, color: string) {
  element.style.backgroundColor = color;
  element.style.color = textColor(color);
}

/**
 * Object URLs are revoked when the element leaves the document, so a long list does
 * not accumulate them. Without this every re-render would leak one per card.
 */
function logoImage(logo: Blob, className: string): HTMLImageElement {
  const image = document.createElement("img");
  image.className = className;
  image.alt = "";
  image.decoding = "async";
  const url = URL.createObjectURL(logo);
  image.src = url;
  image.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
  image.addEventListener("error", () => URL.revokeObjectURL(url), { once: true });
  return image;
}

function liveBadge(view: string): HTMLElement {
  const badge = document.createElement("em");
  badge.className = view === "list" ? "row-badge" : "";
  badge.textContent = view === "list" ? "↗" : "Code from the shop";
  badge.title = "Code comes from the shop";
  return badge;
}

const span = (className: string, text: string): HTMLSpanElement => {
  const node = document.createElement("span");
  if (className) node.className = className;
  node.textContent = text;
  return node;
};

/**
 * A card's face. `interactive` gives a button for the list; the editor preview passes
 * false, so the preview cannot become a nested button but is otherwise identical.
 * @returns {HTMLElement}
 */
export function cardFace(card: CardLike, { view = "cards", interactive = true } = {}): HTMLElement {
  const face = interactive ? document.createElement("button") : document.createElement("div");
  if (face instanceof HTMLButtonElement) face.type = "button";
  face.className = view === "list" ? "row-open" : "card-open";

  if (view === "list") {
    // The logo stands in for the colour swatch when there is one.
    const swatch = card.logo ? logoImage(card.logo, "swatch") : span("swatch", "");
    if (!card.logo) swatch.style.backgroundColor = card.color;
    face.append(
      swatch,
      span("row-name", card.name),
      span("row-number", card.display || card.payload || ""),
    );
  } else {
    const name = document.createElement("strong");
    name.textContent = card.name;
    if (card.logo) {
      const heading = document.createElement("span");
      heading.className = "card-heading";
      heading.append(logoImage(card.logo, "card-logo"), name);
      face.append(heading, span("", card.display || card.payload || "No number added"));
      if (card.live) face.append(liveBadge(view));
      return face;
    }
    face.append(name, span("", card.display || card.payload || "No number added"));
  }

  // The barcode format is deliberately absent: it says nothing useful once saved.
  // A live card is marked, because opening it gives a link rather than a code.
  if (card.live) {
    const badge = document.createElement("em");
    badge.className = view === "list" ? "row-badge" : "";
    badge.textContent = view === "list" ? "↗" : "Code from the shop";
    badge.title = "Code comes from the shop";
    face.append(badge);
  }
  return face;
}

/**
 * Draws a barcode into `container`, and owns the panel's empty and error states so no
 * caller has to remember them. An empty `payload` means there is nothing to show, and
 * the panel hides itself rather than leaving a blank white box on screen.
 */
export function renderSymbol(
  container: HTMLElement,
  format: string,
  payload: string,
  fallback = "",
) {
  container.replaceChildren();
  container.hidden = !payload;
  if (!payload) return;
  if (format === "none") {
    container.append(span("symbol-text", fallback || payload));
    return;
  }
  try {
    container.append(renderBarcode(format, payload).svg);
  } catch (error) {
    const note = document.createElement("p");
    note.className = "symbol-error";
    note.textContent = error instanceof Error ? error.message : String(error);
    container.append(note, span("symbol-text", payload));
  }
}

/**
 * A drawing of a PDF417 symbol, for the format gallery only. The encoder cannot
 * produce one, so this exists purely so the stacked shape stays recognisable when
 * matching a card against the gallery. It is not scannable.
 */
export function illustratePdf417(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 120 44");
  svg.setAttribute("class", "linear");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Drawing of a PDF417 symbol: stacked rows of narrow blocks");
  const rect = (x: number, y: number, width: number, height: number, fill: string) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    node.setAttribute("x", String(x));
    node.setAttribute("y", String(y));
    node.setAttribute("width", String(width));
    node.setAttribute("height", String(height));
    node.setAttribute("fill", fill);
    return node;
  };
  svg.append(rect(0, 0, 120, 44, "#fff"));
  // A fixed pattern: stacked rows between the solid start and stop bars.
  let seed = 7;
  const next = () => (seed = (seed * 31 + 17) % 97);
  for (let row = 0; row < 6; row += 1) {
    const y = 2 + row * 7;
    svg.append(rect(2, y, 5, 6, "#000"), rect(113, y, 5, 6, "#000"));
    let x = 10;
    while (x < 111) {
      const width = 1 + (next() % 4);
      if (next() % 2) svg.append(rect(x, y, width, 6, "#000"));
      x += width + 1 + (next() % 3);
    }
  }
  return svg;
}
