/**
 * chroma-key.ts
 *
 * Client-side chroma key (green/solid background removal) for ship sprite images.
 * Uses Canvas 2D API to sample pixels and replace background colors with transparency.
 *
 * Usage:
 *   const dataUrl = await applyChromaKey(imageUrl, { hue: 120, tolerance: 0.35 });
 *   // Use dataUrl as <img src> — background pixels are now transparent.
 *
 * How it works:
 *   1. Load the image into an offscreen canvas
 *   2. Sample a few corner pixels to detect the background color
 *   3. Walk every pixel; if HSL distance from background is within tolerance, set alpha=0
 *   4. Edge-feather: pixels near the threshold get partial alpha for smoother cutout
 *   5. Cache results by URL so repeated calls are free
 *
 * Browser-only. Returns the original URL on error or in non-browser environments.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChromaKeyOptions {
  /**
   * Target hue in degrees (0-360). 120 = green.
   * If omitted, the background color is auto-detected from image corners.
   */
  hue?: number;
  /** Hue tolerance in degrees (default 40). Larger = more aggressive keying. */
  hueTolerance?: number;
  /**
   * Saturation minimum threshold (0-1, default 0.25).
   * Pixels below this saturation are treated as near-neutral and keyed
   * only if their lightness also matches the background.
   */
  satThreshold?: number;
  /**
   * Overall color distance tolerance (0-1, default 0.35).
   * Higher = removes more background, may clip ship edges.
   */
  tolerance?: number;
  /**
   * Feather width: pixels within this fraction of the tolerance boundary
   * get partial alpha (0-1, default 0.15).
   */
  feather?: number;
  /**
   * Auto-detect background color from corners instead of using `hue`.
   * Enabled by default when `hue` is not provided.
   */
  autoDetect?: boolean;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

