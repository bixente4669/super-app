/**
 * Some shops rebuild their code from the clock, so a stored payload dies within
 * minutes. The pattern is written by the person holding the card, not shipped here:
 * this file knows nothing about any particular shop, only how to expand a template.
 *
 * Tokens, longest first so `mm` is not eaten by `MM`:
 *   YYYY MM DD HH mm ss  UTC date and time fields
 *   #                    the next digit of the card number
 *   anything else        copied through as a literal
 *
 * A leading `b64:` base64-encodes everything the rest of the pattern produces, which
 * is what some shops put in the code rather than the plain text.
 *
 * A code interleaving the card number with the UTC clock, for instance, is
 * `YYYY####MM####DD####HH####mmss`.
 */

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

const FIELDS: [string, (now: Date) => string][] = [
  ["YYYY", (now) => String(now.getUTCFullYear())],
  ["MM", (now) => pad(now.getUTCMonth() + 1)],
  ["DD", (now) => pad(now.getUTCDate())],
  ["HH", (now) => pad(now.getUTCHours())],
  ["mm", (now) => pad(now.getUTCMinutes())],
  ["ss", (now) => pad(now.getUTCSeconds())],
];

/** How many card-number digits a template consumes, so it can be checked against one. */
/** A pattern starting with this has its whole result base64-encoded. */
const BASE64 = "b64:";

export function templateDigits(template: string): number {
  return [...template].filter((character) => character === "#").length;
}

/**
 * Expands `template` against the card number and the clock.
 * @throws when the template needs more digits than the number has
 */
export function buildFromTemplate(
  template: string,
  number: string,
  now: Date = new Date(),
): string {
  const encode = template.startsWith(BASE64);
  const built = expand(encode ? template.slice(BASE64.length) : template, number, now);
  return encode ? btoa(built) : built;
}

function expand(template: string, number: string, now: Date): string {
  const digits = number.replace(/\D/g, "");
  const needed = templateDigits(template);
  if (needed > digits.length) {
    throw new Error(
      `That pattern needs ${needed} digits from the card number, which has ${digits.length}.`,
    );
  }
  let out = "";
  let taken = 0;
  let at = 0;
  outer: while (at < template.length) {
    for (const [token, value] of FIELDS) {
      if (template.startsWith(token, at)) {
        out += value(now);
        at += token.length;
        continue outer;
      }
    }
    if (template[at] === "#") {
      out += digits[taken];
      taken += 1;
    } else {
      out += template[at];
    }
    at += 1;
  }
  return out;
}

/**
 * A payload that embeds today's date is very likely to expire. This is a shape test,
 * not a list of shops: it knows nothing beyond the current date.
 */
export function looksTimeDerived(payload: string, now: Date = new Date()): boolean {
  const digits = payload.replace(/\D/g, "");
  if (digits.length < 8) return false;
  const year = String(now.getUTCFullYear());
  const month = pad(now.getUTCMonth() + 1);
  const day = pad(now.getUTCDate());
  return [
    `${year}${month}${day}`,
    `${day}${month}${year}`,
    `${year}${month}`,
    `${day}${month}${year.slice(2)}`,
  ].some((stamp) => digits.includes(stamp));
}

/** The payload to show: rebuilt from the template when there is one, else as stored. */
export function currentPayload(
  card: { payload: string; rotation: string | null },
  now: Date = new Date(),
): string {
  if (!card.rotation) return card.payload;
  try {
    return buildFromTemplate(card.rotation, card.payload, now);
  } catch {
    // A template that no longer fits should not silently render a wrong barcode.
    return "";
  }
}
