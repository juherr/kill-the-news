import { Context } from "hono";
import { Env } from "../types";
import {
  ForwardEmailPayload,
  handleForwardEmail,
} from "../infrastructure/forwardemail";

export async function handle(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const payload: ForwardEmailPayload = await c.req.json();

    console.log("Received email:", {
      to: payload.recipients?.[0],
      from: payload.from?.text || "Unknown",
      subject: payload.subject,
      contentType: payload.html ? "HTML" : "Text",
    });

    let ctx: Pick<ExecutionContext, "waitUntil"> | undefined;
    try {
      ctx = c.executionCtx;
    } catch {
      // No ExecutionContext in this environment (e.g. tests); WebSub notifications will be skipped
    }
    return handleForwardEmail(payload, c.env, ctx);
  } catch (error) {
    console.error("Error processing email:", error);
    return new Response("Error processing email", { status: 500 });
  }
}
