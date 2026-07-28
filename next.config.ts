import type { NextConfig } from "next";

// next.config.ts is evaluated by `next dev` (NODE_ENV=development) and
// `next build`/`next start` (NODE_ENV=production), so branching here yields a
// static header per build — there is no per-request nonce with this approach.
const isDev = process.env.NODE_ENV !== "production";

const contentSecurityPolicy = [
  "default-src 'self'",
  // 'unsafe-inline': app/layout.tsx injects the theme-bootstrap <script> inline
  // (before first paint, so it cannot be an external file without a flash), and
  // Next.js itself emits inline scripts for the Flight payload and hydration.
  // Their contents vary per page and per build, so hashes are impractical and a
  // static header cannot carry a nonce. 'unsafe-eval' is dev-only: Turbopack
  // and React Refresh evaluate modules with eval(); production bundles do not.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  // 'unsafe-inline': Next inlines critical CSS in <style> elements (including
  // the @font-face CSS that next/font generates), and SSR renders React
  // `style` props as style="" attributes. GSAP mutates element.style via the
  // CSSOM, which CSP never blocks, but the SSR'd attributes alone need this.
  "style-src 'self' 'unsafe-inline'",
  // blob:: received-file previews (components/room/files-panel.tsx renders
  // <img src={URL.createObjectURL(...)}>). data:: small inline images/SVGs.
  "img-src 'self' blob: data:",
  // blob:: received audio/video files played from object URLs. mediastream::
  // live camera/screen streams if ever attached by URL — the app attaches them
  // via srcObject, which CSP does not consult, so this is belt-and-braces.
  "media-src 'self' blob: mediastream:",
  // next/font self-hosts Geist under /_next/static/media; no external origin.
  "font-src 'self'",
  // The signalling route (SSE GET + POST) is same-origin. STUN/TURN is *not*
  // listed: CSP connect-src does not govern ICE traffic (WebRTC has its own
  // `webrtc` directive, which defaults to allow), so stun:/turn: entries here
  // would be dead weight. ws: is dev-only for the HMR websocket, which some
  // browsers do not treat as covered by 'self'.
  `connect-src 'self'${isDev ? " ws:" : ""}`,
  // Belt-and-braces with the X-Frame-Options: DENY header below.
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
].join("; ");

const nextConfig: NextConfig = {
  // The e2e scripts drive the app via 127.0.0.1, but the dev server only trusts
  // the `localhost` origin by default and drops its WebSocket with a raw
  // "Unauthorized". In dev, React's Flight payload resolves debug references
  // over that socket, so a refused socket silently blocks hydration entirely.
  allowedDevOrigins: ["127.0.0.1"],
  // The signalling route streams for the lifetime of a session; never cache it.
  async headers() {
    return [
      {
        source: "/api/signal/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, no-transform" },
          { key: "X-Accel-Buffering", value: "no" },
        ],
      },
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            // Room ids live in the URL, so keep them out of third-party hands.
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(self), display-capture=(self), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
