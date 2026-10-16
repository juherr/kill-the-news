import { MailboxId } from "../domain/value-objects/mailbox-id";
import { EmailAddress } from "../domain/value-objects/email-address";
import { AttachmentData, EmailMetadata, Env } from "../types";
import { bumpCounters } from "../application/stats";
import { dispatchFeedEvents } from "../application/feed-events";
import { parseOneClickUnsubscribe } from "../infrastructure/unsubscribe";
import { getAttachmentBucket } from "../infrastructure/attachments";
import {
  extractFeedLinks,
  extractInlineCids,
  extractLinks,
  htmlToText,
} from "../infrastructure/html-processor";
import { detectConfirmation } from "../domain/confirmation";
import { detectNativeFeeds } from "../domain/native-feed";
import { attachmentIdsForCleanup } from "./feed-cleanup";
import { FeedRepository } from "../infrastructure/feed-repository";
import { BackgroundScheduler } from "../infrastructure/worker";
import { Feed } from "../domain/feed.aggregate";
import { logger } from "../infrastructure/logger";
import { FEED_MAX_BYTES } from "../config/constants";

export interface RawAttachment {
  filename: string;
  contentType: string;
  content: ArrayBuffer;
  contentId?: string;
}

export interface ProcessEmailInput {
  toAddress: string;
  from: string;
  senders: string[];
  subject: string;
  content: string;
  receivedAt: number;
  headers?: Record<string, string>;
  attachments?: RawAttachment[];
}

export type IngestRejectionReason =
  | "invalid_address"
  | "mailbox_unknown"
  | "feed_not_found"
  | "feed_expired"
  | "sender_blocked";

/**
 * Outcome of ingesting an email — a domain result, not an HTTP concern. The edge
 * (forwardemail.ts) maps this to a status code; the Cloudflare email handler
 * logs the reason. Keeping HTTP out of the core keeps ingestion transport-agnostic.
 */
export type IngestResult =
  | { ok: true; feedId: string }
  | { ok: false; reason: IngestRejectionReason };

async function uploadAttachments(
  attachments: RawAttachment[],
  bucket: R2Bucket,
  inlineCids: Set<string>,
): Promise<AttachmentData[]> {
  return Promise.all(
    attachments.map(async (att) => {
      const id = crypto.randomUUID();
      const inline = att.contentId ? inlineCids.has(att.contentId) : false;
      await bucket.put(id, att.content, {
        httpMetadata: {
          contentType: att.contentType,
          contentDisposition: `${inline ? "inline" : "attachment"}; filename="${att.filename}"`,
        },
      });
      return {
        id,
        filename: att.filename,
        contentType: att.contentType,
        size: att.content.byteLength,
        ...(att.contentId ? { contentId: att.contentId } : {}),
        ...(inline ? { inline: true } : {}),
      };
    }),
  );
}

async function loadAcceptingFeed(
  input: ProcessEmailInput,
  env: Env,
): Promise<
  { ok: true; feed: Feed } | { ok: false; reason: IngestRejectionReason }
> {
  // MailboxId.parse is the single boundary where an untrusted inbound address
  // (the most untrusted input in the system) becomes a validated mailbox.
  const mailbox = MailboxId.parse(input.toAddress);
  if (!mailbox) {
    logger.error("Invalid email address format", {
      toAddress: input.toAddress,
    });
    return { ok: false, reason: "invalid_address" };
  }

  // Resolve the inbound mailbox to the feed's opaque id (decoupled identities).
  const repo = FeedRepository.from(env);
  const feedId = await repo.resolveInbound(mailbox);
  if (!feedId) {
    // No feed claims this address — the common "wrong/unknown alias" case.
    logger.error("Unknown inbound mailbox", { mailbox: mailbox.value });
    return { ok: false, reason: "mailbox_unknown" };
  }

  const feed = await repo.load(feedId);
  if (!feed) {
    // The index resolved but the feed is gone — a dangling index (should be
    // near-impossible now the index is dropped on feed deletion).
    logger.error("Feed not found", {
      mailbox: mailbox.value,
      feedId: feedId.value,
    });
    return { ok: false, reason: "feed_not_found" };
  }
  if (feed.isExpired()) {
    logger.warn("Rejected email: feed expired", { feedId: feedId.value });
    return { ok: false, reason: "feed_expired" };
  }
  if (feed.accepts(input.senders) === "blocked") {
    logger.warn("Rejected email: sender filter", {
      feedId: feedId.value,
      senders: input.senders,
      allowedSenders: feed.allowedSenders(),
      blockedSenders: feed.blockedSenders(),
    });
    return { ok: false, reason: "sender_blocked" };
  }

  return { ok: true, feed };
}

/**
 * Compute a SHA-256 hex digest of a normalised string combining subject and
 * content. Used as a dedup fallback when no Message-ID header is present.
 * "Normalised" means lower-cased and all whitespace runs collapsed to a single
 * space — so minor whitespace differences in re-sent mails still match.
 */
