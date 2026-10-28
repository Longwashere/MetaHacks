import { Outlet } from "react-router";
import { SiteHeader } from "~/components/SiteHeader";

export default function AppLayout() {
  return (
    <div className="flex min-h-svh flex-col">
      <SiteHeader />
      <main className="container mx-auto flex-1 px-4 py-8">
        <Outlet />
      </main>
      <footer className="border-t py-6 text-center text-xs text-muted-foreground">
        RigForge · Spine is a trademark of Esoteric Software.
      </footer>
    </div>
  );
}
