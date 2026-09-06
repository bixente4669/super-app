/**
 * QR encoder, versions 1-10, which covers any realistic loyalty payload.
 * Produces a square module grid; rendering is the caller's job.
 */

export type EcLevel = "L" | "M" | "Q" | "H";
type Mode = "numeric" | "alphanumeric" | "byte";
/** Per version and EC level: EC codewords per block, then blocks and data per group. */
type BlockSpec = readonly [number, number, number, number, number];

const MODE = { numeric: 0b0001, alphanumeric: 0b0010, byte: 0b0100 };
const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
export const EC_LEVELS: EcLevel[] = ["L", "M", "Q", "H"];
const EC_BITS: Record<EcLevel, number> = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 }; // Not in level order.

/**
 * Per version, per EC level: error-correction codewords per block, then the
 * block count and data codewords for group 1 and group 2.
 */
const EC_TABLE: BlockSpec[][] = [
  [
    [7, 1, 19, 0, 0],
    [10, 1, 16, 0, 0],
    [13, 1, 13, 0, 0],
    [17, 1, 9, 0, 0],
  ],
  [
    [10, 1, 34, 0, 0],
    [16, 1, 28, 0, 0],
    [22, 1, 22, 0, 0],
    [28, 1, 16, 0, 0],
  ],
  [
    [15, 1, 55, 0, 0],
    [26, 1, 44, 0, 0],
    [18, 2, 17, 0, 0],
    [22, 2, 13, 0, 0],
  ],
  [
    [20, 1, 80, 0, 0],
    [18, 2, 32, 0, 0],
    [26, 2, 24, 0, 0],
    [16, 4, 9, 0, 0],
  ],
  [
    [26, 1, 108, 0, 0],
    [24, 2, 43, 0, 0],
    [18, 2, 15, 2, 16],
    [22, 2, 11, 2, 12],
  ],
  [
    [18, 2, 68, 0, 0],
    [16, 4, 27, 0, 0],
    [24, 4, 19, 0, 0],
    [28, 4, 15, 0, 0],
  ],
  [
    [20, 2, 78, 0, 0],
    [18, 4, 31, 0, 0],
    [18, 2, 14, 4, 15],
    [26, 4, 13, 1, 14],
  ],
  [
    [24, 2, 97, 0, 0],
    [22, 2, 38, 2, 39],
    [22, 4, 18, 2, 19],
    [26, 4, 14, 2, 15],
  ],
  [
    [30, 2, 116, 0, 0],
    [22, 3, 36, 2, 37],
    [20, 4, 16, 4, 17],
    [24, 4, 12, 4, 13],
  ],
  [
    [18, 2, 68, 2, 69],
    [26, 4, 43, 1, 44],
    [24, 6, 19, 2, 20],
    [28, 6, 15, 2, 16],
  ],
];

const ALIGNMENT = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/* ------------------------------------------------------------- GF(256) ECC */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i += 1) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d; // QR's primitive polynomial.
}
for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];

const multiply = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generator polynomial for `degree` error-correction codewords. */
function generator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = Array.from({ length: poly.length + 1 }, () => 0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]; // Leading coefficient first, to match
      next[j + 1] ^= multiply(poly[j], EXP[i]); // how errorCorrection() indexes it.
    }
    poly = next;
  }
  return poly;
}

function errorCorrection(data: Iterable<number>, degree: number): Uint8Array {
  const poly = generator(degree);
  const remainder = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[degree - 1] = 0;
    for (let i = 0; i < degree; i += 1) remainder[i] ^= multiply(poly[i + 1], factor);
  }
  return remainder;
}

/* ------------------------------------------------------------ Data encoding */

function chooseMode(text: string): Mode {
  if (/^\d*$/.test(text)) return "numeric";
  if ([...text].every((character) => ALPHANUMERIC.includes(character))) return "alphanumeric";
  return "byte";
}

