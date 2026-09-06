/** Turns an encoded symbol into an SVG element. Built through the DOM, never innerHTML. */
import { encode, formatLabel, type Symbol } from "./encode.js";
import { encodeQr, type QrSymbol } from "./qr.js";

const SVG = "http://www.w3.org/2000/svg";
const LINEAR = new Set(["code128", "ean13", "ean8", "upca", "code39", "itf"]);

function element<K extends keyof SVGElementTagNameMap>(
  name: K,
  attributes: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

/** Linear symbols: bars as merged runs, with guard bars drawn slightly longer. */
function linearSvg(symbol: Symbol): SVGSVGElement {
  const width = symbol.modules.length + symbol.quiet * 2;
  const height = 34;
  const svg = element("svg", {
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: "none",
    class: "linear",
    role: "img",
    "aria-label": `Barcode for ${symbol.text}`,
  });
  svg.append(element("rect", { x: 0, y: 0, width, height, fill: "#fff" }));
  const guarded = (at: number) => symbol.guards.some(([from, to]) => at >= from && at < to);
  for (let at = 0; at < symbol.modules.length;) {
    if (symbol.modules[at] === "0") {
      at += 1;
      continue;
    }
    let run = 1;
    while (symbol.modules[at + run] === "1" && guarded(at + run) === guarded(at)) run += 1;
    svg.append(
      element("rect", {
        x: at + symbol.quiet,
        y: 0,
        width: run,
        height: symbol.guards.length && !guarded(at) ? height - 4 : height,
        fill: "#000",
      }),
    );
    at += run;
  }
  return svg;
}

/** QR: one rect per horizontal run of dark modules, which keeps the node count low. */
/**
 * Dark modules merged into horizontal runs, which keeps the node count down. Exported
 * because the merge has to stop at the end of each row: the grid is a flat array, so
 * a run that does not bound-check spills into the next row and draws a bar hanging off
 * the right edge of the symbol.
 * @returns one entry per run, in module coordinates
 */
export function qrRuns(symbol: QrSymbol): { x: number; y: number; width: number }[] {
  const runs: { x: number; y: number; width: number }[] = [];
  for (let y = 0; y < symbol.size; y += 1) {
    for (let x = 0; x < symbol.size;) {
      if (!symbol.modules[y * symbol.size + x]) {
        x += 1;
        continue;
      }
      let width = 1;
      while (x + width < symbol.size && symbol.modules[y * symbol.size + x + width]) width += 1;
      runs.push({ x, y, width });
      x += width;
    }
  }
  return runs;
}

function qrSvg(symbol: QrSymbol, text: string): SVGSVGElement {
  const quiet = 4;
  const width = symbol.size + quiet * 2;
  const svg = element("svg", {
    viewBox: `0 0 ${width} ${width}`,
    role: "img",
    "aria-label": `QR code for ${text}`,
    "shape-rendering": "crispEdges",
    class: "qr",
  });
  svg.append(element("rect", { x: 0, y: 0, width, height: width, fill: "#fff" }));
  for (const run of qrRuns(symbol)) {
    svg.append(
      element("rect", {
        x: run.x + quiet,
        y: run.y + quiet,
        width: run.width,
        height: 1,
        fill: "#000",
      }),
    );
  }
  return svg;
}

/**
 * @returns {{svg: SVGElement, text: string}} the drawn symbol and its printed value
 * @throws {Error} with a message safe to show to the user
 */
export function renderBarcode(
  format: string,
  payload: string,
): { svg: SVGSVGElement; text: string } {
  if (format === "qr") return { svg: qrSvg(encodeQr(payload), payload), text: payload };
  if (LINEAR.has(format)) {
    const symbol = encode(format, payload);
    return { svg: linearSvg(symbol), text: symbol.text };
  }
  if (format === "pdf417") throw new Error("PDF417 cannot be drawn yet.");
  throw new Error(`${formatLabel(format)} cannot be drawn.`);
}

/** Cheap check for whether a format can carry a value, used to grey out the picker. */
export function canEncode(format: string, payload: string): boolean {
  if (format === "none") return true;
  if (format === "pdf417") return false;
  try {
    if (format === "qr") encodeQr(payload);
    else encode(format, payload);
    return true;
  } catch {
    return false;
  }
}