async function computeDedupHash(
  subject: string,
  content: string,
): Promise<string> {
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const raw = `${normalize(subject)}\n${normalize(content)}`;
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Extract the Message-ID from request headers (case-insensitive key lookup).
 * Returns undefined when absent or empty.
 */
function extractMessageId(
  headers: Record<string, string> | undefined,
): string | undefined {
  if (!headers) return undefined;
  const value = Object.entries(headers).find(
    ([k]) => k.toLowerCase() === "message-id",
  )?.[1];
  const trimmed = value?.trim();
  return trimmed || undefined;
}

async function storeEmail(
  feed: Feed,
  input: ProcessEmailInput,
  env: Env,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<boolean> {
  // ── Dedup check ──────────────────────────────────────────────────────────
  // Compute both dedup signals up-front (hash is async) so we only do it once.
  const messageId = extractMessageId(input.headers);
  const dedupHash = await computeDedupHash(input.subject, input.content);

  if (feed.hasDuplicate(messageId, dedupHash)) {
    logger.info("Duplicate email skipped", {
      feedId: feed.id.value,
      ...(messageId ? { messageId } : { dedupHash }),
    });
    await bumpCounters(env.EMAIL_STORAGE, { emails_deduplicated: 1 });
    return false; // signal: skipped (not stored)
  }

  const confirmationLinks = detectConfirmation({
    subject: input.subject,
    text: htmlToText(input.content),
    links: extractLinks(input.content),
  });

  const sender = EmailAddress.parse(input.from);
  const nativeFeedList = detectNativeFeeds(
    extractFeedLinks(input.content, sender?.siteBaseUrl() ?? ""),
  );

  const attachmentBucket = getAttachmentBucket(env);
  const inlineCids = extractInlineCids(input.content);
  const storedAttachments: AttachmentData[] =
    attachmentBucket && input.attachments?.length
      ? await uploadAttachments(input.attachments, attachmentBucket, inlineCids)
      : [];

  const emailData = {
    subject: input.subject,
    from: input.from,
    content: input.content,
    receivedAt: input.receivedAt,
    headers: input.headers ?? {},
    ...(storedAttachments.length > 0 ? { attachments: storedAttachments } : {}),
  };

  const repo = FeedRepository.from(env);
  const emailKey = repo.newEmailKey(feed.id);
  await repo.putEmail(emailKey, emailData);

  const serialisedSize = new TextEncoder().encode(
    JSON.stringify(emailData),
  ).byteLength;
  const downloadableIds = storedAttachments
    .filter((a) => !a.inline)
    .map((a) => a.id);
  const inlineIds = storedAttachments.filter((a) => a.inline).map((a) => a.id);
  const newEntry: EmailMetadata = {
    key: emailKey,
    subject: emailData.subject,
    receivedAt: emailData.receivedAt,
    size: serialisedSize,
    ...(downloadableIds.length > 0 ? { attachmentIds: downloadableIds } : {}),
    ...(inlineIds.length > 0 ? { inlineAttachmentIds: inlineIds } : {}),
    ...(messageId ? { messageId } : {}),
    dedupHash,
    // null = not a confirmation; [] = a code-based confirmation (flag it, no
    // link to surface). Both an empty and a populated array mean "detected".
    ...(confirmationLinks !== null
      ? { confirmation: { links: confirmationLinks } }
      : {}),
  };

  // Track the latest sender's domain (feed icon) and capture the RFC 8058
  // one-click unsubscribe link, keyed by sender so each newsletter keeps its
  // own latest URL (fired when the feed is deleted).
  const iconDomain = sender?.domain.value;
  const senderKey = input.senders[0] || iconDomain || input.from;
  const unsubUrl = parseOneClickUnsubscribe(input.headers ?? {});
  const unsub = unsubUrl ? { senderKey, url: unsubUrl } : undefined;

  const maxBytes =
    parseInt(env.FEED_MAX_SIZE_BYTES ?? "", 10) || FEED_MAX_BYTES;

  const { dropped } = feed.ingest(newEntry, {
    maxBytes,
    iconDomain: iconDomain ?? undefined,
    unsub,
    ...(nativeFeedList.length > 0
      ? { nativeFeeds: { senderKey, feeds: nativeFeedList } }
      : {}),
  });

  const r2Deletions =
    attachmentBucket && dropped.length > 0
      ? dropped
          .flatMap((e) => attachmentIdsForCleanup(e))
          .map((id) => attachmentBucket.delete(id))
      : [];

  // KV has no compare-and-swap: the load (in loadAcceptingFeed) and this write
  // are not serialised, so concurrent ingests for one feed can lose updates.
  // Accepted under KV's eventual-consistency model; the Feed aggregate is the
  // seam a Durable Object would later wrap to serialise these writers.
  await Promise.all([
    repo.saveMetadata(feed),
    ...dropped.map((e) => repo.deleteEmail(e.key)),
    ...r2Deletions,
  ]);

  logger.info("Email processed", { feedId: feed.id.value });

  // The aggregate recorded an EmailIngested event; the dispatcher applies its
  // side effects (received counter, WebSub ping, favicon fetch). Background work
  // rides on ctx.waitUntil when present, and is skipped in its absence (tests).
  const schedule: BackgroundScheduler = ctx
    ? (p) => ctx.waitUntil(p)
    : () => {};
  await dispatchFeedEvents(feed, env, schedule);
  return true; // signal: stored
}

export async function processEmail(
  input: ProcessEmailInput,
  env: Env,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<IngestResult> {
  const validation = await loadAcceptingFeed(input, env);
  if (!validation.ok) {
    await bumpCounters(env.EMAIL_STORAGE, { emails_rejected: 1 });
    return validation;
  }

  await storeEmail(validation.feed, input, env, ctx);
  return { ok: true, feedId: validation.feed.id.value };
}
