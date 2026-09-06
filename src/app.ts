import { type Card, listCards, saveCard, deleteCard, putCards } from "./cards.js";
import { exportCards, importCards } from "./backup.js";
import {
  FORMATS,
  type Format,
  type FormatId,
  formatLabel,
  suggestFormat,
} from "./barcode/encode.js";
import { canEncode } from "./barcode/render.js";
import {
  buildFromTemplate,
  currentPayload,
  looksTimeDerived,
  templateDigits,
} from "./barcode/rotation.js";
import { cardFace, logoUrl, paint, renderSymbol, illustratePdf417 } from "./ui.js";

/**
 * Every element the app touches, resolved once. Looking them up per access re-queried
 * the document on every keystroke and read as a duplicated selector besides; naming
 * them here also means a missing element fails at load rather than mid-interaction.
 */
function find<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

const el = {
  // Shell
  add: find<HTMLButtonElement>("add"),
  cards: find("cards"),
  message: find("message"),
  toolbar: find("toolbar"),
  search: find<HTMLInputElement>("search"),
  viewCards: find<HTMLButtonElement>("view-cards"),
  viewList: find<HTMLButtonElement>("view-list"),
  toast: find("toast"),
  installHint: find("install-hint"),
  dismissHint: find<HTMLButtonElement>("dismiss-hint"),
  install: find<HTMLButtonElement>("install"),
  installTitle: find("install-title"),
  installText: find("install-text"),

  // Settings
  settings: find<HTMLDialogElement>("settings"),
  settingsOpen: find<HTMLButtonElement>("settings-open"),
  settingsClose: find<HTMLButtonElement>("settings-close"),
  exportButton: find<HTMLButtonElement>("export"),
  importButton: find<HTMLButtonElement>("import"),
  importFile: find<HTMLInputElement>("import-file"),
  version: find("version"),
  updateBar: find("update-bar"),
  updateNow: find<HTMLButtonElement>("update-now"),

  // Viewer
  viewer: find<HTMLDialogElement>("viewer"),
  viewerName: find("viewer-name"),
  viewerNumber: find("viewer-number"),
  viewerNote: find("viewer-note"),
  viewerSymbol: find("viewer-symbol"),
  viewerLink: find<HTMLAnchorElement>("viewer-link"),
  viewerClose: find<HTMLButtonElement>("viewer-close"),
  viewerEdit: find<HTMLButtonElement>("viewer-edit"),

  // Editor
  editor: find<HTMLDialogElement>("editor"),
  editorTitle: find("editor-title"),
  form: find<HTMLFormElement>("card-form"),
  name: find<HTMLInputElement>("name"),
  payload: find<HTMLInputElement>("payload"),
  scan: find<HTMLButtonElement>("scan"),
  scanFile: find<HTMLInputElement>("scan-file"),
  scanStatus: find("scan-status"),
  display: find<HTMLInputElement>("display"),
  link: find<HTMLInputElement>("link"),
  color: find<HTMLInputElement>("color"),
  colorValue: find<HTMLOutputElement>("color-value"),
  logoPreview: find("logo-preview"),
  logoFetch: find<HTMLButtonElement>("logo-fetch"),
  logoPick: find<HTMLButtonElement>("logo-pick"),
  logoClear: find<HTMLButtonElement>("logo-clear"),
  logoFile: find<HTMLInputElement>("logo-file"),
  logoHint: find("logo-hint"),
  format: find<HTMLSelectElement>("format"),
  formatHint: find("format-hint"),
  formatHelp: find<HTMLDetailsElement>("format-help"),
  formatGallery: find("format-gallery"),
  live: find<HTMLInputElement>("live"),
  rotation: find<HTMLInputElement>("rotation"),
  rotationPreview: find("rotation-preview"),
  rotationHelp: find<HTMLDetailsElement>("rotation-help"),
  rotationExample: find<HTMLButtonElement>("rotation-example"),
  cardPreview: find("card-preview"),
  previewSymbol: find("preview-symbol"),
  previewError: find("preview-error"),
  formError: find("form-error"),
  save: find<HTMLButtonElement>("save"),
  deleteButton: find<HTMLButtonElement>("delete"),
  close: find<HTMLButtonElement>("close"),
} as const;
let editingId: string | null = null;
/** Set when the payload field holds a card number for a rule, not a raw payload. */
let formatTouched = false;
let editingLogo: Blob | null = null;
let busy = false;
/** Interval that keeps a rotating code current while the card is on screen. */
let refresh: ReturnType<typeof setInterval> | undefined;
let editingOrder = 0;
let allCards: Card[] = [];
let view: "cards" | "list" = "cards";
let drag: { item: HTMLElement; x: number; y: number; moved: boolean } | null = null;
const VIEW_KEY = "super-app-view";

