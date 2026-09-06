/**
 * Linear barcode encoders. Every symbol becomes a module string where "1" is a bar
 * and "0" is a space, so rendering stays independent of the format.
 */

export type FormatId =
  | "code128"
  | "ean13"
  | "ean8"
  | "upca"
  | "code39"
  | "itf"
  | "qr"
  | "pdf417"
  | "none";

export interface Format {
  id: FormatId;
  label: string;
  /** A few words for the format gallery, where space is tight. */
  short: string;
  /** The fuller explanation shown under the format picker. */
  hint: string;
}

/** An encoded linear symbol, ready to draw. */
export interface Symbol {
  /** One character per module: "1" is a bar, "0" a space. */
  modules: string;
  /** Blank modules required either side for a scanner to read it. */
  quiet: number;
  /** The human-readable value printed beneath. */
  text: string;
  /** Module ranges drawn full height, as EAN and UPC guard bars are. */
  guards: number[][];
}

export const FORMATS: Format[] = [
  {
    id: "code128",
    label: "Code 128",
    short: "Letters and digits",
    hint: "Letters, digits and punctuation. The usual choice when nothing else fits.",
  },
  {
    id: "ean13",
    label: "EAN-13",
    short: "13 digits",
    hint: "13 digits (12 plus a check digit, which is added for you).",
  },
  { id: "ean8", label: "EAN-8", short: "8 digits", hint: "8 digits (7 plus a check digit)." },
  {
    id: "upca",
    label: "UPC-A",
    short: "12 digits",
    hint: "12 digits (11 plus a check digit). Common on North American cards.",
  },
  {
    id: "code39",
    label: "Code 39",
    short: "Digits and A–Z",
    hint: "Digits, capital A-Z, and - . $ / + % and space.",
  },
  {
    id: "itf",
    label: "Interleaved 2 of 5",
    short: "Digits, even count",
    hint: "Digits only, in an even-length run.",
  },
  {
    id: "qr",
    label: "QR code",
    short: "Square block",
    hint: "Any text. Used by X5 \u041a\u043b\u0443\u0431, \u041a\u0430\u043b\u0438\u043d\u0430-\u041c\u0430\u043b\u0438\u043d\u0430 and AM Wine.",
  },
  {
    id: "pdf417",
    label: "PDF417",
    short: "Stacked rows",
    hint: "Stacked code used by \u041b\u0435\u043d\u0442\u0430. Not drawn yet.",
  },
  { id: "none", label: "No barcode", short: "Number only", hint: "Store the number as text only." },
];

const FORMAT_IDS = new Set<string>(FORMATS.map((format) => format.id));
export const isFormat = (id: string): id is FormatId => FORMAT_IDS.has(id);
export const formatLabel = (id: string): string =>
  FORMATS.find((format) => format.id === id)?.label ?? "No barcode";

/** GTIN check digit: weights 3 and 1 alternating from the rightmost supplied digit. */
export function checkDigit(digits: string): number {
  let sum = 0;
  let weight = 3;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    sum += Number(digits[i]) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10;
}

/** Expands a width pattern such as "212222" into modules, starting with a bar. */
function widthsToModules(widths: Iterable<string | number>, startsWithBar = true): string {
  let modules = "";
  let bar = startsWithBar;
  for (const width of widths) {
    modules += (bar ? "1" : "0").repeat(Number(width));
    bar = !bar;
  }
  return modules;
}

/* ---------------------------------------------------------------- Code 128 */

