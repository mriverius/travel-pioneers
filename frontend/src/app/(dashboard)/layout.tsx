import Sidebar from "@/components/sidebar";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <Sidebar />
      <main className="lg:ml-[260px] min-h-screen">
        {children}
      </main>
    </div>
  );
}
