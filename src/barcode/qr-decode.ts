/**
 * Reading a QR grid: the encoder run backwards, plus the error correction that makes
 * a photographed code readable at all.
 *
 * This half takes a clean grid of modules, which lets it be tested directly against
 * the encoder, damage included. Finding that grid in a photograph is scan.ts's job.
 */
import { type EcLevel, QR_INTERNALS } from "./qr.js";

const { EC_LEVELS, EC_BITS, MASKS, EXP, LOG, multiply, bch, reserved, spec } = QR_INTERNALS;

const inverse = (value: number) => EXP[255 - LOG[value]];

/* --------------------------------------------------- Reed-Solomon decoding */

/** Polynomials are coefficient-first: poly[0] multiplies the highest power. */
const polyEval = (poly: number[], x: number) =>
  poly.reduce((value, coefficient) => multiply(value, x) ^ coefficient, 0);

/** Coefficient-wise XOR, right-aligned so the two need not be the same length. */
function polyAdd(a: number[], b: number[]): number[] {
  const out = new Array(Math.max(a.length, b.length)).fill(0);
  for (let i = 0; i < a.length; i += 1) out[i + out.length - a.length] ^= a[i];
  for (let i = 0; i < b.length; i += 1) out[i + out.length - b.length] ^= b[i];
  return out;
}

const polyScale = (poly: number[], factor: number) => poly.map((c) => multiply(c, factor));

/**
 * Corrects up to `ecCount / 2` wrong codewords.
 *
 * The index convention is the thing to keep straight: block[0] carries the highest
 * power, so a root at alpha^-i means the error sits at block[length - 1 - i]. Getting
 * that backwards yields a decoder that only ever works on undamaged data.
 *
 * @returns the data codewords, or null when the damage is past correcting
 */
function correct(block: Uint8Array, ecCount: number): Uint8Array | null {
  const length = block.length;
  const received = [...block];

  const syndromes: number[] = [];
  let damaged = false;
  for (let i = 0; i < ecCount; i += 1) {
    const value = polyEval(received, EXP[i]);
    syndromes.push(value);
    if (value) damaged = true;
  }
  if (!damaged) return block.slice(0, length - ecCount);

  // Berlekamp-Massey, inversionless form, giving the error locator sigma.
  let sigma = [1];
  let previous = [1];
  for (let i = 0; i < ecCount; i += 1) {
    let discrepancy = syndromes[i];
    for (let j = 1; j < sigma.length; j += 1) {
      discrepancy ^= multiply(sigma[sigma.length - 1 - j], syndromes[i - j]);
    }
    previous = [...previous, 0];
    if (discrepancy !== 0) {
      if (previous.length > sigma.length) {
        const next = polyScale(previous, discrepancy);
        previous = polyScale(sigma, inverse(discrepancy));
        sigma = next;
      }
      sigma = polyAdd(sigma, polyScale(previous, discrepancy));
    }
  }

  const errors = sigma.length - 1;
  if (errors === 0 || errors * 2 > ecCount) return null;

  // Chien search: sigma(alpha^-i) === 0 marks an error at block[length - 1 - i].
  const positions: number[] = [];
  for (let i = 0; i < length; i += 1) {
    if (polyEval(sigma, inverse(EXP[i % 255])) === 0) positions.push(length - 1 - i);
  }
  if (positions.length !== errors) return null;

  // Forney: omega = syndromes * sigma truncated to ecCount terms.
  const reversed = [...syndromes].reverse();
  const product = new Array(reversed.length + sigma.length - 1).fill(0);
  for (let i = 0; i < reversed.length; i += 1) {
    for (let j = 0; j < sigma.length; j += 1) {
      product[i + j] ^= multiply(reversed[i], sigma[j]);
    }
  }
  const omega = product.slice(product.length - ecCount);

  // The formal derivative of sigma keeps only its odd-power terms.
  const derivative: number[] = [];
  for (let i = 0; i < sigma.length - 1; i += 1) {
    if ((sigma.length - 1 - i) % 2 === 1) derivative.push(sigma[i]);
    else derivative.push(0);
  }

  for (const position of positions) {
    const x = EXP[(length - 1 - position) % 255];
    const xInverse = inverse(x);
    const bottom = polyEval(derivative, xInverse);
    if (bottom === 0) return null;
    // The leading X_k belongs here because the generator's roots start at alpha^0.
    const magnitude = multiply(x, multiply(polyEval(omega, xInverse), inverse(bottom)));
    received[position] ^= magnitude;
  }

  // Prove it rather than hope: a corrected block has zero syndromes.
  for (let i = 0; i < ecCount; i += 1) {
    if (polyEval(received, EXP[i]) !== 0) return null;
  }
  return Uint8Array.from(received.slice(0, length - ecCount));
}

/* ------------------------------------------------------------ Grid reading */