const CODE128 = [
  "212222",
  "222122",
  "222221",
  "121223",
  "121322",
  "131222",
  "122213",
  "122312",
  "132212",
  "221213",
  "221312",
  "231212",
  "112232",
  "122132",
  "122231",
  "113222",
  "123122",
  "123221",
  "223211",
  "221132",
  "221231",
  "213212",
  "223112",
  "312131",
  "311222",
  "321122",
  "321221",
  "312212",
  "322112",
  "322211",
  "212123",
  "212321",
  "232121",
  "111323",
  "131123",
  "131321",
  "112313",
  "132113",
  "132311",
  "211313",
  "231113",
  "231311",
  "112133",
  "112331",
  "132131",
  "113123",
  "113321",
  "133121",
  "313121",
  "211331",
  "231131",
  "213113",
  "213311",
  "213131",
  "311123",
  "311321",
  "331121",
  "312113",
  "312311",
  "332111",
  "314111",
  "221411",
  "431111",
  "111224",
  "111422",
  "121124",
  "121421",
  "141122",
  "141221",
  "112214",
  "112412",
  "122114",
  "122411",
  "142112",
  "142211",
  "241211",
  "221114",
  "413111",
  "241112",
  "134111",
  "111242",
  "121142",
  "121241",
  "114212",
  "124112",
  "124211",
  "411212",
  "421112",
  "421211",
  "212141",
  "214121",
  "412121",
  "111143",
  "111341",
  "131141",
  "114113",
  "114311",
  "411113",
  "411311",
  "113141",
  "114131",
  "311141",
  "411131",
  "211412",
  "211214",
  "211232",
  "2331112",
];
const CODE_C = 99,
  CODE_B = 100,
  START_B = 104,
  START_C = 105,
  STOP = 106;

function digitRun(text: string, from: number): number {
  let length = 0;
  while (from + length < text.length && text[from + length] >= "0" && text[from + length] <= "9")
    length += 1;
  return length;
}

/** Greedy A/B/C selection: code set C for digit runs, code set B for everything else. */
function code128Values(text: string): number[] {
  const leading = digitRun(text, 0);
  const startsInC = leading >= 4 || (leading === text.length && leading >= 2 && leading % 2 === 0);
  const values = [startsInC ? START_C : START_B];
  let inC = startsInC;
  let at = 0;
  while (at < text.length) {
    const run = digitRun(text, at);
    if (inC) {
      if (run >= 2) {
        for (let pair = 0; pair < Math.floor(run / 2); pair += 1) {
          values.push(Number(text.slice(at, at + 2)));
          at += 2;
        }
        continue;
      }
      values.push(CODE_B);
      inC = false;
      continue;
    }
    if (run >= 4) {
      if (run % 2 === 1) values.push(text.charCodeAt(at++) - 32); // Align C on an even boundary.
      values.push(CODE_C);
      inC = true;
      continue;
    }
    values.push(text.charCodeAt(at++) - 32);
  }
  let checksum = values[0];
  for (let i = 1; i < values.length; i += 1) checksum += values[i] * i;
  values.push(checksum % 103, STOP);
  return values;
}

function encodeCode128(value: string): Symbol {
  if (!value) throw new Error("Enter a card number.");
  if (!/^[\x20-\x7e]+$/.test(value))
    throw new Error("Code 128 supports plain ASCII characters only.");
  const modules = code128Values(value)
    .map((code) => widthsToModules(CODE128[code]))
    .join("");
  return { modules, quiet: 10, text: value, guards: [] };
}

/* ------------------------------------------------------------ EAN and UPC  */

const EAN_L = [
  "0001101",
  "0011001",
  "0010011",
  "0111101",
  "0100011",
  "0110001",
  "0101111",
  "0111011",
  "0110111",
  "0001011",
];
const EAN_G = [
  "0100111",
  "0110011",
  "0011011",
  "0100001",
  "0011101",
  "0111001",
  "0000101",
  "0010001",
  "0001001",
  "0010111",
];
const EAN_R = [
  "1110010",
  "1100110",
  "1101100",
  "1000010",
  "1011100",
  "1001110",
  "1010000",
  "1000100",
  "1001000",
  "1110100",
];
const EAN_PARITY = [
  "LLLLLL",
  "LLGLGG",
  "LLGGLG",
  "LLGGGL",
  "LGLLGG",
  "LGGLLG",
  "LGGGLL",
  "LGLGLG",
  "LGLGGL",
  "LGGLGL",
];

