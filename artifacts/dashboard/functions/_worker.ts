/// <reference types="@cloudflare/workers-types" />

interface Env {
  ASSETS: Fetcher;
  GOOGLE_CLIENT_ID?: string;
}

/** Render backend — all /api/* requests go here */
const BACKEND = "https://mr-recovery-api-502z.onrender.com";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type,Authorization,x-master-pin,x-master-session,x-api-key,x-session-token,x-silent",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ── CORS preflight ────────────────────────────────────────────────────
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── /api/auth/config — served directly from CF (not proxied to Render) ──
    if (url.pathname === "/api/auth/config" && request.method === "GET") {
      const clientId = env.GOOGLE_CLIENT_ID ?? "461863915234-r9tvbtn7kr2pm9hpebmj301nrv6bg03h.apps.googleusercontent.com";
      return new Response(
        JSON.stringify({ googleClientId: clientId }),
        { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
      );
    }

    // ── Proxy /api/* → Render backend ─────────────────────────────────────
    if (url.pathname.startsWith("/api/")) {
      const backendUrl = BACKEND + url.pathname + url.search;

      const proxyReq = new Request(backendUrl, {
        method: request.method,
        headers: request.headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
        redirect: "follow",
      });

      try {
        const resp = await fetch(proxyReq);
        const headers = new Headers(resp.headers);
        // Ensure CORS headers on every API response
        for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
        return new Response(resp.body, {
          status: resp.status,
          statusText: resp.statusText,
          headers,
        });
      } catch {
        return new Response(JSON.stringify({ error: "Backend unreachable" }), {
          status: 502,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
      }
    }

    // ── Static assets from Cloudflare Pages ───────────────────────────────
    const resp = await env.ASSETS.fetch(request);

    // SPA fallback: non-asset 404 → serve index.html
    if (resp.status === 404) {
      const isAsset = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map|json|webp|txt|xml)$/i.test(
        url.pathname,
      );
      if (!isAsset) {
        return env.ASSETS.fetch(
          new Request(new URL("/index.html", request.url).toString(), {
            headers: request.headers,
          }),
        );
      }
    }

    return resp;
  },
};
