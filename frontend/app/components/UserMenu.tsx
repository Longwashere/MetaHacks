import { Bookmark, LogOut, User } from "lucide-react";
import { Form, Link, useLocation, useRouteLoaderData } from "react-router";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import type { loader as rootLoader } from "~/root";

/** "Sign in" for guests; the user's avatar with account links once signed in. */
export function UserMenu() {
  const user = useRouteLoaderData<typeof rootLoader>("root")?.user ?? null;
  const location = useLocation();

  if (!user) {
    // Don't bounce back to the login page itself after signing in.
    const next = location.pathname === "/login" ? "/" : location.pathname + location.search;
    return (
      <Button asChild size="sm">
        <Link to={`/login?${new URLSearchParams({ next })}`} rel="nofollow">
          Sign in
        </Link>
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="rounded-full" aria-label={`Account menu for ${user.name}`}>
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" className="size-7 rounded-full" />
          ) : (
            <span className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
              {user.name.slice(0, 1).toUpperCase()}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="flex flex-col">
          <span className="flex items-center gap-1.5">
            <span className="truncate">{user.name}</span>
            {user.isAdmin && <Badge className="shrink-0">Admin</Badge>}
          </span>
          {user.email && <span className="truncate text-xs font-normal text-muted-foreground">{user.email}</span>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/account">
            <User /> Account & billing
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/library">
            <Bookmark /> My Library
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <Form method="post" action="/logout">
          <DropdownMenuItem asChild>
            <button type="submit" className="w-full">
              <LogOut /> Sign out
            </button>
          </DropdownMenuItem>
        </Form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
