/**
 * Finding a QR symbol inside a photograph and reading its modules out.
 *
 * The three corner squares are the whole trick: each is a 1:1:3:1:1 run of dark and
 * light along any line through its middle, which is what makes them findable without
 * knowing where the code is. Their centres then fix the grid, since they sit at known
 * module coordinates whatever the symbol's size.
 */

/** A candidate corner square: where it is, and how wide one module measures there. */
interface Finder {
  x: number;
  y: number;
  module: number;
  /** How many scan lines agreed, used to prefer real corners over coincidences. */
  votes: number;
}

/**
 * Otsu's method: the threshold splitting the histogram so the two sides are as
 * separated as possible. Right for a screenshot or an evenly lit card, where one
 * value serves the whole frame.
 */
export function globalThreshold(grey: Uint8ClampedArray): number {
  const histogram = new Uint32Array(256);
  for (const value of grey) histogram[value] += 1;
  const total = grey.length;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * histogram[i];
  let sumBackground = 0;
  let countBackground = 0;
  let best = 0;
  let bestVariance = -1;
  for (let i = 0; i < 256; i += 1) {
    countBackground += histogram[i];
    if (countBackground === 0) continue;
    const countForeground = total - countBackground;
    if (countForeground === 0) break;
    sumBackground += i * histogram[i];
    const meanBackground = sumBackground / countBackground;
    const meanForeground = (sum - sumBackground) / countForeground;
    const variance = countBackground * countForeground * (meanBackground - meanForeground) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = i;
    }
  }
  return best;
}

/**
 * Two ways to decide dark from light, tried in turn.
 *
 * A block threshold copes with uneven lighting, but the block has to be wider than a
 * module or it slices through one and invents edges. On a screenshot, where the whole
 * frame shares one exposure, a single global threshold is both simpler and better.
 */
export function binarize(
  grey: Uint8ClampedArray,
  width: number,
  height: number,
  block = 0,
): Uint8Array {
  const out = new Uint8Array(width * height);
  if (block === 0) {
    const threshold = globalThreshold(grey);
    for (let i = 0; i < out.length; i += 1) out[i] = grey[i] <= threshold ? 1 : 0;
    return out;
  }
  for (let by = 0; by < height; by += block) {
    for (let bx = 0; bx < width; bx += block) {
      const toX = Math.min(bx + block, width);
      const toY = Math.min(by + block, height);
      let low = 255;
      let high = 0;
      let total = 0;
      let count = 0;
      for (let y = by; y < toY; y += 1) {
        for (let x = bx; x < toX; x += 1) {
          const value = grey[y * width + x];
          if (value < low) low = value;
          if (value > high) high = value;
          total += value;
          count += 1;
        }
      }
      // A block of nearly one shade holds no edge; bias it light so paper stays paper.
      const threshold = high - low > 24 ? total / count : low - 1;
      for (let y = by; y < toY; y += 1) {
        for (let x = bx; x < toX; x += 1) {
          out[y * width + x] = grey[y * width + x] <= threshold ? 1 : 0;
        }
      }
    }
  }
  return out;
}

/** The module width if these five runs are a 1:1:3:1:1 corner, else null. */
function ratio(counts: number[]): number | null {
  const total = counts[0] + counts[1] + counts[2] + counts[3] + counts[4];
  if (total < 7) return null;
  const module = total / 7;
  const slack = module * 0.6;
  const ok =
    Math.abs(module - counts[0]) < slack &&
    Math.abs(module - counts[1]) < slack &&
    Math.abs(module * 3 - counts[2]) < slack * 3 &&
    Math.abs(module - counts[3]) < slack &&
    Math.abs(module - counts[4]) < slack;
  return ok ? module : null;
}