const countBits = (mode: Mode, version: number): number => {
  if (mode === "numeric") return version < 10 ? 10 : 12;
  if (mode === "alphanumeric") return version < 10 ? 9 : 11;
  return version < 10 ? 8 : 16;
};

class Bits {
  value: number[] = [];

  push(value: number, length: number) {
    for (let i = length - 1; i >= 0; i -= 1) this.value.push((value >> i) & 1);
  }
  get length() {
    return this.value.length;
  }
}

function encodeData(text: string, mode: Mode, version: number): Bits {
  const bits = new Bits();
  bits.push(MODE[mode], 4);
  const bytes = mode === "byte" ? new TextEncoder().encode(text) : new Uint8Array();
  bits.push(mode === "byte" ? bytes.length : text.length, countBits(mode, version));
  if (mode === "numeric") {
    for (let i = 0; i < text.length; i += 3) {
      const group = text.slice(i, i + 3);
      bits.push(Number(group), group.length * 3 + 1);
    }
  } else if (mode === "alphanumeric") {
    for (let i = 0; i < text.length; i += 2) {
      if (i + 1 < text.length) {
        bits.push(ALPHANUMERIC.indexOf(text[i]) * 45 + ALPHANUMERIC.indexOf(text[i + 1]), 11);
      } else {
        bits.push(ALPHANUMERIC.indexOf(text[i]), 6);
      }
    }
  } else {
    for (const byte of bytes) bits.push(byte, 8);
  }
  return bits;
}

const dataCodewords = (spec: BlockSpec): number => spec[1] * spec[2] + spec[3] * spec[4];

function chooseVersion(text: string, mode: Mode, ecLevel: EcLevel): number {
  const ec = EC_LEVELS.indexOf(ecLevel);
  for (let version = 1; version <= EC_TABLE.length; version += 1) {
    const capacity = dataCodewords(EC_TABLE[version - 1][ec]) * 8;
    if (encodeData(text, mode, version).length + 4 <= capacity + 4) {
      if (encodeData(text, mode, version).length <= capacity) return version;
    }
  }
  throw new Error("That value is too long for a QR code at this error-correction level.");
}

/** Terminator, byte alignment, then the alternating pad bytes the spec requires. */
function toCodewords(bits: Bits, total: number): number[] {
  const value = bits.value.slice();
  for (let i = 0; i < 4 && value.length < total * 8; i += 1) value.push(0);
  while (value.length % 8) value.push(0);
  const codewords = [];
  for (let i = 0; i < value.length; i += 8) {
    codewords.push(value.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  }
  for (let i = 0; codewords.length < total; i += 1) codewords.push(i % 2 === 0 ? 0xec : 0x11);
  return codewords;
}

/** Splits into blocks, adds ECC, then interleaves both as the spec requires. */
function interleave(codewords: number[], spec: BlockSpec): number[] {
  const [ecPerBlock, blocks1, data1, blocks2, data2] = spec;
  const blocks = [];
  let at = 0;
  for (let i = 0; i < blocks1 + blocks2; i += 1) {
    const size = i < blocks1 ? data1 : data2;
    const data = codewords.slice(at, at + size);
    at += size;
    blocks.push({ data, ec: errorCorrection(data, ecPerBlock) });
  }
  const out = [];
  for (let i = 0; i < Math.max(data1, data2); i += 1) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  }
  for (let i = 0; i < ecPerBlock; i += 1) for (const block of blocks) out.push(block.ec[i]);
  return out;
}

/* --------------------------------------------------------- Module placement */

const RESERVED = 2; // Function-pattern marker, kept out of the data path and masking.

