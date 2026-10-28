import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useFetcher,
  useRouteLoaderData,
} from "react-router";

import type { Route } from "./+types/root";
import { Toaster } from "~/components/ui/sonner";
import { TooltipProvider } from "~/components/ui/tooltip";
import { authMiddleware, getSession } from "~/lib/auth.server";
import { getTheme, type Theme } from "~/lib/theme.server";
import "./app.css";

export const middleware: Route.MiddlewareFunction[] = [authMiddleware];

export async function loader({ request, context }: Route.LoaderArgs) {
  // Only the public fields: the session's access token must not reach the browser.
  return { theme: await getTheme(request), user: getSession(context)?.user ?? null };
}

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const loaderData = useRouteLoaderData<typeof loader>("root");
  // Optimistically apply the theme while the ThemeToggle fetcher is in flight.
  const themeFetcher = useFetcher({ key: "theme" });
  const pendingTheme = themeFetcher.formData?.get("theme");
  const theme: Theme =
    pendingTheme === "light" || pendingTheme === "dark"
      ? pendingTheme
      : (loaderData?.theme ?? "dark");

  return (
    <html lang="en" className={theme}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body className="min-h-svh antialiased">
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster theme={theme} richColors={false} position="bottom-right" />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="container mx-auto p-4 pt-16">
      <h1 className="text-2xl font-semibold">{message}</h1>
      <p className="text-muted-foreground">{details}</p>
      {stack && (
        <pre className="mt-4 w-full overflow-x-auto rounded-md bg-muted p-4 text-sm">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