/* ------------------------------------------------------------ Scroll locking */

/*
 * iOS Safari ignores `overflow: hidden` on the body, so the list scrolled underneath
 * an open dialog and stayed where the drag left it. Pinning the body with a stored
 * offset is the only approach WebKit honours; the offset is put back on close, so
 * the list is exactly where it was.
 */
let lockedAt = 0;

function lockScroll() {
  if (document.body.dataset.locked) return;
  lockedAt = window.scrollY;
  document.body.dataset.locked = "yes";
  document.body.style.position = "fixed";
  document.body.style.top = `-${lockedAt}px`;
  document.body.style.left = "0";
  document.body.style.right = "0";
}

function unlockScroll() {
  if (!document.body.dataset.locked) return;
  delete document.body.dataset.locked;
  document.body.style.position = "";
  document.body.style.top = "";
  document.body.style.left = "";
  document.body.style.right = "";
  window.scrollTo(0, lockedAt);
}

/** Opens a dialog with the page behind it held still. */
function openDialog(dialog: HTMLDialogElement) {
  lockScroll();
  dialog.showModal();
}

for (const dialog of [el.viewer, el.editor, el.settings]) {
  dialog.addEventListener("close", unlockScroll);
}

/* -------------------------------------------------------------- Card viewer */

function openViewer(card: Card) {
  const rotating = Boolean(card.rotation);
  el.viewerName.textContent = card.name;
  el.viewerNumber.textContent = card.display || card.payload;
  el.viewerLink.hidden = !(card.live && card.link);
  if (card.live && card.link) {
    el.viewerLink.href = card.link;
    el.viewerLink.textContent = `Open ${new URL(card.link).host}`;
  }
  el.viewerNote.textContent = card.live
    ? "This shop issues a new code at every visit, so it cannot be stored. Open the shop to show the code at the till."
    : rotating
      ? "This shop rebuilds its code from the clock, so it is rebuilt here each time you open the card."
      : "";
  clearInterval(refresh);
  // A live card passes no payload, so the panel hides itself.
  const draw = () =>
    renderSymbol(el.viewerSymbol, card.format, card.live ? "" : currentPayload(card), card.payload);
  draw();
  if (rotating && !card.live) refresh = setInterval(draw, 20_000);
  el.viewerEdit.onclick = () => {
    el.viewer.close();
    openEditor(card);
  };
  openDialog(el.viewer);
}

el.viewer.addEventListener("close", () => {
  clearInterval(refresh);
  refresh = undefined;
});
el.viewerClose.addEventListener("click", () => el.viewer.close());

/* --------------------------------------------------------- Colour and logo */

/** Downscales to a thumbnail, so a logo costs kilobytes rather than megabytes. */
async function shrink(blob: Blob, size = 128): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.addEventListener("load", () => resolve(element));
      element.addEventListener("error", () =>
        reject(new Error("That file is not an image this browser can read.")),
      );
      element.src = url;
    });
    const scale = Math.min(1, size / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error("Could not process that image."))),
        "image/webp",
        0.85,
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Tries the shop's own site, never a third-party favicon service: asking one of those
 * would tell it which shops you hold cards for, from an app that otherwise never
 * phones home. Most shops refuse cross-origin reads, hence the manual fallback.
 */
async function fetchLogo(link: string): Promise<Blob> {
  const origin = new URL(link).origin;
  for (const path of ["/favicon.ico", "/apple-touch-icon.png", "/favicon.png", "/favicon.svg"]) {
    try {
      const response = await fetch(new URL(path, origin), { mode: "cors" });
      if (!response.ok) continue;
      const blob = await response.blob();
      if (blob.size && blob.type.startsWith("image/")) return await shrink(blob);
    } catch {
      // Blocked or absent; try the next path.
    }
  }
  throw new Error(
    "This shop does not let its icon be read from another site. Choose an image instead.",
  );
}

/** There is no lookup table of shops: the origin comes from whatever link is typed. */
function syncLogoFetch() {
  const link = el.link.value.trim();
  el.logoFetch.disabled = !link;
  el.logoFetch.title = link ? `Try ${link}` : "Add the shop link first";
}