function placeFunctionPatterns(grid: Uint8Array, size: number, version: number) {
  const set = (x: number, y: number, value: number) => {
    if (x >= 0 && y >= 0 && x < size && y < size) grid[y * size + x] = value;
  };
  for (const [ox, oy] of [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ]) {
    for (let y = -1; y <= 7; y += 1) {
      for (let x = -1; x <= 7; x += 1) {
        const edge = x === 0 || x === 6 || y === 0 || y === 6;
        const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        const inside = x >= 0 && x <= 6 && y >= 0 && y <= 6;
        set(ox + x, oy + y, RESERVED | (inside && (edge || core) ? 1 : 0));
      }
    }
  }
  for (let i = 8; i < size - 8; i += 1) {
    const bit = i % 2 === 0 ? 1 : 0;
    grid[6 * size + i] = RESERVED | bit;
    grid[i * size + 6] = RESERVED | bit;
  }
  const centres = ALIGNMENT[version - 1];
  const last = centres.length - 1;
  for (let row = 0; row <= last; row += 1) {
    for (let column = 0; column <= last; column += 1) {
      // The three corners hosting finder patterns have no alignment pattern.
      const corner =
        (row === 0 && column === 0) ||
        (row === 0 && column === last) ||
        (row === last && column === 0);
      if (corner) continue;
      for (let y = -2; y <= 2; y += 1) {
        for (let x = -2; x <= 2; x += 1) {
          const ring = Math.max(Math.abs(x), Math.abs(y));
          set(centres[column] + x, centres[row] + y, RESERVED | (ring !== 1 ? 1 : 0));
        }
      }
    }
  }
  grid[(size - 8) * size + 8] = RESERVED | 1; // The always-dark module.
  for (let i = 0; i < 9; i += 1) {
    // Reserve the format-information areas.
    if (!(grid[8 * size + i] & RESERVED)) grid[8 * size + i] = RESERVED;
    if (!(grid[i * size + 8] & RESERVED)) grid[i * size + 8] = RESERVED;
  }
  for (let i = 0; i < 8; i += 1) {
    if (!(grid[8 * size + (size - 1 - i)] & RESERVED)) grid[8 * size + (size - 1 - i)] = RESERVED;
    if (!(grid[(size - 1 - i) * size + 8] & RESERVED)) grid[(size - 1 - i) * size + 8] = RESERVED;
  }
}

/** Walks the two-module-wide zigzag from bottom right, skipping the timing column. */
function placeData(grid: Uint8Array, size: number, codewords: number[]) {
  let bit = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right -= 1;
    for (let step = 0; step < size; step += 1) {
      const up = ((size - 1 - right) & 2) === 0;
      const y = up ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (grid[y * size + x] & RESERVED) continue;
        const value = bit < total ? (codewords[bit >> 3] >> (7 - (bit & 7))) & 1 : 0;
        grid[y * size + x] = value;
        bit += 1;
      }
    }
  }
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x, _y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** The four penalty rules from the spec; the lowest total wins. */
function penalty(grid: Uint8Array, size: number): number {
  const at = (x: number, y: number) => grid[y * size + x] & 1;
  let score = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
      ]) {
        if ((dx && x) || (dy && y)) continue;
        let run = 1;
        for (let i = 1; i < size; i += 1) {
          const nx = x + dx * i;
          const ny = y + dy * i;
          if (nx >= size || ny >= size) break;
          if (at(nx, ny) === at(nx - dx, ny - dy)) run += 1;
          else {
            if (run >= 5) score += run - 2;
            run = 1;
          }
        }
        if (run >= 5) score += run - 2;
      }
      if (
        x + 1 < size &&
        y + 1 < size &&
        at(x, y) === at(x + 1, y) &&
        at(x, y) === at(x, y + 1) &&
        at(x, y) === at(x + 1, y + 1)
      ) {
        score += 3;
      }
    }
  }
  const finder = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
      ]) {
        if (x + dx * 10 >= size || y + dy * 10 >= size) continue;
        if (finder.every((bit, i) => at(x + dx * i, y + dy * i) === bit)) score += 40;
        if (finder.every((bit, i) => at(x + dx * (10 - i), y + dy * (10 - i)) === bit)) score += 40;
      }
    }
  }
  let dark = 0;
  for (let i = 0; i < size * size; i += 1) dark += grid[i] & 1;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/** Appends BCH error correction of `bits` parity bits under `poly`. */
