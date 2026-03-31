"use client";

import { useState } from "react";
import { UserPlus, Key } from "lucide-react";
import Link from "next/link";
import { FleetCapacity } from "@/components/fleet-capacity";
import { EnrollmentForm } from "@/components/enrollment-form";
import { useAuth } from "@/hooks/use-auth";

export default function FleetPage() {
  const { isAdmin } = useAuth();
  const [showEnrollForm, setShowEnrollForm] = useState(false);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-primary/20 pb-4">
        <div>
          <h1 className="text-lg font-semibold text-primary uppercase tracking-wider">
            Fleet
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Fleet-wide capacity: credits, cargo, role distribution, and zone coverage.
          </p>
        </div>

        {isAdmin && (
          <div className="flex items-center gap-2">
            <Link
              href="/fleet/credentials"
              className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground border border-border hover:bg-secondary transition-colors"
            >
              <Key className="w-3.5 h-3.5" />
              Manage Credentials
            </Link>
            <button
              onClick={() => setShowEnrollForm(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] uppercase tracking-wider bg-primary text-primary-foreground font-bold hover:opacity-90 transition-opacity"
            >
              <UserPlus className="w-3.5 h-3.5" />
              Enroll Agent
            </button>
          </div>
        )}
      </div>

      {/* Capacity dashboard */}
      <FleetCapacity />

      {/* Enrollment Modal */}
      {showEnrollForm && (
        <EnrollmentForm 
          onClose={() => setShowEnrollForm(false)} 
          onSuccess={() => {
            // Optionally refresh data
          }}
        />
      )}
    </div>
  );
}
