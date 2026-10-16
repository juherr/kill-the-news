import { EmailParser } from "../domain/email-parser";
import { Env } from "../types";
import {
  processEmail,
  IngestResult,
  RawAttachment,
} from "../application/email-processor";
import { normalizeCid } from "../infrastructure/html-processor";

/** Map an ingestion result to the HTTP response ForwardEmail expects. */
export function ingestResultToResponse(result: IngestResult): Response {
  if (result.ok) {
    return new Response("Email processed successfully", { status: 200 });
  }
  switch (result.reason) {
    case "invalid_address":
      return new Response("Invalid email address format", { status: 400 });
    case "mailbox_unknown":
      return new Response("No feed for this address", { status: 404 });
    case "feed_not_found":
      return new Response("Feed does not exist", { status: 404 });
    case "feed_expired":
      return new Response("Feed has expired", { status: 410 });
    case "sender_blocked":
      return new Response("Sender not allowed for this feed", { status: 403 });
  }
}

export interface ForwardEmailAttachment {
  filename?: string;
  contentType?: string;
  size?: number;
  cid?: string;
  contentId?: string;
  content?: { type: "Buffer"; data: number[] } | ArrayBuffer | ArrayBufferView;
}

export interface ForwardEmailPayload {
  recipients?: string[];
  from?: {
    value?: Array<{ address?: string; name?: string }>;
    text?: string;
    html?: string;
  };
  subject?: string;
  text?: string;
  html?: string;
  date?: string;
  messageId?: string;
  headerLines?: Array<{ key: string; line: string }>;
  headers?: string;
  raw?: string;
  attachments?: ForwardEmailAttachment[];
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function extractSenderAddresses(payload: ForwardEmailPayload): string[] {
  const valueEntries = payload.from?.value || [];
  const structuredAddresses = valueEntries
    .map((entry) => entry.address || "")
    .map(normalizeEmail)
    .filter(Boolean);

  if (structuredAddresses.length > 0) {
    return Array.from(new Set(structuredAddresses));
  }

  const fromText = payload.from?.text || "";
  const matches =
    fromText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return Array.from(new Set(matches.map(normalizeEmail)));
}

function toArrayBuffer(
  content: ForwardEmailAttachment["content"],
): ArrayBuffer | null {
  if (!content) return null;
  if (content instanceof ArrayBuffer) return content;
  if (ArrayBuffer.isView(content))
    return (content as ArrayBufferView).buffer as ArrayBuffer;
  if (
    typeof content === "object" &&
    content.type === "Buffer" &&
    Array.isArray(content.data)
  ) {
    return Uint8Array.from(content.data).buffer as ArrayBuffer;
  }
  return null;
}

export async function handleForwardEmail(
  payload: ForwardEmailPayload,
  env: Env,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
  const emailData = EmailParser.parseForwardEmailPayload(payload);

  const rawAttachments: RawAttachment[] = (payload.attachments ?? [])
    .map((a): RawAttachment | null => {
      const buffer = toArrayBuffer(a.content);
      if (!buffer) return null;
      return {
        filename: a.filename || "attachment",
        contentType: a.contentType || "application/octet-stream",
        content: buffer,
        contentId: normalizeCid(a.cid ?? a.contentId),
      };
    })
    .filter((a): a is RawAttachment => a !== null);

  const result = await processEmail(
    {
      toAddress: payload.recipients?.[0] || "",
      from: emailData.from,
      senders: extractSenderAddresses(payload),
      subject: emailData.subject,
      content: emailData.content,
      receivedAt: emailData.receivedAt,
      headers: emailData.headers,
      attachments: rawAttachments,
    },
    env,
    ctx,
  );
  return ingestResultToResponse(result);
}
