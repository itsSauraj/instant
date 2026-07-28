import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
