"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/useAuth";

/**
 * Inverse of `AuthGuard` — prevents a logged-in user from seeing the
 * /login or /register pages and sends them back to the portal instead.
 */
export default function GuestGuard({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { session, ready } = useAuth();

  useEffect(() => {
    if (ready && session) {
      router.replace("/agent/supplier-intelligence");
    }
  }, [ready, session, router]);

  if (ready && session) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  return <>{children}</>;
}
