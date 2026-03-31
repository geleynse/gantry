"use client";

import { CredentialDashboard } from "@/components/credential-dashboard";
import { useAuth } from "@/hooks/use-auth";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";

export default function CredentialsPage() {
  const { isAdmin } = useAuth();

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] space-y-4">
        <h1 className="text-xl font-bold text-error uppercase tracking-widest">Access Denied</h1>
        <p className="text-muted-foreground text-sm">Admin privileges are required to manage credentials.</p>
        <Link href="/fleet" className="text-primary hover:underline text-xs uppercase tracking-wider">
          Return to Fleet
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="border-b border-primary/20 pb-4">
        <div className="flex items-center gap-2 mb-2">
          <Link 
            href="/fleet" 
            className="text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 text-[10px] uppercase tracking-widest"
          >
            <ChevronLeft className="w-3 h-3" />
            Back to Fleet
          </Link>
        </div>
        <h1 className="text-lg font-semibold text-primary uppercase tracking-wider">
          Credential Dashboard
        </h1>
        <p className="text-xs text-muted-foreground mt-1">
          Manage game account credentials and view enrollment audit history.
        </p>
      </div>

      <CredentialDashboard />
    </div>
  );
}
