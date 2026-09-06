/**
 * Export and import, which is the only safety net that survives Safari clearing
 * IndexedDB. Everything stays on the device; nothing is uploaded.
 */
import { listCards, putCards } from "./cards.js";

const FORMAT = "super-app-cards";
const VERSION = 1;

/** JSON cannot hold a Blob, so a logo travels as a data URL. */
const toDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const { result } = reader;
      // readAsDataURL always yields a string, but the type allows an ArrayBuffer.
      if (typeof result === "string") resolve(result);
      else reject(new Error("Could not read the logo."));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the logo."));
    reader.readAsDataURL(blob);
  });

async function fromDataUrl(value: unknown): Promise<Blob | null> {
  if (typeof value !== "string" || !value.startsWith("data:image/")) return null;
  try {
    return await (await fetch(value)).blob();
  } catch {
    // A corrupt logo is not worth failing an import over; the card still works.
    return null;
  }
}

export async function buildBackup() {
  const cards = await listCards();
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    cards: await Promise.all(
      cards.map(async (card) => ({
        ...card,
        logo: card.logo ? await toDataUrl(card.logo) : null,
      })),
    ),
  };
}

const filename = () => `super-app-cards-${new Date().toISOString().slice(0, 10)}.json`;

/**
 * Hands the file to the user. Safari on iOS offers no reliable download for a
 * blob URL, so the share sheet is tried first and saves straight to Files.
 * @returns {Promise<'shared'|'downloaded'>}
 */
export async function exportCards() {
  const text = JSON.stringify(await buildBackup(), null, 2);
  const file = new File([text], filename(), { type: "application/json" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      // Files only. A title here is treated as a second item to share, so saving to
      // Files produced the backup plus a stray text note beside it.
      await navigator.share({ files: [file] });
      return "shared";
    } catch (error) {
      // A cancelled share is the user's choice, not a failure to fall back from.
      if (error instanceof Error && error.name === "AbortError") throw error;
      // Any other share failure falls through to a plain download.
    }
  }
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename();
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return "downloaded";
}

/**
 * Merges a backup into storage, overwriting cards that share an id.
 * @returns {Promise<number>} how many cards were written
 * @throws {Error} when the file is not a backup this app wrote
 */
export async function importCards(file: File): Promise<number> {
  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  if (backup?.format !== FORMAT || !Array.isArray(backup.cards)) {
    throw new Error("That file is not a Super app card backup.");
  }
  if (backup.version > VERSION) {
    throw new Error("That backup was written by a newer version of this app.");
  }
  if (!backup.cards.length) throw new Error("That backup has no cards in it.");
  const cards = await Promise.all(
    backup.cards.map(async (card: Record<string, unknown>) => ({
      ...card,
      logo: await fromDataUrl(card.logo),
    })),
  );
  await putCards(cards);
  return cards.length;
}
