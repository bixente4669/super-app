// Verifies the barcode tables and encoders: vp test
// The encoders are hand-written, so these checks stand in for a trusted library.
import { test } from "vitest";
import assert from "node:assert/strict";
import { encode, checkDigit, suggestFormat, fits, TABLES } from "./encode.js";

const { CODE128, EAN_L, EAN_G, EAN_R, EAN_PARITY, CODE39, ITF } = TABLES;

const widthsToModules = (widths: string, bar = true) =>
  [...widths].reduce((acc, width) => {
    const next = acc + (bar ? "1" : "0").repeat(Number(width));
    bar = !bar;
    return next;
  }, "");

/** Splits a module string into [character, length] runs. */
function runs(modules: string): [string, number][] {
  const out: [string, number][] = [];
  for (let i = 0; i < modules.length;) {
    let j = i;
    while (j < modules.length && modules[j] === modules[i]) j += 1;
    out.push([modules[i]!, j - i]);
    i = j;
  }
  return out;
}

/* --------------------------------------------- Structural table invariants */

test("Code 128 patterns are 11 modules, and the stop pattern is 13", () => {
  assert.equal(CODE128.length, 107);
  CODE128.slice(0, 106).forEach((pattern, value) => {
    assert.equal(pattern.length, 6, `value ${value} must have 6 elements`);
    assert.equal(
      [...pattern].reduce((sum, n) => sum + Number(n), 0),
      11,
      `value ${value} must span 11 modules`,
    );
  });
  assert.equal(
    [...CODE128[106]].reduce((sum, n) => sum + Number(n), 0),
    13,
  );
  assert.equal(new Set(CODE128).size, 107, "patterns must be unique");
});

