import { Hono } from "hono";
import { Env } from "../types";
import {
  verifyAndStoreSubscription,
  verifyAndDeleteSubscription,
} from "../infrastructure/websub";
import { waitUntilSafe } from "../infrastructure/worker";
import { DEFAULT_LEASE_SECONDS, MAX_LEASE_SECONDS } from "../config/constants";
import { feedTopicPattern } from "../infrastructure/urls";
import { FeedRepository } from "../infrastructure/feed-repository";
import { FeedId } from "../domain/value-objects/feed-id";

type AppEnv = { Bindings: Env };

export const hubRouter = new Hono<AppEnv>();

hubRouter.post("/", async (c) => {
  const env = c.env;
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.text(
      "Bad Request: expected application/x-www-form-urlencoded",
      400,
    );
  }

  const mode = form.get("hub.mode");
  const topic = form.get("hub.topic");
  const callbackUrl = form.get("hub.callback");

  if (!mode || !topic || !callbackUrl) {
    return c.text(
      "Bad Request: hub.mode, hub.topic and hub.callback are required",
      400,
    );
  }

  if (
    typeof mode !== "string" ||
    typeof topic !== "string" ||
    typeof callbackUrl !== "string"
  ) {
    return c.text("Bad Request: unexpected field types", 400);
  }

  if (mode !== "subscribe" && mode !== "unsubscribe") {
    return c.text(
      "Bad Request: hub.mode must be subscribe or unsubscribe",
      400,
    );
  }

  let parsedCallback: URL;
  try {
    parsedCallback = new URL(callbackUrl);
  } catch {
    return c.text("Bad Request: hub.callback must be a valid URL", 400);
  }
  if (parsedCallback.protocol !== "https:") {
    return c.text("Bad Request: hub.callback must use HTTPS", 400);
  }

  // Validate that topic matches a known RSS or Atom feed on this hub
  const topicPattern = feedTopicPattern(env);
  const match = topic.match(topicPattern);
  if (!match) {
    return c.text(
      "Bad Request: hub.topic must be an RSS or Atom feed URL on this hub",
      400,
    );
  }
  const format = match[1] as "rss" | "atom";
  const feedId = FeedId.unchecked(match[2]);

  // Verify the feed exists before accepting any subscription
  const feedConfig = await FeedRepository.from(env).getConfig(feedId);
  if (!feedConfig) {
    return c.text("Not Found: feed does not exist", 404);
  }

  const secretField = form.get("hub.secret");
  const leaseField = form.get("hub.lease_seconds");
  if (
    (secretField !== null && typeof secretField !== "string") ||
    (leaseField !== null && typeof leaseField !== "string")
  ) {
    return c.text("Bad Request: unexpected field types", 400);
  }
  const secret = secretField || undefined; // "" → undefined
  if (secret && secret.length > 200) {
    return c.text("Bad Request: hub.secret must be under 200 bytes", 400);
  }
  const rawLease = parseInt(leaseField ?? "", 10);
  const leaseSeconds = isNaN(rawLease)
    ? DEFAULT_LEASE_SECONDS
    : Math.min(Math.max(rawLease, 1), MAX_LEASE_SECONDS);

  // Return 202 immediately; verification is async
  if (mode === "subscribe") {
    waitUntilSafe(
      c,
      verifyAndStoreSubscription(
        feedId,
        callbackUrl as string,
        secret as string | undefined,
        leaseSeconds,
        format,
        env,
      ),
    );
  } else {
    waitUntilSafe(
      c,
      verifyAndDeleteSubscription(feedId, callbackUrl as string, env),
    );
  }

  return c.text("Accepted", 202);
});