function showLogo() {
  el.logoPreview.replaceChildren();
  el.logoClear.hidden = !editingLogo;
  if (!editingLogo) return;
  const image = document.createElement("img");
  image.src = logoUrl(editingLogo);
  image.alt = "";
  el.logoPreview.append(image);
}

/* -------------------------------------------------------------- Card editor */

for (const format of FORMATS) {
  el.format.append(new Option(format.label, format.id));
}

/** What the barcode carries: the pattern expanded when there is one, else as typed. */
function effectivePayload() {
  const value = el.payload.value.trim();
  const template = el.rotation.value.trim();
  if (!template) return value;
  try {
    return buildFromTemplate(template, value);
  } catch {
    return "";
  }
}

/** Shows what the pattern currently produces, so it can be checked against the shop. */
function refreshRotation() {
  const template = el.rotation.value.trim();
  if (!template) {
    el.rotationPreview.textContent = "";
    return;
  }
  const needed = templateDigits(template);
  try {
    const built = buildFromTemplate(template, el.payload.value.trim());
    el.rotationPreview.textContent = `Right now this makes ${built}, using ${needed} digits of the card number.`;
    el.rotationPreview.classList.remove("danger");
  } catch (error) {
    el.rotationPreview.textContent = error instanceof Error ? error.message : String(error);
    el.rotationPreview.classList.add("danger");
  }
}

/* --------------------------------------------------------- Format gallery  */

// Valid values, so every sample below is a real symbol rather than a drawing.
const SAMPLES: Record<string, string> = {
  code128: "ABC-1234",
  ean13: "5901234123457",
  ean8: "96385074",
  upca: "036000291452",
  code39: "ABC-123",
  itf: "12345670",
  qr: "1234567890",
};

function sampleArt(format: Format) {
  const art = document.createElement("div");
  art.className = "sample-art";
  if (SAMPLES[format.id]) {
    renderSymbol(art, format.id, SAMPLES[format.id]);
    return art;
  }
  // PDF417 cannot be generated, but the shape still has to be recognisable on a card.
  if (format.id === "pdf417") {
    art.append(illustratePdf417());
    art.classList.add("sample-drawn");
    return art;
  }
  art.classList.add("sample-note");
  art.textContent = "No barcode — number only";
  return art;
}

let galleryBuilt = false;
function buildGallery() {
  el.formatGallery.replaceChildren(
    ...FORMATS.map((format) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "sample";
      item.dataset.format = format.id;
      const label = document.createElement("strong");
      label.textContent = format.label;
      const note = document.createElement("span");
      note.textContent = format.id === "pdf417" ? "Drawing only" : format.short;
      item.append(sampleArt(format), label, note);
      item.addEventListener("click", () => {
        el.format.value = format.id;
        formatTouched = true;
        preview();
      });
      return item;
    }),
  );
  galleryBuilt = true;
}

/** Marks the chosen format, and greys the ones that cannot carry what was typed. */
function markGallery(format: string, payload: string) {
  if (!galleryBuilt) return;
  for (const item of el.formatGallery.children as HTMLCollectionOf<HTMLElement>) {
    const fits = !payload || canEncode(item.dataset.format ?? "", payload);
    item.setAttribute("aria-pressed", String(item.dataset.format === format));
    item.classList.toggle("unfit", !fits);
    item.title = fits ? "" : "Cannot encode what you typed";
  }
}

el.formatHelp.addEventListener("toggle", () => {
  if (el.formatHelp.open && !galleryBuilt) {
    buildGallery();
    markGallery(el.format.value, effectivePayload());
  }
});

function preview() {
  const color = el.color.value;
  el.colorValue.value = color;
  refreshRotation();

  // Built through cardFace, so the preview cannot drift from a real card again.
  const draft = {
    name: el.name.value.trim() || "Store name",
    display: el.display.value,
    payload: el.payload.value || "Card number",
    live: el.live.checked,
    color,
    logo: editingLogo,
  };
  el.cardPreview.replaceChildren(cardFace(draft, { interactive: false }));
  paint(el.cardPreview, color);
  syncLogoFetch();

  if (el.live.checked) {
    renderSymbol(el.previewSymbol, "none", "");
    el.rotationPreview.textContent = "";
    el.previewError.textContent =
      "Saved as a live card: the number is kept, and the code comes from the shop.";
    return;
  }

  const payload = effectivePayload();
  if (!formatTouched && payload) el.format.value = suggestFormat(payload);
  const format = el.format.value;
  el.formatHint.textContent = FORMATS.find((entry) => entry.id === format)?.hint ?? "";
  for (const option of el.format.options) {
    option.disabled = Boolean(payload) && !canEncode(option.value, payload);
  }

  markGallery(format, payload);
  renderSymbol(el.previewSymbol, format, payload);
  const warn = !el.rotation.value.trim() && payload && looksTimeDerived(payload);
  el.previewError.textContent = warn
    ? "This value contains today’s date, so it is probably a code that expires. Check it still scans tomorrow."
    : "";
}

