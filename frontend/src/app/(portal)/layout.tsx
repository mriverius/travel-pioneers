import AuthGuard from "@/components/auth-guard";
import Sidebar from "@/components/sidebar";

export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      <div className="min-h-screen bg-background">
        <Sidebar />
        <main className="lg:ml-[260px] min-h-screen section-header-glow">
          <div className="mx-auto w-full max-w-[1320px] px-6 lg:px-10 py-10 animate-fade-up">
            {children}
          </div>
        </main>
      </div>
    </AuthGuard>
  );
}
