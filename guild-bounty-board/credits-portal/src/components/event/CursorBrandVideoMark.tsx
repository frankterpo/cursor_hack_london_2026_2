"use client";

import { useEffect, useRef } from "react";

/**
 * Cursor marketing logo clip — first frame reads as static mark; hover plays spin
 * (matches cursor-hackathon-hcmc-2025/ui/static/script.js brand video behavior).
 */
export function CursorBrandVideoMark({
  size = "header",
  className = "",
}: {
  size?: "header" | "hero";
  className?: string;
}) {
  const shellRef = useRef<HTMLSpanElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const shell = shellRef.current;
    const brandVideo = videoRef.current;
    if (!shell || !brandVideo) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    brandVideo.pause();
    brandVideo.currentTime = 0;

    const ac = new AbortController();
    const { signal } = ac;

    function isActivelyPlaying() {
      return !brandVideo.paused && !brandVideo.ended;
    }

    function tryPlayBrandVideo() {
      if (reduceMotion) return;
      if (isActivelyPlaying()) return;
      if (brandVideo.ended) brandVideo.currentTime = 0;
      const p = brandVideo.play();
      if (p !== undefined) p.catch(() => {});
    }

    shell.addEventListener("mouseenter", tryPlayBrandVideo, { signal });

    return () => ac.abort();
  }, []);

  const tintClass =
    size === "hero" ? "cursor-brand-video-tint cursor-brand-video-tint--hero" : "cursor-brand-video-tint cursor-brand-video-tint--header";
  const videoClass =
    size === "hero" ? "cursor-brand-video cursor-brand-video--hero" : "cursor-brand-video cursor-brand-video--header";

  return (
    <span ref={shellRef} className={`cursor-brand-video-wrap ${className}`} aria-hidden="true">
      <span className={tintClass}>
        <video ref={videoRef} className={videoClass} playsInline muted preload="auto">
          <source type="video/webm" src="https://cursor.com/marketing-static/logo/logo-dark-theme.webm" />
          <source type="video/mp4" src="https://cursor.com/marketing-static/logo/logo-dark-theme.mp4" />
          <source type="video/quicktime" src="https://cursor.com/marketing-static/logo/logo-dark-theme.mov" />
        </video>
      </span>
    </span>
  );
}
