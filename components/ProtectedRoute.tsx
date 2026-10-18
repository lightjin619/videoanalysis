"use client";

import { Fragment, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useLocalAuth } from "@/hooks/useLocalAuth";

export default function ProtectedRoute({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { status, accountId } = useLocalAuth();

  useEffect(() => {
    if (status === "unauthenticated") {
      router.replace("/");
    }
  }, [router, status]);

  if (status !== "authenticated") {
    return (
      <div className="page-status" role="status">
        Checking your login status.
      </div>
    );
  }

  return <Fragment key={accountId}>{children}</Fragment>;
}
