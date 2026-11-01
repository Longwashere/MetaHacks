import { Link, Outlet } from "react-router";
import { SiteHeader } from "~/components/SiteHeader";

export default function AppLayout() {
  return (
    <div className="flex min-h-svh flex-col">
      <SiteHeader />
      <main className="container mx-auto flex-1 px-4 py-8">
        <Outlet />
      </main>
      <footer className="border-t py-6 text-center text-xs text-muted-foreground flex flex-col items-center justify-center gap-2 sm:flex-row sm:gap-4">
        <span>RigForge · Spine is a trademark of Esoteric Software.</span>
        <span className="hidden sm:inline">·</span>
        <div className="flex items-center gap-3">
          <Link to="/showcase" className="hover:text-foreground underline underline-offset-4">
            Showcase
          </Link>
          <Link to="/remix" className="hover:text-foreground underline underline-offset-4">
            Remix Studio
          </Link>
          <Link to="/explore" className="hover:text-foreground underline underline-offset-4">
            Explore Rigs
          </Link>
        </div>
      </footer>
    </div>
  );
}