/** Accepts the value with or without its trailing check digit, and verifies it when present. */
function normaliseGtin(value: string, total: number, label: string): string {
  if (!/^\d+$/.test(value)) throw new Error(`${label} accepts digits only.`);
  if (value.length === total - 1) return value + checkDigit(value);
  if (value.length !== total)
    throw new Error(`${label} needs ${total - 1} or ${total} digits, not ${value.length}.`);
  if (Number(value[total - 1]) !== checkDigit(value.slice(0, total - 1))) {
    throw new Error(
      `That is ${total} digits but the check digit is wrong. Re-read the last digit, or enter the first ${total - 1}.`,
    );
  }
  return value;
}

function encodeEan13(
  value: string,
  { label = "EAN-13", text = null as string | null } = {},
): Symbol {
  const digits = normaliseGtin(value, 13, label);
  const parity = EAN_PARITY[Number(digits[0])];
  let modules = "101";
  for (let i = 1; i <= 6; i += 1)
    modules += (parity[i - 1] === "L" ? EAN_L : EAN_G)[Number(digits[i])];
  const middle = modules.length;
  modules += "01010";
  for (let i = 7; i <= 12; i += 1) modules += EAN_R[Number(digits[i])];
  const end = modules.length;
  modules += "101";
  return {
    modules,
    quiet: 11,
    text: text ?? digits,
    guards: [
      [0, 3],
      [middle, middle + 5],
      [end, end + 3],
    ],
  };
}

function encodeEan8(value: string): Symbol {
  const digits = normaliseGtin(value, 8, "EAN-8");
  let modules = "101";
  for (let i = 0; i < 4; i += 1) modules += EAN_L[Number(digits[i])];
  const middle = modules.length;
  modules += "01010";
  for (let i = 4; i < 8; i += 1) modules += EAN_R[Number(digits[i])];
  const end = modules.length;
  modules += "101";
  return {
    modules,
    quiet: 9,
    text: digits,
    guards: [
      [0, 3],
      [middle, middle + 5],
      [end, end + 3],
    ],
  };
}

// UPC-A is EAN-13 with a leading zero; only the printed digits differ.
function encodeUpcA(value: string): Symbol {
  const digits = normaliseGtin(value, 12, "UPC-A");
  return encodeEan13(`0${digits}`, { label: "UPC-A", text: digits });
}

/* ----------------------------------------------------------------- Code 39 */

const CODE39: Record<string, string> = {
  0: "nnnwwnwnn",
  1: "wnnwnnnnw",
  2: "nnwwnnnnw",
  3: "wnwwnnnnn",
  4: "nnnwwnnnw",
  5: "wnnwwnnnn",
  6: "nnwwwnnnn",
  7: "nnnwnnwnw",
  8: "wnnwnnwnn",
  9: "nnwwnnwnn",
  A: "wnnnnwnnw",
  B: "nnwnnwnnw",
  C: "wnwnnwnnn",
  D: "nnnnwwnnw",
  E: "wnnnwwnnn",
  F: "nnwnwwnnn",
  G: "nnnnnwwnw",
  H: "wnnnnwwnn",
  I: "nnwnnwwnn",
  J: "nnnnwwwnn",
  K: "wnnnnnnww",
  L: "nnwnnnnww",
  M: "wnwnnnnwn",
  N: "nnnnwnnww",
  O: "wnnnwnnwn",
  P: "nnwnwnnwn",
  Q: "nnnnnnwww",
  R: "wnnnnnwwn",
  S: "nnwnnnwwn",
  T: "nnnnwnwwn",
  U: "wwnnnnnnw",
  V: "nwwnnnnnw",
  W: "wwwnnnnnn",
  X: "nwnnwnnnw",
  Y: "wwnnwnnnn",
  Z: "nwwnwnnnn",
  "-": "nwnnnnwnw",
  ".": "wwnnnnwnn",
  " ": "nwwnnnwnn",
  $: "nwnwnwnnn",
  "/": "nwnwnnnwn",
  "+": "nwnnnwnwn",
  "%": "nnnwnwnwn",
  "*": "nwnnwnwnn",
};

