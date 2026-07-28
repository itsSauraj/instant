import { Brand } from "@/components/brand";
import { HomeHero } from "@/components/home/home-hero";
import { ThemeToggle } from "@/components/theme-toggle";

export default function HomePage() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-5 py-5 sm:px-8">
      <header className="flex items-center justify-between">
        <Brand />
        <ThemeToggle />
      </header>
      <HomeHero />
      <footer className="text-muted-foreground pt-10 pb-2 text-center text-xs">
        Peer-to-peer over WebRTC · encrypted in transit by DTLS-SRTP · nothing stored server-side
      </footer>
    </div>
  );
}
