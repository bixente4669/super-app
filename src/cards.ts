/**
 * A Card is the only stored entity.
 *
 * The subtlety worth knowing is that the number a shop prints is not always what its
 * barcode carries. One real shop prints (numbers here are invented) "3333 0001 5555 7777" above a barcode encoding
 * "7777000199998888". Scanning is therefore the reliable way to add a card, and the
 * two numbers are stored separately.
 */
export interface Card {
  id: string;
  name: string;
  /** Exactly what the barcode encodes. With `rule` set, the card number instead. */
  payload: string;
  format: FormatId;
  /** The number the shop prints, when it differs from `payload`. */
  display: string;
  /** A rotating-code rule id; the payload is then rebuilt at display time. */
  rule: string | null;
  /** The shop issues a new code each visit, so no stored code can work. */
  live: boolean;
  /** Where to get a live card's code. Restricted to https. */
  link: string;
  color: string;
  /** Manual priority from dragging; ties fall back to name. */
  order: number;
  /** A small square image for the card face. Stored as a Blob; IndexedDB takes them. */
  logo: Blob | null;
}
import { type FormatId, isFormat, suggestFormat } from "./barcode/encode.js";

const NAME = "super-app-cards";
const STORE = "cards";
const VERSION = 2;
let database;

function openDatabase() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (event.oldVersion < 1) db.createObjectStore(STORE, { keyPath: "id" });
      if (event.oldVersion >= 1 && event.oldVersion < 2) {
        // Version 1 stored a bare `number` with no format; carry it into `payload`.
        // The upgrade transaction is always present inside onupgradeneeded.
        const store = request.transaction!.objectStore(STORE);
        const cursors = store.openCursor();
        cursors.onsuccess = () => {
          const cursor = cursors.result;
          if (!cursor) return;
          const { id, name, number = "", color } = cursor.value;
          cursor.update({
            id,
            name,
            color,
            payload: number,
            display: "",
            rule: null,
            live: false,
            link: "",
            logo: null,
            format: suggestFormat(number),
          });
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        database = undefined;
      };
      resolve(db);
    };
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
    request.onblocked = () => {
      database = undefined;
      reject(new Error("Close other app tabs and try again."));
    };
  });
  return database;
}

async function transact<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T> | undefined,
): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = operation(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request?.result as T);
    transaction.onabort = () =>
      reject(transaction.error ?? request?.error ?? new Error("Storage operation failed."));
    transaction.onerror = () => reject(transaction.error ?? request?.error);
  });
}

export function listCards(): Promise<Card[]> {
  return transact<Card[]>("readonly", (store) => store.getAll());
}

/** @throws when the card is not storable, with a message safe to show the user. */
export function validate(card: Partial<Card>): Card {
  const { id, name = "", payload = "", format = "", color = "" } = card;
  if (!id || !name.trim()) throw new Error("Enter a store name.");
  if (name.length > 100) throw new Error("That store name is too long.");
  if (payload.length > 2000) throw new Error("That card number is too long.");
  if (!isFormat(format)) throw new Error("Choose a barcode format.");
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error("Choose a valid colour.");
  const link = (card.link ?? "").trim();
  // Only https, so a stored card can never carry a javascript: URL into the viewer.
  if (link && !/^https:\/\/[^\s]+$/i.test(link))
    throw new Error("The link must start with https://");
  return {
    id,
    name: name.trim(),
    payload,
    format,
    display: (card.display ?? "").trim(),
    rule: card.rule ?? null,
    live: Boolean(card.live),
    link,
    color,
    // Manual priority; cards written before ordering existed share 0 and fall back to name.
    order: Number.isFinite(card.order) ? (card.order as number) : 0,
    logo: card.logo instanceof Blob ? card.logo : null,
  };
}

export function saveCard(card: Partial<Card>) {
  const clean = validate(card);
  return transact("readwrite", (store) => store.put(clean));
}

export function deleteCard(id: string) {
  return transact("readwrite", (store) => store.delete(id));
}

/** Bulk write for import; later cards overwrite earlier ones with the same id. */
export function putCards(cards: Partial<Card>[]) {
  const clean = cards.map(validate);
  return transact("readwrite", (store) => {
    let last;
    for (const card of clean) last = store.put(card);
    return last;
  });
}

export function clearCards() {
  return transact("readwrite", (store) => store.clear());
}