/** Confirms a candidate by looking for the same run pattern down the column. */
function confirmVertical(
  binary: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
): number | null {
  const counts = [0, 0, 0, 0, 0];
  let y = cy;
  while (y >= 0 && binary[y * width + cx]) {
    counts[2] += 1;
    y -= 1;
  }
  while (y >= 0 && !binary[y * width + cx]) {
    counts[1] += 1;
    y -= 1;
  }
  while (y >= 0 && binary[y * width + cx]) {
    counts[0] += 1;
    y -= 1;
  }
  y = cy + 1;
  while (y < height && binary[y * width + cx]) {
    counts[2] += 1;
    y += 1;
  }
  while (y < height && !binary[y * width + cx]) {
    counts[3] += 1;
    y += 1;
  }
  while (y < height && binary[y * width + cx]) {
    counts[4] += 1;
    y += 1;
  }
  return ratio(counts);
}

/** Every corner-square candidate, merged where many scan lines found the same one. */
export function findFinders(binary: Uint8Array, width: number, height: number): Finder[] {
  const found: Finder[] = [];
  const counts = [0, 0, 0, 0, 0];

  const record = (endX: number, y: number) => {
    const module = ratio(counts);
    if (!module) return;
    // Centre of the middle run: back off the trailing two runs and half the third.
    const cx = Math.round(endX - counts[4] - counts[3] - counts[2] / 2);
    if (cx < 0 || cx >= width) return;
    if (!confirmVertical(binary, width, height, cx, y)) return;
    const existing = found.find(
      (f) => Math.abs(f.x - cx) < module * 2 && Math.abs(f.y - y) < module * 2,
    );
    if (existing) {
      existing.x = (existing.x * existing.votes + cx) / (existing.votes + 1);
      existing.y = (existing.y * existing.votes + y) / (existing.votes + 1);
      existing.module = (existing.module * existing.votes + module) / (existing.votes + 1);
      existing.votes += 1;
    } else {
      found.push({ x: cx, y, module, votes: 1 });
    }
  };

  for (let y = 0; y < height; y += 1) {
    counts.fill(0);
    let state = 0;
    for (let x = 0; x < width; x += 1) {
      const dark = binary[y * width + x] === 1;
      if (dark === (state % 2 === 0)) {
        counts[state] += 1;
      } else if (state === 4) {
        record(x, y);
        // Slide the window: the last three runs may begin the next corner.
        counts[0] = counts[2];
        counts[1] = counts[3];
        counts[2] = counts[4];
        counts[3] = 1;
        counts[4] = 0;
        state = 3;
      } else {
        state += 1;
        counts[state] += 1;
      }
    }
    if (state === 4) record(width, y);
  }
  // Two agreeing scan lines is the least that distinguishes a corner from noise.
  return found.filter((f) => f.votes >= 2);
}

/**
 * Orders three corners as top-left, top-right, bottom-left. The top-left is the one at
 * the right angle, which is the corner furthest from the longest side.
 */
