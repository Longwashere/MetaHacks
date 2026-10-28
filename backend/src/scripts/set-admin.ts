import { db } from "../lib/db.js";

// Grants or removes admin (unlimited remixes, can see and moderate any asset) by setting
// app_metadata.role, which only the service-role key can change. It reaches the user's token on
// their next sign-in or token refresh (within the hour).
//
//   npm run set-admin -w backend -- someone@example.com
//   npm run set-admin -w backend -- someone@example.com --remove

const email = process.argv[2]?.trim().toLowerCase();
const remove = process.argv.includes("--remove");
if (!email || email.startsWith("--")) {
  console.error("Usage: npm run set-admin -w backend -- <email> [--remove]");
  process.exit(1);
}

const auth = db().auth.admin;
let user = null;
for (let page = 1; !user; page++) {
  const { data, error } = await auth.listUsers({ page, perPage: 1000 });
  if (error) throw error;
  user = data.users.find((u) => u.email?.toLowerCase() === email) ?? null;
  if (data.users.length < 1000) break;
}
if (!user) {
  console.error(`No user with email ${email}. They need to sign in once first.`);
  process.exit(1);
}

// updateUserById merges app_metadata, so the provider fields Supabase keeps there stay intact.
const { error } = await auth.updateUserById(user.id, { app_metadata: { role: remove ? null : "admin" } });
if (error) throw error;
console.log(`${remove ? "Removed admin from" : "Made admin:"} ${email} (${user.id})`);
console.log("Takes effect on their next sign-in or token refresh (within the hour).");