function openEditor(card?: Card) {
  editingId = card?.id ?? null;

  editingOrder =
    card?.order ?? (allCards.length ? Math.max(...allCards.map((c) => c.order ?? 0)) + 1 : 0);
  formatTouched = Boolean(card);
  editingLogo = card?.logo ?? null;
  el.editorTitle.textContent = card ? "Edit card" : "Add card";
  el.name.value = card?.name ?? "";
  el.payload.value = card?.payload ?? "";
  el.display.value = card?.display ?? "";
  el.format.value = card?.format ?? "code128";
  el.color.value = card?.color ?? "#ff2d87";
  el.link.value = card?.link ?? "";
  el.live.checked = Boolean(card?.live);
  el.rotation.value = card?.rotation ?? "";
  // Opened only when this card actually uses a pattern, so it stays out of the way.
  el.rotationHelp.open = Boolean(card?.rotation);
  el.deleteButton.hidden = !card;
  el.formError.textContent = "";
  el.logoHint.textContent = "";
  showLogo();
  preview();
  openDialog(el.editor);
  // Deliberately not focusing the name field: on a phone that throws the keyboard up
  // over the form, and the colour and format are just as likely to be the first thing
  // wanted. showModal moves focus into the dialog on its own.
}

/* ---------------------------------------------------------------- Card list */

const sortCards = (cards: Card[]): Card[] =>
  cards.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));

