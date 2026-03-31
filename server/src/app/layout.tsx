import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { TopBar } from "@/components/top-bar";
import { AuthProvider } from "@/components/auth-provider";
import { ClientLayout } from "@/components/client-layout";

export const metadata: Metadata = {
  title: "Gantry",
  description: "Fleet management dashboard for SpaceMolt AI agents",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <AuthProvider>
          <div className="flex h-screen overflow-hidden">
            {/* Sidebar — hidden on mobile, visible on md+ */}
            <Sidebar />

            {/* Right-hand column: top bar + scrollable content */}
            <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
              {/* Top bar — fixed at top of content column */}
              <TopBar />

              {/* Main content — scrolls independently */}
              <main className="flex-1 overflow-auto min-h-0">
                <ClientLayout>
                  <div className="p-3 md:p-6">{children}</div>
                </ClientLayout>
              </main>
            </div>
          </div>
        </AuthProvider>
      </body>
    </html>
  );
}