function orient(finders: Finder[]): [Finder, Finder, Finder] | null {
  const [a, b, c] = finders;
  const distance = (p: Finder, q: Finder) => (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
  const sides: [number, Finder, Finder, Finder][] = [
    [distance(b, c), a, b, c],
    [distance(a, c), b, a, c],
    [distance(a, b), c, a, b],
  ];
  sides.sort((p, q) => q[0] - p[0]);
  const [, corner, first, second] = sides[0];
  // Cross product decides which of the other two is to the right of the corner.
  const cross =
    (first.x - corner.x) * (second.y - corner.y) - (first.y - corner.y) * (second.x - corner.x);
  return cross < 0 ? [corner, second, first] : [corner, first, second];
}

/**
 * A module's value by vote across a small window rather than one pixel.
 *
 * Stylised codes draw each module as a circle with a gap around it, so the exact
 * centre is reliable but anything off it is not, and a single misplaced sample flips a
 * module. Voting over a window about a third of a module wide tolerates that, and the
 * drift that comes from estimating the grid from three corners.
 */
function majority(
  binary: Uint8Array,
  width: number,
  height: number,
  px: number,
  py: number,
  module: number,
): number {
  const reach = Math.max(0, Math.min(3, Math.floor(module / 3)));
  if (reach === 0) return binary[py * width + px];
  let dark = 0;
  let total = 0;
  for (let dy = -reach; dy <= reach; dy += 1) {
    for (let dx = -reach; dx <= reach; dx += 1) {
      const x = px + dx;
      const y = py + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      dark += binary[y * width + x];
      total += 1;
    }
  }
  return total > 0 && dark * 2 > total ? 1 : 0;
}

/**
 * Samples the symbol into a grid of modules.
 *
 * The mapping is affine, built from the three corner centres, which sit at module
 * (3.5, 3.5), (size - 3.5, 3.5) and (3.5, size - 3.5). That holds for a photograph
 * taken roughly square-on; a steep angle would need the alignment pattern as a fourth
 * point, which is not attempted here.
 */
export function locateQr(
  grey: Uint8ClampedArray,
  width: number,
  height: number,
): { grid: Uint8Array; size: number } | null {
  // Global first: a screenshot or an evenly lit card reads best that way, and the
  // block sizes below only help when the lighting genuinely varies across the frame.
  for (const block of [0, 32, 16]) {
    const found = attempt(grey, width, height, block);
    if (found) return found;
  }
  return null;
}

function attempt(
  grey: Uint8ClampedArray,
  width: number,
  height: number,
  block: number,
): { grid: Uint8Array; size: number } | null {
  const binary = binarize(grey, width, height, block);
  const finders = findFinders(binary, width, height)
    .sort((a, b) => b.votes - a.votes)
    .slice(0, 12);
  if (finders.length < 3) return null;

  // Try the most-agreed triples first; a photo can throw up a few false corners.
  for (let i = 0; i < finders.length; i += 1) {
    for (let j = i + 1; j < finders.length; j += 1) {
      for (let k = j + 1; k < finders.length; k += 1) {
        const ordered = orient([finders[i], finders[j], finders[k]]);
        if (!ordered) continue;
        const [topLeft, topRight, bottomLeft] = ordered;
        const modules = [topLeft.module, topRight.module, bottomLeft.module];
        const module = (modules[0] + modules[1] + modules[2]) / 3;
        if (module < 1) continue;
        // Three corners of one symbol measure the same module. A triple that disagrees
        // is a real corner plus something that merely looked like one.
        if (Math.max(...modules) > Math.min(...modules) * 1.4) continue;
        const across = Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y);
        const down = Math.hypot(bottomLeft.x - topLeft.x, bottomLeft.y - topLeft.y);
        // The two sides must match: a QR is square.
        if (Math.abs(across - down) > Math.max(across, down) * 0.25) continue;
        let size = Math.round((across + down) / 2 / module + 7);
        // Valid dimensions are 17 + 4v; snap to the nearest.
        size = 17 + 4 * Math.max(1, Math.round((size - 17) / 4));
        if (size < 21 || size > 57) continue;

        const span = size - 7;
        const grid = new Uint8Array(size * size);
        let plausible = true;
        for (let y = 0; y < size && plausible; y += 1) {
          for (let x = 0; x < size; x += 1) {
            const u = (x + 0.5 - 3.5) / span;
            const v = (y + 0.5 - 3.5) / span;
            const px = Math.round(
              topLeft.x + u * (topRight.x - topLeft.x) + v * (bottomLeft.x - topLeft.x),
            );
            const py = Math.round(
              topLeft.y + u * (topRight.y - topLeft.y) + v * (bottomLeft.y - topLeft.y),
            );
            if (px < 0 || py < 0 || px >= width || py >= height) {
              plausible = false;
              break;
            }
            grid[y * size + x] = majority(binary, width, height, px, py, module);
          }
        }
        if (plausible) return { grid, size };
      }
    }
  }
  return null;
}
