/**
 * Some retailers rebuild their code from the clock, so a stored payload dies within
 * minutes. Such a card stores its number plus a rule id, and the payload is rebuilt
 * on every open. Each rule records when it was last confirmed against the real site.
 */

const pad = (value: number | string) => String(value).padStart(2, "0");

/** A shop whose code is rebuilt from the clock, and how to rebuild it. */
export interface Rule {
  id: string;
  label: string;
  host: string;
  format: string;
  /** When this rule was last confirmed against the real site. */
  verified: string;
  digits: number;
  build(number: string, now?: Date): string;
  /** The card number, when `payload` looks like this rule's own output. */
  match(payload: string): string | null;
}

export const RULES: Rule[] = [
  {
    id: "amwine-v1",
    label: "AM Wine",
    host: "amwine.ru",
    format: "qr",
    verified: "2026-09-06",
    digits: 16,
    // Four digits of the card number alternating with the UTC date and time.
    build(number: string, now: Date = new Date()): string {
      const n = number.replace(/\D/g, "");
      return [
        now.getUTCFullYear(),
        n.slice(0, 4),
        pad(now.getUTCMonth() + 1),
        n.slice(4, 8),
        pad(now.getUTCDate()),
        n.slice(8, 12),
        pad(now.getUTCHours()),
        n.slice(12, 16),
        pad(now.getUTCMinutes()),
        pad(now.getUTCSeconds()),
      ].join("");
    },
    /** The card number, when `payload` looks like this rule's own output. */
    match(payload: string): string | null {
      if (!/^\d{30}$/.test(payload)) return null;
      const [year, month, day, hour, minute, second] = [
        payload.slice(0, 4),
        payload.slice(8, 10),
        payload.slice(14, 16),
        payload.slice(20, 22),
        payload.slice(26, 28),
        payload.slice(28, 30),
      ].map(Number);
      if (year < 2020 || year > 2100 || month < 1 || month > 12) return null;
      if (day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
      return (
        payload.slice(4, 8) + payload.slice(10, 14) + payload.slice(16, 20) + payload.slice(22, 26)
      );
    },
  },
];

export const findRule = (id: string) => RULES.find((rule) => rule.id === id) ?? null;

/** The rule that recognises `payload`, so a scan can offer to regenerate it. */
export function detectRule(payload: string) {
  for (const rule of RULES) {
    const number = rule.match(payload);
    if (number) return { rule, number };
  }
  return null;
}

/**
 * A payload no rule covers may still embed today's date, which means it will very
 * likely stop working. Warn rather than silently store a code with a shelf life.
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

/** Rebuilds the payload to show, which is the stored one unless a rule applies. */
export function currentPayload(
  card: { payload: string; rule: string | null },
  now: Date = new Date(),
): string {
  const rule = card.rule ? findRule(card.rule) : null;
  return rule ? rule.build(card.payload, now) : card.payload;
}

/**
 * Stores whose code carries a server-issued token that changes on every visit. The
 * card number stays constant but the tail does not, and it is not derived from the
 * clock, so it cannot be rebuilt offline the way a rule can. Such a card is stored
 * as a "live" card: the number is kept, and the code is fetched from the shop.
 */
export const VOLATILE = [
  {
    id: "lenta",
    label: "Лента",
    url: "https://lenta.com",
    observed: "2026-09-06",
    // P<12-digit card>;<six zeroes> <six-digit token>
    test: (payload: string) => /^P\d{12};\d{6} \d{6}$/.test(payload),
    number: (payload: string) => payload.slice(1, 13),
  },
  {
    id: "x5",
    label: "X5 Клуб",
    url: "https://x5club.ru",
    observed: "2026-09-06",
    // <16-digit card>QR<ten-digit token>
    test: (payload: string) => /^\d{16}QR\d{10}$/.test(payload),
    number: (payload: string) => payload.slice(0, 16),
  },
];

/** The shop and card number, when `payload` is a known live code. */
export function detectVolatile(payload: string) {
  const store = VOLATILE.find((entry) => entry.test(payload.trim()));
  return store ? { store, number: store.number(payload.trim()) } : null;
}
