/**
 * Reading a barcode out of a photograph.
 *
 * Chrome has BarcodeDetector and is used when present. Safari has nothing, so the
 * fallback grinds through the image by hand: grey it, take horizontal slices, threshold
 * each one, and hand the result to decodeRow. Slices are taken at several heights
 * because a photograph is never straight, and the image is tried rotated because a
 * barcode held sideways is the normal case, not the exception.
 */
import { type Decoded, decodeRow } from "./decode.js";
import { decodeQrGrid } from "./qr-decode.js";
import { locateQr } from "./qr-locate.js";

/** Longest edge the scan works at. Bigger costs time and buys nothing. */
const MAX_EDGE = 1400;
/** How many horizontal slices to try per orientation. */
const SLICES = 33;

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string; format: string }[]>;
}

const DETECTOR_FORMATS: Record<string, string> = {
  code_128: "code128",
  ean_13: "ean13",
  ean_8: "ean8",
  upc_a: "upca",
  code_39: "code39",
  itf: "itf",
  qr_code: "qr",
  pdf417: "pdf417",
};

async function loadImage(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.addEventListener("load", () => resolve(image));
      image.addEventListener("error", () => reject(new Error("That file is not an image.")));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toCanvas(image: HTMLImageElement): HTMLCanvasElement {
  const scale = Math.min(1, MAX_EDGE / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Perceptual luminance, one byte per pixel. */
function toGrey(data: ImageData): Uint8ClampedArray {
  const grey = new Uint8ClampedArray(data.width * data.height);
  for (let i = 0; i < grey.length; i += 1) {
    const at = i * 4;
    grey[i] = (data.data[at] * 77 + data.data[at + 1] * 151 + data.data[at + 2] * 28) >> 8;
  }
  return grey;
}

/**
 * Thresholds one row against its own midpoint rather than a global one, so a photo
 * lit unevenly across the card still reads. A row with almost no contrast is skipped:
 * it is blank paper or shadow, and thresholding noise invents bars that are not there.
 */
function sliceToRow(grey: Uint8ClampedArray, width: number, y: number): Uint8Array | null {
  let low = 255;
  let high = 0;
  const from = y * width;
  for (let x = 0; x < width; x += 1) {
    const value = grey[from + x];
    if (value < low) low = value;
    if (value > high) high = value;
  }
  if (high - low < 40) return null;
  const threshold = (low + high) / 2;
  const row = new Uint8Array(width);
  for (let x = 0; x < width; x += 1) row[x] = grey[from + x] < threshold ? 1 : 0;
  return row;
}

function scanGrey(grey: Uint8ClampedArray, width: number, height: number): Decoded | null {
  for (let i = 1; i <= SLICES; i += 1) {
    const y = Math.floor((height * i) / (SLICES + 1));
    const row = sliceToRow(grey, width, y);
    if (!row) continue;
    // Both directions: a quarter turn reverses the reading order, and a card can be
    // photographed upside down. Every format here has an asymmetric start and stop,
    // so a backwards row simply fails rather than decoding to something wrong.
    const found = decodeRow(row) ?? decodeRow(row.slice().reverse());
    if (found) return found;
  }
  return null;
}

/** Rotates a quarter turn, so a sideways barcode becomes a horizontal one. */
function rotate(grey: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(grey.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      out[x * height + (height - 1 - y)] = grey[y * width + x];
    }
  }
  return out;
}

/**
 * @returns what the image contains, or null when nothing could be read
 * @throws when the file is not an image at all
 */
export async function scanImage(file: Blob): Promise<Decoded | null> {
  const canvas = toCanvas(await loadImage(file));
  const context = canvas.getContext("2d");
  if (!context) return null;

  // Chrome and Android do this in hardware, and read QR and PDF417 besides.
  const Detector = (
    globalThis as { BarcodeDetector?: new (options?: unknown) => BarcodeDetectorLike }
  ).BarcodeDetector;
  if (Detector) {
    try {
      const [first] = await new Detector().detect(canvas);
      if (first) {
        return {
          format: (DETECTOR_FORMATS[first.format] ?? "code128") as Decoded["format"],
          text: first.rawValue,
        };
      }
    } catch {
      // Unsupported or refused; fall through to reading it here.
    }
  }

  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  const grey = toGrey(data);
  const rotated = rotate(grey, canvas.width, canvas.height);

  const linear =
    scanGrey(grey, canvas.width, canvas.height) ?? scanGrey(rotated, canvas.height, canvas.width);
  if (linear) return linear;

  // QR last: it costs a pass over the whole image, where a bar code needs one row.
  // Orientation does not matter to the corner squares, but binarisation of a rotated
  // frame can differ, so both are worth trying.
  for (const [pixels, w, h] of [
    [grey, canvas.width, canvas.height],
    [rotated, canvas.height, canvas.width],
  ] as const) {
    const located = locateQr(pixels, w, h);
    if (!located) continue;
    const text = decodeQrGrid(located.grid, located.size);
    if (text) return { format: "qr", text };
  }
  return null;
}
