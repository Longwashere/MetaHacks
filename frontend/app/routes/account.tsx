import { CheckCircle2, CreditCard, Crown, Sparkles } from "lucide-react";
import { Form, data, redirect, useFetcher, useNavigation } from "react-router";
import type { Route } from "./+types/account";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Progress } from "~/components/ui/progress";
import { createCheckoutUrl, createPortalUrl, getAccount, updateDisplayName } from "~/lib/api.server";
import { requireSession, syncDisplayName } from "~/lib/auth.server";
import { SITE_NAME } from "~/lib/seo";

export function meta({}: Route.MetaArgs) {
  return [{ title: `Account · ${SITE_NAME}` }, { name: "robots", content: "noindex, nofollow" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const session = requireSession(context, request);
  const checkout = new URL(request.url).searchParams.get("checkout");
  return {
    account: await getAccount(session),
    email: session.user.email,
    checkout: checkout === "success" || checkout === "cancelled" ? checkout : null,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const session = requireSession(context, request);
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "rename") {
    const name = form.get("name");
    if (typeof name !== "string") return data({ nameError: "Enter a display name." }, { status: 400 });
    const result = await updateDisplayName(session, name);
    if (!result.ok) return data({ nameError: result.error }, { status: 400 });
    await syncDisplayName(context, result.account.user.name);
    return { renamed: true };
  }
  if (intent === "upgrade") throw redirect(await createCheckoutUrl(session));
  if (intent === "manage") {
    const url = await createPortalUrl(session);
    if (!url) return data({ error: "There's no subscription to manage yet." }, { status: 404 });
    throw redirect(url);
  }
  return data({ error: "Unknown action." }, { status: 400 });
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export default function Account({ loaderData, actionData }: Route.ComponentProps) {
  const { account, email, checkout } = loaderData;
  const { usage, plan, subscription } = account;
  const navigation = useNavigation();
  const pendingIntent = navigation.state !== "idle" ? navigation.formData?.get("intent") : null;
  const pro = plan === "pro";
  const rename = useFetcher<typeof action>();
  const renameResult = rename.state === "idle" ? rename.data : undefined;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold tracking-tight">Account</h1>
        <p className="text-muted-foreground">
          Signed in as {account.user.name}
          {email && ` (${email})`}
        </p>
      </div>

      {checkout === "success" && (
        <Alert>
          <CheckCircle2 />
          <AlertTitle>Thanks for subscribing!</AlertTitle>
          <AlertDescription>
            {pro ? "Pro is active on your account." : "Your payment went through. Pro will show here in a few seconds — refresh if it doesn't."}
          </AlertDescription>
        </Alert>
      )}
      {actionData && "error" in actionData && (
        <Alert variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Display name</CardTitle>
          <CardDescription>Shown on your account and as the author of every asset you publish.</CardDescription>
        </CardHeader>
        <CardContent>
          <rename.Form method="post" className="flex flex-col gap-2">
            <Label htmlFor="display-name">Display name</Label>
            <div className="flex gap-2">
              <Input
                id="display-name"
                name="name"
                defaultValue={account.user.name}
                required
                minLength={2}
                maxLength={40}
                autoComplete="nickname"
                aria-invalid={renameResult && "nameError" in renameResult ? true : undefined}
                aria-describedby="display-name-status"
              />
              <Button type="submit" name="intent" value="rename" disabled={rename.state !== "idle"}>
                {rename.state !== "idle" ? "Saving…" : "Save"}
              </Button>
            </div>
            <p id="display-name-status" role="status" className="text-sm">
              {renameResult && "nameError" in renameResult ? (
                <span className="text-destructive">{renameResult.nameError}</span>
              ) : renameResult && "renamed" in renameResult ? (
                <span className="text-muted-foreground">Saved. Your assets now show this name.</span>
              ) : null}
            </p>
          </rename.Form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {pro ? <Crown className="size-5 text-primary" /> : <Sparkles className="size-5" />}
            {pro ? "Pro plan" : "Free plan"}
            {account.isAdmin && <Badge>Admin</Badge>}
            {subscription && subscription.status !== "active" && (
              <Badge variant="outline" className="capitalize">
                {subscription.status.replace(/_/g, " ")}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            {pro && subscription?.currentPeriodEnd
              ? `Renews ${formatDate(subscription.currentPeriodEnd)}.`
              : pro
                ? "Thanks for supporting the project."
                : "Upgrade for more remixes every month."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium">Remixes this month</span>
            <span className="tabular-nums text-muted-foreground">
              {usage.limit === null ? `${usage.used} · unlimited` : `${usage.used} / ${usage.limit}`}
            </span>
          </div>
          {usage.limit === null ? (
            <p className="text-xs text-muted-foreground">As an admin you have no monthly limit.</p>
          ) : (
            <>
              <Progress value={usage.limit > 0 ? Math.min((usage.used / usage.limit) * 100, 100) : 100} aria-label="Remixes used this month" />
              <p className="text-xs text-muted-foreground">Resets {formatDate(usage.resetsAt)}. Failed remixes don't count.</p>
            </>
          )}
        </CardContent>
        <CardFooter>
          {!account.billingEnabled ? (
            <p className="text-sm text-muted-foreground">Payments aren't set up yet.</p>
          ) : (
            <Form method="post">
              {pro || subscription ? (
                <Button type="submit" name="intent" value="manage" variant="outline" disabled={pendingIntent === "manage"}>
                  <CreditCard /> {pendingIntent === "manage" ? "Opening…" : "Manage billing"}
                </Button>
              ) : null}
              {!pro && (
                <Button type="submit" name="intent" value="upgrade" disabled={pendingIntent === "upgrade"} className={subscription ? "ml-2" : undefined}>
                  <Crown /> {pendingIntent === "upgrade" ? "Opening checkout…" : "Upgrade to Pro"}
                </Button>
              )}
            </Form>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}
