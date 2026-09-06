/**
 * Linear barcode decoding, written by hand because Safari ships no BarcodeDetector.
 *
 * Everything here works on a row of modules — one entry per pixel, 1 for dark — so it
 * can be tested against the encoder without a canvas anywhere in sight. Turning a
 * photograph into such a row is the caller's job, in scan.ts.
 */
import { type FormatId, TABLES, checkDigit } from "./encode.js";

export interface Decoded {
  format: FormatId;
  text: string;
}

/** Alternating run lengths, and where the first run starts. */
interface Runs {
  widths: number[];
  /** True when runs[0] is dark. */
  darkFirst: boolean;
}

export function toRuns(row: ArrayLike<number>): Runs {
  const widths: number[] = [];
  let at = 0;
  while (at < row.length) {
    let width = 1;
    while (at + width < row.length && row[at + width] === row[at]) width += 1;
    widths.push(width);
    at += width;
  }
  return { widths, darkFirst: Boolean(row[0]) };
}

/**
 * How badly `runs` fits `pattern`, as average error per module, or Infinity when the
 * two cannot describe the same symbol. Scaling by the measured total rather than an
 * assumed module width is what lets this cope with any print size.
 */
function mismatch(runs: number[], pattern: readonly number[], modules: number): number {
  if (runs.length !== pattern.length) return Infinity;
  const total = runs.reduce((sum, width) => sum + width, 0);
  if (total < modules) return Infinity;
  const unit = total / modules;
  // A bar narrower than half a module means the reading is not this symbol at all.
  const limit = unit * 0.7;
  let error = 0;
  for (let i = 0; i < runs.length; i += 1) {
    const expected = pattern[i] * unit;
    const off = Math.abs(runs[i] - expected);
    if (off > limit) return Infinity;
    error += off;
  }
  return error / total;
}

const widthsOf = (pattern: string) => [...pattern].map(Number);

/* ------------------------------------------------------------------ Code 128 */

const CODE128_WIDTHS = TABLES.CODE128.map(widthsOf);

function decodeCode128(runs: number[], from: number): Decoded | null {
  // A start character is 6 runs spanning 11 modules.
  let best = { error: Infinity, value: -1 };
  for (const start of [103, 104, 105]) {
    const error = mismatch(runs.slice(from, from + 6), CODE128_WIDTHS[start], 11);
    if (error < best.error) best = { error, value: start };
  }
  if (best.value < 0) return null;

  const values = [best.value];
  let at = from + 6;
  while (at + 6 <= runs.length) {
    // The stop character is 7 runs over 13 modules; check it before a data character.
    if (mismatch(runs.slice(at, at + 7), CODE128_WIDTHS[106], 13) < 0.35) {
      values.push(106);
      break;
    }
    let match = { error: Infinity, value: -1 };
    for (let value = 0; value < 103; value += 1) {
      const error = mismatch(runs.slice(at, at + 6), CODE128_WIDTHS[value], 11);
      if (error < match.error) match = { error, value };
    }
    if (match.value < 0) return null;
    values.push(match.value);
    at += 6;
  }
  if (values.at(-1) !== 106 || values.length < 4) return null;

  const checksum = values[values.length - 2];
  let sum = values[0];
  for (let i = 1; i < values.length - 2; i += 1) sum += values[i] * i;
  if (sum % 103 !== checksum) return null;

  let inC = values[0] === 105;
  let text = "";
  for (const value of values.slice(1, -2)) {
    if (inC) {
      if (value === 100) {
        inC = false;
        continue;
      }
      if (value === 101 || value === 102) continue;
      text += String(value).padStart(2, "0");
    } else {
      if (value === 99) {
        inC = true;
        continue;
      }
      if (value === 100 || value === 101 || value === 102) continue;
      text += String.fromCharCode(value + 32);
    }
  }
  return text ? { format: "code128", text } : null;
}

/* -------------------------------------------------------------- EAN and UPC  */

const EAN_L = TABLES.EAN_L.map(digitRuns);
const EAN_G = TABLES.EAN_G.map(digitRuns);
const EAN_R = TABLES.EAN_R.map(digitRuns);

/** A 7-module digit as its four run lengths. */
function digitRuns(pattern: string): number[] {
  const runs: number[] = [];
  for (let i = 0; i < pattern.length;) {
    let width = 1;
    while (i + width < pattern.length && pattern[i + width] === pattern[i]) width += 1;
    runs.push(width);
    i += width;
  }
  return runs;
}

function readDigit(
  runs: number[],
  at: number,
  tables: number[][][],
): { digit: number; table: number } | null {
  let best = { error: Infinity, digit: -1, table: -1 };
  for (let table = 0; table < tables.length; table += 1) {
    for (let digit = 0; digit < 10; digit += 1) {
      const error = mismatch(runs.slice(at, at + 4), tables[table][digit], 7);
      if (error < best.error) best = { error, digit, table };
    }
  }
  return best.digit < 0 ? null : { digit: best.digit, table: best.table };
}