/** Every word must appear somewhere in the card, so "az 66" narrows as you type. */
function matches(card: Card, query: string) {
  if (!query) return true;
  const haystack = `${card.name} ${card.display} ${card.payload}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

function buildItem(card: Card) {
  const item = document.createElement("div");
  item.className = view === "list" ? "row" : "card";
  item.dataset.id = card.id;
  if (view !== "list") paint(item, card.color);

  const face = cardFace(card, { view });
  face.addEventListener("click", () => openViewer(card));

  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "handle";
  handle.textContent = "⠿";
  handle.setAttribute("aria-label", `Reorder ${card.name}`);
  item.append(face, handle);
  return item;
}

function paintList() {
  const query = el.search.value.trim();
  const visible = allCards.filter((card) => matches(card, query));
  el.cards.className = view === "list" ? "list" : "";
  el.cards.replaceChildren(...visible.map(buildItem));
  // Reordering is off while filtered, because the resulting order would not be
  // visible, and off with a single card, where there is nothing to reorder against.
  el.cards.classList.toggle("locked", Boolean(query) || allCards.length < 2);
  el.toolbar.hidden = !allCards.length;
  el.message.textContent = !allCards.length
    ? "No cards yet."
    : query
      ? `${visible.length} of ${allCards.length} shown`
      : `${allCards.length} ${allCards.length === 1 ? "card" : "cards"}`;
}

async function render() {
  allCards = sortCards(await listCards());
  paintList();
  el.add.disabled = false;
}

/** Writes the on-screen order back, so priority survives a reload. */
async function persistOrder() {
  const changed: Card[] = [];
  [...(el.cards.children as HTMLCollectionOf<HTMLElement>)].forEach((element, index) => {
    const card = allCards.find((entry) => entry.id === element.dataset.id);
    if (card && card.order !== index) {
      card.order = index;
      changed.push(card);
    }
  });
  if (!changed.length) return;
  try {
    await putCards(changed);
    allCards = sortCards(allCards);
  } catch {
    toast("Could not save the new order.", "error");
  }
}

// Pointer events rather than HTML drag-and-drop, which never fires on iOS.
el.cards.addEventListener("pointerdown", (event) => {
  const handle = (event.target as HTMLElement | null)?.closest<HTMLElement>(".handle");
  const item = handle?.parentElement;
  if (!handle || !item || event.button > 0 || el.cards.classList.contains("locked")) return;
  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  drag = { item, x: event.clientX, y: event.clientY, moved: false };
  item.classList.add("dragging");
});

el.cards.addEventListener("pointermove", (event) => {
  if (!drag) return;
  drag.item.style.transform = `translate(${event.clientX - drag.x}px, ${event.clientY - drag.y}px)`;
  const under = document.elementFromPoint(event.clientX, event.clientY)?.closest(".card, .row");
  if (!under || under === drag.item || under.parentElement !== drag.item.parentElement) return;
  const box = under.getBoundingClientRect();
  const self = drag.item.getBoundingClientRect();
  // Compare horizontally only when the two share a row, which in a one-column grid
  // never happens. Testing x unconditionally meant a drag upward still counted as
  // "after", because the handle sits on the right and carries the pointer with it.
  const sameRow = Math.abs(box.top - self.top) < box.height / 2;
  const after = sameRow
    ? event.clientX > box.left + box.width / 2
    : event.clientY > box.top + box.height / 2;
  under.parentElement?.insertBefore(drag.item, after ? under.nextSibling : under);
  // Re-anchor to the new position so the element does not jump away from the finger.
  drag.x = event.clientX;
  drag.y = event.clientY;
  drag.item.style.transform = "";
  drag.moved = true;
});

async function endDrag() {
  if (!drag) return;
  const { item, moved } = drag;
  drag = null;
  item.style.transform = "";
  item.classList.remove("dragging");
  if (moved) await persistOrder();
}
el.cards.addEventListener("pointerup", endDrag);
el.cards.addEventListener("pointercancel", endDrag);

// The same reordering from the keyboard, which dragging alone would not give.
el.cards.addEventListener("keydown", async (event) => {
  const handle = (event.target as HTMLElement | null)?.closest<HTMLElement>(".handle");
  const item = handle?.parentElement;
  if (!handle || !item || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
  if (el.cards.classList.contains("locked")) return;
  event.preventDefault();
  const up = event.key === "ArrowUp";
  const sibling = up ? item.previousElementSibling : item.nextElementSibling;
  if (!sibling || !item.parentElement) return;
  if (up) item.parentElement.insertBefore(item, sibling);
  else item.parentElement.insertBefore(sibling, item);
  handle.focus();
  await persistOrder();
});

el.search.addEventListener("input", paintList);

function setView(next: "cards" | "list") {
  view = next;
  el.viewCards.setAttribute("aria-pressed", String(view === "cards"));
  el.viewList.setAttribute("aria-pressed", String(view === "list"));
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    /* View choice is optional. */
  }
  paintList();
}
el.viewCards.addEventListener("click", () => setView("cards"));
el.viewList.addEventListener("click", () => setView("list"));
try {
  if (localStorage.getItem(VIEW_KEY) === "list") view = "list";
} catch {
  /* View choice is optional. */
}

function setBusy(value: boolean) {
  busy = value;
  for (const button of [el.save, el.deleteButton, el.close]) button.disabled = value;
}

/* ----------------------------------------------------------------- Wiring   */

el.logoFetch.addEventListener("click", async () => {
  const link = el.link.value.trim();
  if (!link) return;
  el.logoHint.textContent = "Looking for the shop\u2019s icon\u2026";
  try {
    editingLogo = await fetchLogo(link);
    el.logoHint.textContent = "Found it.";
    showLogo();
    preview();
  } catch (error) {
    el.logoHint.textContent = error instanceof Error ? error.message : String(error);
  }
});

el.rotationExample.addEventListener("click", () => {
  el.rotation.value = "YYYY####MM####DD####HH####mmss";
  preview();
  el.rotation.focus();
});

el.scan.addEventListener("click", () => el.scanFile.click());

el.scanFile.addEventListener("change", async (event) => {
  const target = event.target as HTMLInputElement;
  const [file] = target.files ?? [];
  target.value = "";
  if (!file) return;
  el.scan.disabled = true;
  el.scanStatus.textContent = "Reading\u2026";
  try {
    const { scanImage } = await import("./barcode/scan.js");
    const found = await scanImage(file);
    if (!found) {
      el.scanStatus.textContent =
        "No barcode found. Fill the frame with it, straight on and evenly lit.";
      return;
    }
    // Whatever the code actually says wins over anything typed: reading the printed
    // digits by eye is exactly the mistake scanning exists to prevent.
    el.payload.value = found.text;
    el.format.value = found.format;
    formatTouched = true;
    el.scanStatus.textContent = `Read a ${formatLabel(found.format)}.`;
    preview();
  } catch (error) {
    el.scanStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    el.scan.disabled = false;
  }
});

el.logoPick.addEventListener("click", () => el.logoFile.click());

el.logoFile.addEventListener("change", async (event) => {
  const target = event.target as HTMLInputElement;
  const [file] = target.files ?? [];
  target.value = "";
  if (!file) return;
  try {
    editingLogo = await shrink(file);
    el.logoHint.textContent = "";
    showLogo();
    preview();
  } catch (error) {
    el.logoHint.textContent = error instanceof Error ? error.message : String(error);
  }
});

el.logoClear.addEventListener("click", () => {
  editingLogo = null;
  el.logoHint.textContent = "";
  showLogo();
  preview();
});

el.settingsOpen.addEventListener("click", () => openDialog(el.settings));
el.settingsClose.addEventListener("click", () => el.settings.close());

/*
 * Tapping outside closes the settings sheet, which holds nothing unsaved. The editor
 * deliberately does not: a stray tap there would throw away a half-typed card.
 */
el.settings.addEventListener("click", (event) => {
  if (event.target === el.settings) el.settings.close();
});
el.add.addEventListener("click", () => openEditor());
el.close.addEventListener("click", () => el.editor.close());
el.editor.addEventListener("cancel", (event) => {
  if (busy) event.preventDefault();
});
el.form.addEventListener("input", preview);
el.format.addEventListener("change", () => {
  formatTouched = true;
  preview();
});
el.live.addEventListener("change", () => preview());

el.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  setBusy(true);
  el.formError.textContent = "";
  try {
    const typed = el.payload.value.trim();
    const live = el.live.checked;
    // With a pattern, `payload` holds the card number and the code is rebuilt on open.
    const rotation = live ? "" : el.rotation.value.trim();
    await saveCard({
      id: editingId ?? crypto.randomUUID(),
      name: el.name.value,
      payload: typed,
      format: el.format.value as FormatId,
      display: el.display.value,
      rotation: rotation || null,
      live,
      link: el.link.value,
      color: el.color.value,
      order: editingOrder,
      logo: editingLogo,
    });
    el.editor.close();
    try {
      await render();
    } catch {
      el.message.textContent = "Card saved. Reload to refresh the list.";
    }
  } catch (error) {
    el.formError.textContent = `Card not saved. ${(error instanceof Error && error.message) || "Device storage is unavailable."}`;
  } finally {
    setBusy(false);
  }
});

el.deleteButton.addEventListener("click", async () => {
  if (busy || !editingId || !confirm(`Delete ${el.name.value}? This cannot be undone.`)) return;
  setBusy(true);
  try {
    await deleteCard(editingId);
    el.editor.close();
    try {
      await render();
    } catch {
      el.message.textContent = "Card deleted. Reload to refresh the list.";
    }
  } catch {
    el.formError.textContent = "Card not deleted. Device storage is unavailable.";
  } finally {
    setBusy(false);
  }
});

/* ------------------------------------------------------------ Backup, shell */

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * A dialog renders above the page, so a message written into the page behind it was
 * invisible exactly when it mattered — after an export or import, both of which are
 * started from the settings sheet.
 */
function toast(text: string, tone: "ok" | "error" = "ok") {
  el.toast.textContent = text;
  el.toast.classList.toggle("error", tone === "error");
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 4000);
}

el.exportButton.addEventListener("click", async () => {
  try {
    const how = await exportCards();
    el.settings.close();
    toast(how === "shared" ? "Backup shared" : "Backup downloaded");
  } catch (error) {
    // Cancelling the share sheet is a choice, not a failure worth reporting.
    if (error instanceof Error && error.name === "AbortError") return;
    toast(`Could not export. ${error instanceof Error ? error.message : String(error)}`, "error");
  }
});

el.importButton.addEventListener("click", () => el.importFile.click());
el.importFile.addEventListener("change", async (event) => {
  const target = event.target as HTMLInputElement;
  const [file] = target.files ?? [];
  target.value = "";
  if (!file) return;
  try {
    const count = await importCards(file);
    await render();
    el.settings.close();
    toast(`Imported ${count} ${count === 1 ? "card" : "cards"}`);
  } catch (error) {
    toast(`Could not import. ${error instanceof Error ? error.message : String(error)}`, "error");
  }
});

/**
 * Chrome fires this instead of installing, so the app can offer its own button at a
 * sensible moment. Safari never fires it, which is why the iOS path is instructions.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
declare global {
  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
  }
}

const HINT_KEY = "super-app-install-hint";
const KEEPS_CARDS =
  "A browser can clear storage for a site you have not opened in a while; " +
  "an installed app keeps its cards. Export a backup either way.";

let installPrompt: BeforeInstallPromptEvent | null = null;

window.addEventListener("beforeinstallprompt", (event) => {
  // Without this Chrome shows its own bar, which cannot explain why installing matters.
  event.preventDefault();
  installPrompt = event;
  // Injected at build time; see buildVersion in vite.config.ts.
  el.version.textContent = `Version ${__APP_VERSION__}`;

  maybeOfferInstall();
});

window.addEventListener("appinstalled", () => {
  installPrompt = null;
  el.installHint.hidden = true;
});

el.install.addEventListener("click", async () => {
  const prompt = installPrompt;
  if (!prompt) return;
  installPrompt = null;
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  el.installHint.hidden = true;
  if (outcome === "accepted") toast("Installed");
});

function maybeOfferInstall() {
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    // `standalone` is an iOS-only extension that lib.dom does not declare.
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(HINT_KEY) === "yes";
  } catch {
    /* Storage is optional. */
  }
  if (standalone || dismissed) {
    el.installHint.hidden = true;
    return;
  }

  const agent = navigator.userAgent;
  const apple =
    /iPad|iPhone|iPod/.test(agent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  // Every iOS browser is WebKit, but only Safari puts Add to Home Screen in the
  // share sheet; telling a Chrome user to tap Share would send them nowhere.
  const safari = apple && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(agent);

  if (installPrompt) {
    el.install.hidden = false;
    el.installTitle.textContent = "Install this app.";
    el.installText.textContent = KEEPS_CARDS;
  } else if (apple) {
    el.install.hidden = true;
    el.installTitle.textContent = "Add this to your Home Screen.";
    el.installText.textContent = safari
      ? `Tap Share, then \u201cAdd to Home Screen\u201d. ${KEEPS_CARDS}`
      : `Use your browser\u2019s menu to add this to your Home Screen. ${KEEPS_CARDS}`;
  } else {
    // No install path worth describing: a desktop browser, or one that never prompts.
    el.installHint.hidden = true;
    return;
  }
  el.installHint.hidden = false;
}
el.dismissHint.addEventListener("click", () => {
  el.installHint.hidden = true;
  try {
    localStorage.setItem(HINT_KEY, "yes");
  } catch {
    /* Storage is optional. */
  }
});

/**
 * Updating a cache-first app has to be visible, or nobody can tell whether what they
 * are looking at is current. The worker no longer takes over by itself: when a newer
 * one finishes installing, the page offers to switch and reloads on request.
 */
async function watchForUpdates() {
  const registration = await navigator.serviceWorker.register("./sw.js");

  const offer = (worker: ServiceWorker) => {
    el.updateBar.hidden = false;
    el.updateNow.onclick = () => {
      el.updateNow.disabled = true;
      worker.postMessage("skip-waiting");
    };
  };

  // One may already be waiting from an earlier visit.
  if (registration.waiting && navigator.serviceWorker.controller) offer(registration.waiting);

  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      // Without a controller this is the first install, not an update.
      if (worker.state === "installed" && navigator.serviceWorker.controller) offer(worker);
    });
  });

  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  // An installed app can sit for days without a navigation, so check on return.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") registration.update().catch(() => {});
  });
}

if ("serviceWorker" in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener("load", () => {
      watchForUpdates().catch(() => {});
    });
  } else {
    // The worker is emitted by the build only, so in dev this path serves index.html
    // and registration fails on the MIME type. A worker left from a production build
    // would also serve stale files over the dev server, so clear it.
    navigator.serviceWorker
      .getRegistrations()
      .then((all) => Promise.all(all.map((one) => one.unregister())))
      .catch(() => {});
  }
}

// Ask to keep the data; Safari ignores this, which is why export exists.
navigator.storage?.persist?.().catch(() => {});

setView(view);
maybeOfferInstall();
render().catch(() => {
  el.message.textContent = "Cannot open device storage. Check your browser settings, then reload.";
});