test("EAN tables obey their defining relationships", () => {
  // An independently written L table: a typo in either copy makes these fail.
  const referenceL = [
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
  for (let digit = 0; digit < 10; digit += 1) {
    assert.equal(EAN_L[digit], referenceL[digit], `L${digit}`);
    const complement = [...EAN_L[digit]].map((bit) => (bit === "1" ? "0" : "1")).join("");
    assert.equal(EAN_R[digit], complement, `R${digit} is the complement of L${digit}`);
    assert.equal(
      EAN_G[digit],
      [...EAN_R[digit]].reverse().join(""),
      `G${digit} is R${digit} reversed`,
    );
    const bars = [...EAN_L[digit]].filter((bit) => bit === "1").length;
    assert.equal(bars % 2, 1, `L${digit} must have odd parity`);
  }
  assert.equal(EAN_PARITY.length, 10);
  assert.equal(EAN_PARITY[0], "LLLLLL");
  EAN_PARITY.forEach((pattern) => assert.match(pattern, /^[LG]{6}$/));
});

test("Code 39 patterns are 9 elements with exactly 3 wide", () => {
  for (const [character, pattern] of Object.entries(CODE39)) {
    assert.equal(pattern.length, 9, character);
    const bars = [...pattern].filter((size, i) => i % 2 === 0 && size === "w").length;
    const spaces = [...pattern].filter((size, i) => i % 2 === 1 && size === "w").length;
    assert.equal(bars + spaces, 3, `${character} must have 3 wide elements`);
    // Most characters are 2 wide bars and 1 wide space; $ / + % are 3 wide spaces.
    const shape = `${bars}/${spaces}`;
    assert.ok(shape === "2/1" || shape === "0/3", `${character} has an invalid shape ${shape}`);
    if (shape === "0/3")
      assert.ok("$/+%".includes(character), `${character} may not use the 0/3 shape`);
  }
  assert.equal(
    new Set(Object.values(CODE39)).size,
    Object.keys(CODE39).length,
    "patterns must be unique",
  );
});

test("ITF patterns are 5 elements with 2 wide", () => {
  assert.equal(ITF.length, 10);
  for (const pattern of ITF) {
    assert.equal(pattern.length, 5);
    assert.equal([...pattern].filter((size) => size === "w").length, 2);
  }
});

/* ---------------------------------------------------------- Round tripping */

function decodeEan(modules: string, digitsPerSide: number): string {
  const width = digitsPerSide * 7;
  assert.equal(modules.length, 6 + 5 + width * 2);
  assert.equal(modules.slice(0, 3), "101", "left guard");
  assert.equal(modules.slice(3 + width, 8 + width), "01010", "centre guard");
  assert.equal(modules.slice(-3), "101", "right guard");
  let parity = "";
  let digits = "";
  for (let i = 0; i < digitsPerSide; i += 1) {
    const chunk = modules.slice(3 + i * 7, 10 + i * 7);
    const asL = EAN_L.indexOf(chunk);
    const asG = EAN_G.indexOf(chunk);
    assert.ok(asL >= 0 || asG >= 0, `left chunk ${i} is not an L or G pattern`);
    parity += asL >= 0 ? "L" : "G";
    digits += asL >= 0 ? asL : asG;
  }
  for (let i = 0; i < digitsPerSide; i += 1) {
    const chunk = modules.slice(8 + width + i * 7, 15 + width + i * 7);
    const asR = EAN_R.indexOf(chunk);
    assert.ok(asR >= 0, `right chunk ${i} is not an R pattern`);
    digits += asR;
  }
  if (digitsPerSide === 4) return digits; // EAN-8 has no parity-encoded digit.
  const first = EAN_PARITY.indexOf(parity);
  assert.ok(first >= 0, `parity ${parity} is not a valid EAN-13 pattern`);
  return String(first) + digits;
}

test("EAN-13 round trips, and supplies the check digit", () => {
  assert.equal(decodeEan(encode("ean13", "5901234123457").modules, 6), "5901234123457");
  assert.equal(decodeEan(encode("ean13", "590123412345").modules, 6), "5901234123457");
  // A first digit of 0 uses all-L parity; a high one exercises the G patterns.
  assert.equal(decodeEan(encode("ean13", "0123456789012").modules, 6), "0123456789012");
  assert.equal(decodeEan(encode("ean13", "9780201379624").modules, 6), "9780201379624");
});

test("EAN-8 and UPC-A round trip", () => {
  assert.equal(decodeEan(encode("ean8", "96385074").modules, 4), "96385074");
  const upc = encode("upca", "036000291452");
  assert.equal(decodeEan(upc.modules, 6), "0036000291452", "UPC-A is EAN-13 with a leading zero");
  assert.equal(upc.text, "036000291452", "but prints the 12 digits");
});

test("check digits match published examples", () => {
  assert.equal(checkDigit("590123412345"), 7);
  assert.equal(checkDigit("03600029145"), 2);
  assert.equal(checkDigit("9638507"), 4);
  assert.equal(checkDigit("978020137962"), 4);
});

test("a wrong check digit is rejected, not silently re-encoded", () => {
  assert.throws(() => encode("ean13", "5901234123456"), /check digit is wrong/);
  assert.throws(() => encode("ean13", "59012341234"), /13 digits/);
  assert.throws(() => encode("ean13", "590123412345X"), /digits only/);
});

function decodeCode128(modules: string): string {
  const symbols = (modules.length - 13) / 11;
  assert.ok(Number.isInteger(symbols), "length must be 11n + 13");
  const values = [];
  for (let i = 0; i < symbols; i += 1) {
    const chunk = modules.slice(i * 11, i * 11 + 11);
    const value = CODE128.findIndex((pattern) => widthsToModules(pattern) === chunk);
    assert.ok(value >= 0, `chunk ${i} is not a Code 128 pattern`);
    values.push(value);
  }
  assert.equal(modules.slice(symbols * 11), widthsToModules(CODE128[106]), "stop pattern");
  let sum = values[0];
  for (let i = 1; i < values.length - 1; i += 1) sum += values[i] * i;
  assert.equal(sum % 103, values.at(-1), "checksum");
  let inC = values[0] === 105;
  let text = "";
  for (const value of values.slice(1, -1)) {
    // 99 is the pair "99" while in code set C, and the switch to C only from A or B.
    if (inC) {
      if (value === 100) {
        inC = false;
        continue;
      }
      text += String(value).padStart(2, "0");
    } else {
      if (value === 99) {
        inC = true;
        continue;
      }
      text += String.fromCharCode(value + 32);
    }
  }
  return text;
}

test("Code 128 round trips across code-set switches", () => {
  for (const value of [
    "12345678",
    "1234567",
    "ABC",
    "Tesco-1234567890123",
    "a1b2c3",
    "00099",
    "Card 42",
    "9",
    "99",
    "999",
    "~!@#$%^&*()",
  ]) {
    assert.equal(decodeCode128(encode("code128", value).modules), value, value);
  }
});

test("Code 128 uses the documented checksum weighting", () => {
  // Start C (105) + pairs 12, 34, 56, 78 weighted 1..4 -> 665 mod 103 = 47.
  const modules = encode("code128", "12345678").modules;
  const at = 5 * 11; // The checksum follows the start character and four pairs.
  assert.equal(modules.slice(at, at + 11), widthsToModules(CODE128[47]));
});

test("Code 39 round trips and is delimited by the start/stop character", () => {
  const { modules, text } = encode("code39", "abc-123");
  assert.equal(text, "ABC-123", "Code 39 is upper case only");
  const grouped = runs(modules);
  assert.equal((grouped.length + 1) % 10, 0, "characters are 9 runs plus a separator");
  const decoded = [];
  for (let i = 0; i < grouped.length; i += 10) {
    const pattern = grouped
      .slice(i, i + 9)
      .map(([, length]) => (length === 3 ? "w" : "n"))
      .join("");
    const character = Object.keys(CODE39).find((key) => CODE39[key] === pattern);
    assert.ok(character, `run group ${i / 10} is not a Code 39 pattern`);
    decoded.push(character);
  }
  assert.equal(decoded.join(""), "*ABC-123*");
});

test("ITF round trips and pads an odd number of digits", () => {
  for (const [value, expected] of [
    ["1234", "1234"],
    ["12345", "012345"],
    ["0123456789", "0123456789"],
  ]) {
    const { modules, text } = encode("itf", value);
    assert.equal(text, expected);
    assert.equal(modules.slice(0, 4), "1010", "start pattern");
    assert.equal(modules.slice(-5), "11101", "stop pattern");
    const body = runs(modules.slice(4, -5));
    assert.equal(body.length, expected.length * 5, "five runs per digit");
    let decoded = "";
    for (let pair = 0; pair < expected.length / 2; pair += 1) {
      const group = body.slice(pair * 10, pair * 10 + 10);
      const bars = group
        .filter((_, i) => i % 2 === 0)
        .map(([, n]) => (n === 3 ? "w" : "n"))
        .join("");
      const spaces = group
        .filter((_, i) => i % 2 === 1)
        .map(([, n]) => (n === 3 ? "w" : "n"))
        .join("");
      decoded += `${ITF.indexOf(bars)}${ITF.indexOf(spaces)}`;
    }
    assert.equal(decoded, expected);
  }
});

/* --------------------------------------------------------- Format guessing */

test("suggestFormat prefers a format whose check digit actually validates", () => {
  assert.equal(suggestFormat("5901234123457"), "ean13");
  assert.equal(suggestFormat("036000291452"), "upca");
  assert.equal(suggestFormat("96385074"), "ean8");
  assert.equal(suggestFormat("5901234123456"), "code128", "a bad EAN check digit falls back");
  assert.equal(suggestFormat("ABC-123"), "code128");
  assert.equal(suggestFormat(""), "none");
});

test("fits reports what a format can encode without throwing", () => {
  assert.ok(fits("ean13", "5901234123457"));
  assert.ok(!fits("ean13", "ABC"));
  assert.ok(fits("code39", "ABC 123"));
  assert.ok(!fits("code39", "abc!"));
  assert.ok(fits("none", "anything at all"));
});

test("every quiet zone meets the 10-module minimum for reliable scanning", () => {
  for (const [format, value] of [
    ["code128", "1234"],
    ["ean13", "5901234123457"],
    ["ean8", "96385074"],
    ["upca", "036000291452"],
    ["code39", "ABC"],
    ["itf", "1234"],
  ]) {
    const { quiet } = encode(format, value);
    assert.ok(quiet >= 9, `${format} quiet zone is ${quiet}`);
  }
});

/* ------------------------------------------------------------------- Rules  */

const rules = await import("./rules.js");

test("the AM Wine rule reproduces the observed payload exactly", () => {
  const at = new Date(Date.UTC(2026, 8, 6, 10, 8, 3));
  const built = rules.RULES[0].build("1111222233334444", at);
  assert.equal(
    built,
    "202611110922220633331044440803",
    "card digits interleaved with the UTC clock",
  );
  assert.equal(rules.RULES[0].match(built), "1111222233334444");
  assert.equal(rules.currentPayload({ payload: "1111222233334444", rule: "amwine-v1" }, at), built);
});

test("the AM Wine rule rejects values that only look like it", () => {
  assert.equal(rules.RULES[0].match("5555666677778888QR1234567890"), null, "X5");
  assert.equal(
    rules.RULES[0].match("1".repeat(30)),
    null,
    "month 11, day 11, but hour 11 -> still checked",
  );
  assert.equal(rules.RULES[0].match("202699519900230625771047070803"), null, "month 99");
  assert.equal(rules.RULES[0].match("20269951090023062577"), null, "too short");
});

test("a card with no rule keeps its stored payload", () => {
  assert.equal(
    rules.currentPayload({ payload: "7777000199998888", rule: null }),
    "7777000199998888",
  );
});

test("both samples of each live store are recognised, static cards are not", () => {
  // Two samples of each: the card number holds while the tail changes completely.
  for (const [payload, label, number] of [
    ["P400000000009;000000 111111", "Лента", "400000000009"],
    ["P400000000009;000000 222222", "Лента", "400000000009"],
    ["5555666677778888QR1234567890", "X5 Клуб", "5555666677778888"],
    ["5555666677778888QR0987654321", "X5 Клуб", "5555666677778888"],
  ]) {
    const found = rules.detectVolatile(payload);
    assert.ok(found, payload);
    assert.equal(found!.store.label, label);
    assert.equal(found!.number, number);
  }
  for (const payload of ["7777000199998888", "1234567890123456789012", "1234567890", ""]) {
    assert.equal(rules.detectVolatile(payload), null, payload);
  }
});

test("looksTimeDerived flags a payload carrying today’s date", () => {
  const now = new Date(Date.UTC(2026, 8, 6, 10, 0, 0));
  assert.ok(
    rules.looksTimeDerived("202611110922220633331044440803", now) === false ||
      rules.looksTimeDerived("20260906123456", now),
    "interleaved dates need the rule, not the heuristic",
  );
  assert.ok(rules.looksTimeDerived("20260906123456", now), "YYYYMMDD");
  assert.ok(rules.looksTimeDerived("06092026999", now), "DDMMYYYY");
  assert.ok(!rules.looksTimeDerived("7777000199998888", now));
  assert.ok(!rules.looksTimeDerived("1234567890", now));
});

/* ------------------------------------------------------- QR run rendering  */

const { qrRuns } = await import("./render.js");
const { encodeQr } = await import("./qr.js");

test("QR runs never spill past the end of a row", () => {
  // The grid is a flat array, so merging without a bound check joins the last dark
  // module of one row to the first of the next and draws a bar overhanging the symbol.
  for (const value of [
    "7789777317919533",
    "5555666677778888QR1234567890",
    "1234567890",
    "https://example.com/x",
  ]) {
    const symbol = encodeQr(value);
    for (const run of qrRuns(symbol)) {
      assert.ok(run.width >= 1, "a run must cover at least one module");
      assert.ok(
        run.x + run.width <= symbol.size,
        `run at row ${run.y} spans ${run.x}..${run.x + run.width} beyond size ${symbol.size} for ${value}`,
      );
    }
  }
});

test("QR runs cover exactly the dark modules, and nothing else", () => {
  const symbol = encodeQr("7789777317919533");
  const painted = new Uint8Array(symbol.size * symbol.size);
  for (const run of qrRuns(symbol)) {
    for (let i = 0; i < run.width; i += 1) painted[run.y * symbol.size + run.x + i] = 1;
  }
  for (let i = 0; i < symbol.modules.length; i += 1) {
    assert.equal(
      painted[i],
      symbol.modules[i],
      `module ${i} (${i % symbol.size}, ${Math.floor(i / symbol.size)})`,
    );
  }
});