function encodeCode39(value: string): Symbol {
  const text = value.toUpperCase();
  if (!text) throw new Error("Enter a card number.");
  for (const character of text) {
    if (!(character in CODE39) || character === "*") {
      throw new Error(
        `Code 39 cannot encode "${character}". Use digits, A-Z, or - . $ / + % and space.`,
      );
    }
  }
  // Narrow modules are 1 wide, wide modules 3, and characters are separated by one narrow space.
  const modules = [...`*${text}*`]
    .map((character) =>
      widthsToModules([...CODE39[character]].map((size) => (size === "w" ? 3 : 1))),
    )
    .join("0");
  return { modules, quiet: 10, text, guards: [] };
}

/* ------------------------------------------------- Interleaved 2 of 5 (ITF) */

const ITF = [
  "nnwwn",
  "wnnnw",
  "nwnnw",
  "wwnnn",
  "nnwnw",
  "wnwnn",
  "nwwnn",
  "nnnww",
  "wnnwn",
  "nwnwn",
];

function encodeItf(value: string): Symbol {
  if (!/^\d+$/.test(value)) throw new Error("Interleaved 2 of 5 accepts digits only.");
  const digits = value.length % 2 === 0 ? value : `0${value}`; // Pad so the digits interleave in pairs.
  let modules = "1010"; // Start pattern.
  for (let i = 0; i < digits.length; i += 2) {
    const bars = ITF[Number(digits[i])];
    const spaces = ITF[Number(digits[i + 1])];
    for (let k = 0; k < 5; k += 1) {
      modules += "1".repeat(bars[k] === "w" ? 3 : 1);
      modules += "0".repeat(spaces[k] === "w" ? 3 : 1);
    }
  }
  modules += "11101"; // Stop pattern: wide bar, narrow space, narrow bar.
  return { modules, quiet: 10, text: digits, guards: [] };
}

/* ------------------------------------------------------------------ Public */

const ENCODERS: Record<string, (value: string) => Symbol> = {
  code128: encodeCode128,
  ean13: (value) => encodeEan13(value),
  ean8: encodeEan8,
  upca: encodeUpcA,
  code39: encodeCode39,
  itf: encodeItf,
};

/** @throws with a message safe to show the user when `value` does not fit `format`. */
export function encode(format: string, value: string): Symbol {
  const encoder = ENCODERS[format];
  if (!encoder) throw new Error("This card has no barcode format set.");
  return encoder(value.trim());
}

/** True when `value` can be encoded as `format`, used to grey out impossible choices. */
export function fits(format: string, value: string): boolean {
  if (format === "none") return true;
  try {
    encode(format, value);
    return true;
  } catch {
    return false;
  }
}

/** Best guess for a freshly typed or freshly scanned number. */
export function suggestFormat(value: string): FormatId {
  const text = value.trim();
  if (!text) return "none";
  if (/^\d{13}$/.test(text) && Number(text[12]) === checkDigit(text.slice(0, 12))) return "ean13";
  if (/^\d{12}$/.test(text) && Number(text[11]) === checkDigit(text.slice(0, 11))) return "upca";
  if (/^\d{8}$/.test(text) && Number(text[7]) === checkDigit(text.slice(0, 7))) return "ean8";
  if (/^[\x20-\x7e]+$/.test(text)) return "code128";
  return "none";
}

/** Pattern tables, exported so scripts/test.js can check their structural invariants. */
export const TABLES = { CODE128, EAN_L, EAN_G, EAN_R, EAN_PARITY, CODE39, ITF };
