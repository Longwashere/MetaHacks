import { randomBytes } from "node:crypto";
import { check, db } from "../lib/db.js";

// Creates a username/email + password account for hackathon judges, or gives an existing one a
// new password. The account is confirmed (no email is sent) and gets the Pro allowance, since
// several judges may share it. A username (no "@") becomes <username>@rigforge.test, matching the
// login form. Without --password a random one is generated. Prints the password once.
//
//   npm run create-judge -w backend -- judges [--password <password>] [--name "Display name"]

const args = process.argv.slice(2);
const option = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const login = args[0]?.trim().toLowerCase();
const email = login && !login.startsWith("--") ? (login.includes("@") ? login : `${login}@rigforge.test`) : "";
const name = option("--name")?.trim() || "Hackathon Judge";
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: npm run create-judge -w backend -- <username|email> [--password <password>] [--name "Display name"]');
  process.exit(1);
}

// 18 random bytes → 24 URL-safe characters.
const password = option("--password") ?? randomBytes(18).toString("base64url");
const auth = db().auth.admin;

const existing = await findUser(email);
const userId = existing
  ? (await updatePassword(existing, password), existing)
  : await createUser(email, password, name);

// The profile row comes from the sign-up trigger. Pro is never touched by the Stripe webhook for
// an account without a Stripe customer, so this sticks.
check(await db().from("profiles").update({ plan: "pro", name }).eq("id", userId));

console.log(`${existing ? "Updated" : "Created"} judge account`);
console.log(`  username: ${login}${login.includes("@") ? "" : ` (signs in as ${email})`}`);
console.log(`  password: ${password}`);
console.log("  plan:     pro");

async function findUser(address: string): Promise<string | null> {
  for (let page = 1; ; page++) {
    const { data, error } = await auth.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const match = data.users.find((u) => u.email?.toLowerCase() === address);
    if (match) return match.id;
    if (data.users.length < 1000) return null;
  }
}

async function createUser(address: string, pass: string, displayName: string): Promise<string> {
  const { data, error } = await auth.createUser({
    email: address,
    password: pass,
    email_confirm: true,
    user_metadata: { full_name: displayName },
  });
  if (error) throw error;
  return data.user.id;
}

async function updatePassword(id: string, pass: string): Promise<void> {
  const { error } = await auth.updateUserById(id, { password: pass, email_confirm: true });
  if (error) throw error;
}
