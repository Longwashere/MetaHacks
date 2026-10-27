// BACKEND: replace with real auth (session cookie, JWT, OAuth, etc.).
// Every loader/action that needs the user calls this, so it's the single swap point.
export interface CurrentUser {
  id: string;
  name: string;
}

export async function getCurrentUser(_request: Request): Promise<CurrentUser> {
  return { id: "demo-user", name: "Demo User" };
}
