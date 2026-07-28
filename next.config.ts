import type { NextConfig } from "next";

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