function decodeEan(runs: number[], from: number, perSide: number): Decoded | null {
  // Guard bars are three runs of one module each; they set the scale for the rest.
  if (mismatch(runs.slice(from, from + 3), [1, 1, 1], 3) === Infinity) return null;
  let at = from + 3;
  let parity = "";
  let digits = "";
  for (let i = 0; i < perSide; i += 1) {
    const read = readDigit(runs, at, [EAN_L, EAN_G]);
    if (!read) return null;
    parity += read.table === 0 ? "L" : "G";
    digits += read.digit;
    at += 4;
  }
  if (mismatch(runs.slice(at, at + 5), [1, 1, 1, 1, 1], 5) === Infinity) return null;
  at += 5;
  for (let i = 0; i < perSide; i += 1) {
    const read = readDigit(runs, at, [EAN_R]);
    if (!read) return null;
    digits += read.digit;
    at += 4;
  }
  if (mismatch(runs.slice(at, at + 3), [1, 1, 1], 3) === Infinity) return null;

  if (perSide === 4) {
    if (Number(digits[7]) !== checkDigit(digits.slice(0, 7))) return null;
    return { format: "ean8", text: digits };
  }
  const first = TABLES.EAN_PARITY.indexOf(parity);
  if (first < 0) return null;
  const full = String(first) + digits;
  if (Number(full[12]) !== checkDigit(full.slice(0, 12))) return null;
  // A leading zero is how a 12-digit UPC-A is carried inside an EAN-13 symbol.
  return first === 0 ? { format: "upca", text: full.slice(1) } : { format: "ean13", text: full };
}

/* ---------------------------------------------------------------- Code 39   */

const CODE39_ENTRIES = Object.entries(TABLES.CODE39).map(
  ([character, pattern]) =>
    [character, [...pattern].map((size) => (size === "w" ? 3 : 1))] as const,
);

function decodeCode39(runs: number[], from: number): Decoded | null {
  let at = from;
  let text = "";
  let started = false;
  while (at + 9 <= runs.length) {
    let best = { error: Infinity, character: "" };
    for (const [character, widths] of CODE39_ENTRIES) {
      const error = mismatch(runs.slice(at, at + 9), widths, 13);
      if (error < best.error) best = { error, character };
    }
    if (!best.character) return null;
    if (!started) {
      if (best.character !== "*") return null;
      started = true;
    } else if (best.character === "*") {
      return text ? { format: "code39", text } : null;
    } else {
      text += best.character;
    }
    at += 10; // Nine runs, then the narrow space between characters.
  }
  return null;
}

/* ------------------------------------------------------------------- ITF     */

const ITF_WIDTHS = TABLES.ITF.map((pattern) => [...pattern].map((size) => (size === "w" ? 3 : 1)));

function decodeItf(runs: number[], from: number): Decoded | null {
  if (mismatch(runs.slice(from, from + 4), [1, 1, 1, 1], 4) === Infinity) return null;
  let at = from + 4;
  let digits = "";
  // The stop is wide-narrow-narrow, which a pair beginning with "1" also looks like,
  // so it is checked once no further pair fits rather than before each one.
  while (at + 10 + 3 <= runs.length) {
    const group = runs.slice(at, at + 10);
    const bars = group.filter((_, i) => i % 2 === 0);
    const spaces = group.filter((_, i) => i % 2 === 1);
    let first = { error: Infinity, digit: -1 };
    let second = { error: Infinity, digit: -1 };
    for (let digit = 0; digit < 10; digit += 1) {
      const barError = mismatch(bars, ITF_WIDTHS[digit], 7);
      if (barError < first.error) first = { error: barError, digit };
      const spaceError = mismatch(spaces, ITF_WIDTHS[digit], 7);
      if (spaceError < second.error) second = { error: spaceError, digit };
    }
    if (first.digit < 0 || second.digit < 0) return null;
    digits += `${first.digit}${second.digit}`;
    at += 10;
  }
  if (mismatch(runs.slice(at, at + 3), [3, 1, 1], 5) === Infinity) return null;
  return digits.length >= 4 ? { format: "itf", text: digits } : null;
}

/* ------------------------------------------------------------------ Public   */

/**
 * Reads one scan line. Every format is tried at every run offset, because a photograph
 * gives no clue where the quiet zone ended.
 * @param row one entry per pixel across the image, 1 for dark
 */
export function decodeRow(row: ArrayLike<number>): Decoded | null {
  const { widths, darkFirst } = toRuns(row);
  // Symbols start on a bar, so only offsets landing on a dark run are worth trying.
  const first = darkFirst ? 0 : 1;
  for (let from = first; from + 14 < widths.length; from += 2) {
    const found =
      decodeCode128(widths, from) ??
      decodeEan(widths, from, 6) ??
      decodeEan(widths, from, 4) ??
      decodeItf(widths, from) ??
      decodeCode39(widths, from);
    if (found) return found;
  }
  return null;
}
