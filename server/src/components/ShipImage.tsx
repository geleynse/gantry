/**
 * ShipImage component
 * Shows inline SVG ship silhouettes by default.
 * Attempts to load real artwork from the game CDN — if available, it overlays the SVG.
 * Only ~5 premium ships have catalog images; the rest stay as SVG.
 */

"use client";

import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { getShipImageUrl, SIZE_PIXELS, type ShipImageSize } from "@/config/shipImages";
import { ShipImageFallback } from "./ShipImageFallback";
import { applyChromaKey } from "@/lib/chroma-key";
import styles from "./ShipImage.module.css";

export type { ShipImageSize };

export interface ShipImageProps {
  shipClass: string;
  size?: ShipImageSize;
  onClick?: () => void;
  className?: string;
  alt?: string;
  lazy?: boolean;
  rounded?: "none" | "sm" | "md" | "lg" | "full";
  onError?: () => void;
  onLoad?: () => void;
  /** Apply chroma key background removal. Default false — only enable for large displays over dark backgrounds. */
  chromaKey?: boolean;
}

export function ShipImage({
  shipClass,
  size = "thumbnail",
  onClick,
  className,
  alt,
  lazy = true,
  rounded = "sm",
  onError,
  onLoad,
  chromaKey = false,
}: ShipImageProps) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const [chromaUrl, setChromaUrl] = useState<string | null>(null);

  const width = SIZE_PIXELS[size];
  const height = SIZE_PIXELS[size];
  const isInteractive = !!onClick;
  const imgUrl = getShipImageUrl(shipClass);

  // Apply chroma key to remove solid background from CDN ship images
  // Only when explicitly enabled — the auto-detection produces artifacts on small thumbnails
  useEffect(() => {
    if (!chromaKey || !imgLoaded || imgFailed) return;
    let cancelled = false;
    applyChromaKey(imgUrl).then((result) => {
      if (!cancelled) setChromaUrl(result);
    }).catch(() => {
      // Fall back silently to original URL
    });
    return () => { cancelled = true; };
  }, [chromaKey, imgLoaded, imgFailed, imgUrl]);

  const roundedClass =
    rounded === "none" ? ""
    : rounded === "sm" ? styles.container
    : rounded === "md" ? styles.roundedMd
    : rounded === "lg" ? styles.roundedLg
    : styles.roundedFull;

  return (
    <div
      className={cn(
        styles.container,
        roundedClass,
        isInteractive && styles.interactive,
        className,
      )}
      style={{ width: `${width}px`, height: `${height}px` }}
      onClick={onClick}
      onKeyDown={isInteractive ? (e) => { if (e.key === "Enter" || e.key === " ") onClick?.(); } : undefined}
      role={isInteractive ? "button" : "img"}
      tabIndex={isInteractive ? 0 : -1}
      aria-label={alt || `Ship: ${shipClass.replace(/_/g, " ")}`}
    >
      {/* SVG silhouette — always rendered as base layer */}
      <ShipImageFallback shipClass={shipClass} width={width} height={height} />

      {/* CDN image — overlays SVG if it loads successfully.
          When chromaKey is enabled, background is removed via canvas processing.
          Otherwise the raw CDN image is shown directly. */}
      {!imgFailed && (
        <img
          src={chromaKey ? (chromaUrl ?? imgUrl) : imgUrl}
          alt={alt || `${shipClass} ship`}
          className="absolute inset-0 w-full h-full object-cover"
          style={{ opacity: imgLoaded ? 1 : 0, transition: "opacity 300ms ease-in" }}
          loading={lazy ? "lazy" : "eager"}
          decoding="async"
          onLoad={() => { setImgLoaded(true); onLoad?.(); }}
          onError={() => { setImgFailed(true); onError?.(); }}
        />
      )}
    </div>
  );
}