/** Both copies of the format information, BCH-corrected, best match wins. */
function readFormat(grid: Uint8Array, size: number): { ecLevel: EcLevel; mask: number } | null {
  const at = (column: number, row: number) => grid[row * size + column] & 1;
  const copies = [0, 0];
  for (let i = 0; i <= 5; i += 1) copies[0] |= at(8, i) << i;
  copies[0] |= at(8, 7) << 6;
  copies[0] |= at(8, 8) << 7;
  copies[0] |= at(7, 8) << 8;
  for (let i = 9; i < 15; i += 1) copies[0] |= at(14 - i, 8) << i;
  for (let i = 0; i < 8; i += 1) copies[1] |= at(size - 1 - i, 8) << i;
  for (let i = 8; i < 15; i += 1) copies[1] |= at(8, size - 15 + i) << i;

  let best = { distance: 5, ecLevel: "M" as EcLevel, mask: 0 };
  for (const raw of copies) {
    const bits = raw ^ 0x5412;
    for (const ecLevel of EC_LEVELS) {
      for (let mask = 0; mask < 8; mask += 1) {
        const candidate = bch((EC_BITS[ecLevel] << 3) | mask, 0x537, 10);
        const distance = popcount(candidate ^ bits);
        if (distance < best.distance) best = { distance, ecLevel, mask };
      }
    }
  }
  return best.distance <= 3 ? { ecLevel: best.ecLevel, mask: best.mask } : null;
}

const popcount = (value: number) => {
  let count = 0;
  for (let bits = value; bits; bits >>= 1) count += bits & 1;
  return count;
};

/** Walks the zigzag the encoder wrote, collecting bits into codewords. */
function readCodewords(grid: Uint8Array, size: number, skip: Uint8Array): number[] {
  const bits: number[] = [];
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right -= 1;
    for (let step = 0; step < size; step += 1) {
      const up = ((size - 1 - right) & 2) === 0;
      const y = up ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (skip[y * size + x]) continue;
        bits.push(grid[y * size + x] & 1);
      }
    }
  }
  const codewords: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  }
  return codewords;
}

/** Undoes the interleave, then corrects each block. */
function deinterleave(codewords: number[], version: number, ecLevel: EcLevel): Uint8Array | null {
  const [ecPerBlock, blocks1, data1, blocks2, data2] = spec(version, ecLevel);
  const blocks: number[][] = [];
  for (let i = 0; i < blocks1 + blocks2; i += 1) blocks.push([]);
  let at = 0;
  for (let i = 0; i < Math.max(data1, data2); i += 1) {
    for (let b = 0; b < blocks.length; b += 1) {
      const size = b < blocks1 ? data1 : data2;
      if (i < size) blocks[b].push(codewords[at++]);
    }
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const block of blocks) block.push(codewords[at++]);
  }
  const out: number[] = [];
  for (const block of blocks) {
    const fixed = correct(Uint8Array.from(block), ecPerBlock);
    if (!fixed) return null;
    out.push(...fixed);
  }
  return Uint8Array.from(out);
}

/* ------------------------------------------------------------ Data segments */

const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

function readSegments(data: Uint8Array, version: number): string | null {
  const bits: number[] = [];
  for (const byte of data) for (let i = 7; i >= 0; i -= 1) bits.push((byte >> i) & 1);
  let at = 0;
  const take = (count: number) => {
    let value = 0;
    for (let i = 0; i < count; i += 1) value = (value << 1) | (bits[at++] ?? 0);
    return value;
  };
  let text = "";
  const bytes: number[] = [];
  while (at + 4 <= bits.length) {
    const mode = take(4);
    if (mode === 0) break; // Terminator.
    if (mode === 1) {
      const count = take(version < 10 ? 10 : 12);
      for (let i = 0; i < count; i += 3) {
        const digits = Math.min(3, count - i);
        text += String(take(digits * 3 + 1)).padStart(digits, "0");
      }
    } else if (mode === 2) {
      const count = take(version < 10 ? 9 : 11);
      for (let i = 0; i < count; i += 2) {
        if (count - i >= 2) {
          const pair = take(11);
          text += ALPHANUMERIC[Math.floor(pair / 45)] + ALPHANUMERIC[pair % 45];
        } else {
          text += ALPHANUMERIC[take(6)];
        }
      }
    } else if (mode === 4) {
      const count = take(version < 10 ? 8 : 16);
      for (let i = 0; i < count; i += 1) bytes.push(take(8));
      text += new TextDecoder().decode(Uint8Array.from(bytes.splice(0, bytes.length)));
    } else {
      return null; // Kanji, ECI, structured append: not produced by this app.
    }
  }
  return text || null;
}

/**
 * @param grid one byte per module, 1 for dark, row-major
 * @returns the text, or null when the grid is not a readable QR
 */
export function decodeQrGrid(grid: Uint8Array, size: number): string | null {
  if (size < 21 || (size - 17) % 4 !== 0) return null;
  const version = (size - 17) / 4;
  const format = readFormat(grid, size);
  if (!format) return null;

  const skip = reserved(version);
  // The format areas are written after masking, so they are never data either.
  for (let i = 0; i < 9; i += 1) {
    skip[8 * size + i] = 1;
    skip[i * size + 8] = 1;
  }
  for (let i = 0; i < 8; i += 1) {
    skip[8 * size + (size - 1 - i)] = 1;
    skip[(size - 1 - i) * size + 8] = 1;
  }

  const unmasked = grid.slice();
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!skip[y * size + x] && MASKS[format.mask](x, y)) unmasked[y * size + x] ^= 1;
    }
  }
  const data = deinterleave(readCodewords(unmasked, size, skip), version, format.ecLevel);
  return data ? readSegments(data, version) : null;
}

/** Exposed so the correction can be exercised on its own, away from grid handling. */
export const QR_DECODE_INTERNALS = { correct };