function bch(value: number, poly: number, bits: number): number {
  let remainder = value;
  for (let i = 0; i < bits; i += 1)
    remainder = (remainder << 1) ^ ((remainder >>> (bits - 1)) * poly);
  return (value << bits) | remainder;
}

function placeFormat(grid: Uint8Array, size: number, ecLevel: EcLevel, mask: number) {
  const bits = bch((EC_BITS[ecLevel] << 3) | mask, 0x537, 10) ^ 0x5412;
  const bit = (i: number) => (bits >>> i) & 1;
  const set = (column: number, row: number, value: number) => {
    grid[row * size + column] = RESERVED | value;
  };
  // Copy one wraps the top-left finder, skipping the timing row and column.
  for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));
  // Copy two is split between the other two finders.
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i));
  set(8, size - 8, 1); // The always-dark module.
}

function placeVersion(grid: Uint8Array, size: number, version: number) {
  if (version < 7) return;
  const info = bch(version, 0x1f25, 12);
  for (let i = 0; i < 18; i += 1) {
    const value = RESERVED | ((info >>> i) & 1);
    grid[Math.floor(i / 3) * size + (size - 11 + (i % 3))] = value;
    grid[(size - 11 + (i % 3)) * size + Math.floor(i / 3)] = value;
  }
}

/** A rendered QR grid. `modules` holds one byte per cell, 1 for a dark module. */
export interface QrSymbol {
  size: number;
  modules: Uint8Array;
  version: number;
  ecLevel: EcLevel;
}

export function encodeQr(text: string, { ecLevel = "M" as EcLevel } = {}): QrSymbol {
  if (!text) throw new Error("Enter a value to encode.");
  if (!EC_LEVELS.includes(ecLevel)) throw new Error(`Unknown error-correction level ${ecLevel}.`);
  const mode = chooseMode(text);
  const version = chooseVersion(text, mode, ecLevel);
  const spec = EC_TABLE[version - 1][EC_LEVELS.indexOf(ecLevel)];
  const codewords = interleave(
    toCodewords(encodeData(text, mode, version), dataCodewords(spec)),
    spec,
  );
  const size = 17 + version * 4;

  const base = new Uint8Array(size * size);
  placeFunctionPatterns(base, size, version);
  placeVersion(base, size, version);
  placeData(base, size, codewords);

  let best: { score: number; grid: Uint8Array } | null = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const grid = base.slice();
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (!(grid[y * size + x] & RESERVED) && MASKS[mask](x, y)) grid[y * size + x] ^= 1;
      }
    }
    placeFormat(grid, size, ecLevel, mask);
    const score = penalty(grid, size);
    if (!best || score < best.score) best = { score, grid };
  }
  return { size, modules: best!.grid.map((cell) => cell & 1), version, ecLevel };
}

/**
 * Internals the decoder needs. Reading a QR is the encoder run backwards, so sharing
 * these keeps the two from disagreeing: a table copied into both is a table that can
 * drift.
 */
export const QR_INTERNALS = {
  EC_TABLE,
  EC_LEVELS,
  EC_BITS,
  MASKS,
  ALIGNMENT,
  EXP,
  LOG,
  multiply,
  bch,
  /** One byte per cell, 1 where a function pattern or reserved area sits. */
  reserved: (version: number): Uint8Array => {
    const size = 17 + version * 4;
    const grid = new Uint8Array(size * size);
    placeFunctionPatterns(grid, size, version);
    placeVersion(grid, size, version);
    return grid.map((cell) => (cell & RESERVED ? 1 : 0));
  },
  /** Data codewords per block, as [ecPerBlock, blocks1, data1, blocks2, data2]. */
  spec: (version: number, ecLevel: EcLevel): BlockSpec =>
    EC_TABLE[version - 1][EC_LEVELS.indexOf(ecLevel)],
};
