"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Re-keys its wrapper on `usePathname()` so the CSS `animate-page-enter`
 * keyframe restarts on every route change. Because the key changes as
 * part of the same render that swaps the children, React unmounts the
 * old subtree and mounts a fresh one — which restarts the animation
 * cleanly (no flash of un-animated content between the key change and
 * the next render, unlike a `useEffect`-based key bump).
 */
export default function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div key={pathname} className="animate-page-enter">
      {children}
    </div>
  );
}
