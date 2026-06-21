// supabase/functions/send-push/index.ts
//
// Mdelo Viewer — Push Notification Sender (Scope 2)
//
// Receives POST { map_id, title, body, url } from either:
//   - the DB trigger (Scope 1, via pg_net.http_post) on markers/dialog changes
//   - the terminal chat hook (Scope 5, client-side fetch on chat send)
//
// Reads all push_subscriptions rows for that map_id, sends a signed
// (VAPID) web-push payload to each, and prunes subscriptions that the
// push service reports as gone (404/410).
//
// NOT in scope here: SQL migration (Scope 1), client subscribe logic
// (Scope 4), service worker push listener (Scope 3).

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3";

// ---------------------------------------------------------------------------
// Env / secrets (set via `supabase secrets set`)
// ---------------------------------------------------------------------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@mdelo.app";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// Service-role client: needed to delete dead subscriptions (RLS would
// otherwise block deletes from an anon-authenticated caller).
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------------
// CORS — viewer runs on GitHub Pages, separate origin from Supabase.
// ---------------------------------------------------------------------------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Auth — caller must present the Supabase anon key (standard pattern for
// Edge Functions; this is not a secret, it just filters fully anonymous
// bots hitting the endpoint directly). Accepts either apikey header or
// Authorization: Bearer <anon_key>.
// ---------------------------------------------------------------------------
function isAuthorized(req: Request): boolean {
  const apikey = req.headers.get("apikey");
  const authHeader = req.headers.get("Authorization");
  const bearer = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;

  return apikey === SUPABASE_ANON_KEY || bearer === SUPABASE_ANON_KEY;
}

// ---------------------------------------------------------------------------
// Request body shape
// ---------------------------------------------------------------------------
interface SendPushBody {
  map_id: string;
  title: string;
  body: string;
  url?: string;
}

interface PushSubscriptionRow {
  id: number;
  map_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

function isValidBody(x: unknown): x is SendPushBody {
  if (typeof x !== "object" || x === null) return false;
  const b = x as Record<string, unknown>;
  return (
    typeof b.map_id === "string" &&
    b.map_id.length > 0 &&
    typeof b.title === "string" &&
    typeof b.body === "string" &&
    (b.url === undefined || typeof b.url === "string")
  );
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (!isAuthorized(req)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!isValidBody(payload)) {
    return jsonResponse(
      { error: "Expected { map_id: string, title: string, body: string, url?: string }" },
      400,
    );
  }

  const { map_id, title, body, url } = payload;

  // Fetch all subscriptions for this map_id.
  const { data: subs, error: fetchError } = await supabaseAdmin
    .from("push_subscriptions")
    .select("id, map_id, endpoint, p256dh, auth")
    .eq("map_id", map_id);

  if (fetchError) {
    console.error("Failed to fetch push_subscriptions:", fetchError.message);
    return jsonResponse({ error: "Database error fetching subscriptions" }, 500);
  }

  const subscriptions = (subs ?? []) as PushSubscriptionRow[];

  if (subscriptions.length === 0) {
    return jsonResponse({ sent: 0, failed: 0, removed: 0, message: "No subscribers for this map_id" });
  }

  const notificationPayload = JSON.stringify({
    title,
    body,
    url: url ?? "/",
  });

  let sent = 0;
  let failed = 0;
  const deadIds: number[] = [];

  await Promise.all(
    subscriptions.map(async (sub) => {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.p256dh,
          auth: sub.auth,
        },
      };

      try {
        await webpush.sendNotification(pushSubscription, notificationPayload);
        sent++;
      } catch (err) {
        failed++;
        const statusCode = (err as { statusCode?: number })?.statusCode;
        // 404 = subscription gone, 410 = subscription expired/unsubscribed.
        if (statusCode === 404 || statusCode === 410) {
          deadIds.push(sub.id);
        } else {
          console.error(`Push failed for subscription ${sub.id}:`, err);
        }
      }
    }),
  );

  let removed = 0;
  if (deadIds.length > 0) {
    const { error: deleteError, count } = await supabaseAdmin
      .from("push_subscriptions")
      .delete({ count: "exact" })
      .in("id", deadIds);

    if (deleteError) {
      console.error("Failed to prune dead subscriptions:", deleteError.message);
    } else {
      removed = count ?? deadIds.length;
    }
  }

  return jsonResponse({ sent, failed, removed });
});