interface HSL {
  h: number; // 0-360
  s: number; // 0-1
  l: number; // 0-1
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const processedCache = new Map<string, string>();

// ---------------------------------------------------------------------------
// Color math
// ---------------------------------------------------------------------------

function rgbToHsl({ r, g, b }: RGB): HSL {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;

  if (max === min) return { h: 0, s: 0, l };

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h: number;
  if (max === rn) {
    h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  } else if (max === gn) {
    h = ((bn - rn) / d + 2) / 6;
  } else {
    h = ((rn - gn) / d + 4) / 6;
  }

  return { h: h * 360, s, l };
}

/**
 * Euclidean distance in normalized HSL space.
 * Hue is circular, so we use angular distance capped at 180deg.
 */
function hslDistance(a: HSL, b: HSL): number {
  const dh = Math.min(Math.abs(a.h - b.h), 360 - Math.abs(a.h - b.h)) / 180;
  const ds = Math.abs(a.s - b.s);
  const dl = Math.abs(a.l - b.l);
  return Math.sqrt(dh * dh + ds * ds + dl * dl) / Math.sqrt(3);
}

/**
 * Sample pixel color at (x, y) from ImageData.
 */
function samplePixel(data: Uint8ClampedArray, x: number, y: number, width: number): RGB {
  const i = (y * width + x) * 4;
  return { r: data[i], g: data[i + 1], b: data[i + 2] };
}

/**
 * Auto-detect background color by sampling the 4 corners + midpoints of edges.
 * Returns the most common color cluster, defaulting to green if corners vary.
 */
function detectBackground(
  data: Uint8ClampedArray,
  width: number,
  height: number
): RGB {
  const samples: RGB[] = [
    samplePixel(data, 0, 0, width),
    samplePixel(data, width - 1, 0, width),
    samplePixel(data, 0, height - 1, width),
    samplePixel(data, width - 1, height - 1, width),
    samplePixel(data, Math.floor(width / 2), 0, width),
    samplePixel(data, Math.floor(width / 2), height - 1, width),
    samplePixel(data, 0, Math.floor(height / 2), width),
    samplePixel(data, width - 1, Math.floor(height / 2), width),
  ];

  // Average the samples (good enough for solid or near-solid backgrounds)
  const avg = samples.reduce(
    (acc, s) => ({ r: acc.r + s.r, g: acc.g + s.g, b: acc.b + s.b }),
    { r: 0, g: 0, b: 0 }
  );
  return {
    r: Math.round(avg.r / samples.length),
    g: Math.round(avg.g / samples.length),
    b: Math.round(avg.b / samples.length),
  };
}

// ---------------------------------------------------------------------------
// Core processing
// ---------------------------------------------------------------------------

/**
 * Process an HTMLImageElement on an offscreen canvas.
 * Returns a data URL with background removed.
 */
function processImage(img: HTMLImageElement, opts: ChromaKeyOptions): string {
  const {
    hueTolerance = 40,
    satThreshold = 0.2,
    tolerance = 0.38,
    feather = 0.15,
    autoDetect = true,
  } = opts;

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;

  if (canvas.width === 0 || canvas.height === 0) {
    return img.src;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return img.src;

  ctx.drawImage(img, 0, 0);

  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    // Cross-origin; can't read pixels — return original
    return img.src;
  }

  const { data } = imageData;
  const w = canvas.width;
  const h = canvas.height;

  // Determine the background HSL target
  let bgHsl: HSL;
  if (typeof opts.hue === "number") {
    bgHsl = { h: opts.hue, s: 1.0, l: 0.5 };
  } else if (autoDetect) {
    const bg = detectBackground(data, w, h);
    bgHsl = rgbToHsl(bg);
  } else {
    // Default: green screen
    bgHsl = { h: 120, s: 1.0, l: 0.5 };
  }

  const featherLow = tolerance * (1 - feather);
  const featherHigh = tolerance;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    // Skip fully transparent pixels
    if (data[i + 3] === 0) continue;

    const hsl = rgbToHsl({ r, g, b });

    // Hue check: for chromatic colors (s > satThreshold), test hue proximity
    let dist: number;
    if (hsl.s > satThreshold) {
      const hueDiff = Math.min(
        Math.abs(hsl.h - bgHsl.h),
        360 - Math.abs(hsl.h - bgHsl.h)
      );
      if (hueDiff > hueTolerance) continue; // Clearly not background
      dist = hslDistance(hsl, bgHsl);
    } else {
      // Near-neutral pixel — check lightness proximity to background
      const dlightness = Math.abs(hsl.l - bgHsl.l);
      dist = dlightness;
    }

    if (dist >= featherHigh) continue; // Not background

    if (dist <= featherLow) {
      // Fully transparent
      data[i + 3] = 0;
    } else {
      // Feathered edge: partial alpha
      const blend = (dist - featherLow) / (featherHigh - featherLow);
      data[i + 3] = Math.round(blend * data[i + 3]);
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load an image from `url` and remove its background using chroma key.
 * Returns a data URL (PNG with alpha) suitable for use as <img src>.
 *
 * Results are cached by URL — subsequent calls for the same URL return instantly.
 * Returns the original URL if running server-side, or if processing fails.
 */
export async function applyChromaKey(
  url: string,
  opts: ChromaKeyOptions = {}
): Promise<string> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return url;
  }

  const cacheKey = `${url}::${JSON.stringify(opts)}`;
  const cached = processedCache.get(cacheKey);
  if (cached) return cached;

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";

    img.onload = () => {
      try {
        const result = processImage(img, opts);
        processedCache.set(cacheKey, result);
        resolve(result);
      } catch {
        resolve(url);
      }
    };

    img.onerror = () => resolve(url);
    img.src = url;
  });
}

/**
 * Synchronously check if a URL has already been processed.
 * Useful for components that want to avoid a loading flash.
 */
export function getCachedChromaKey(url: string, opts: ChromaKeyOptions = {}): string | null {
  const cacheKey = `${url}::${JSON.stringify(opts)}`;
  return processedCache.get(cacheKey) ?? null;
}

/**
 * Clear the chroma key cache (useful in tests or if images change).
 */
export function clearChromaKeyCache(): void {
  processedCache.clear();
}

/**
 * Estimate whether an image URL is likely to need chroma keying.
 * The ship CDN images are known to have solid backgrounds.
 */
export function isShipCdnImage(url: string): boolean {
  return url.includes("spacemolt.com/images/ships");
}
