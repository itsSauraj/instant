import { Globe } from "lucide-react";

import { Brand } from "@/components/brand";
import { HomeHero } from "@/components/home/home-hero";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";

function GithubIcon() {
  // lucide-react dropped brand icons, so the GitHub mark is inlined here.
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55 0-.27-.01-1.17-.02-2.12-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.24 2.76.12 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.7 5.39-5.26 5.68.41.35.77 1.05.77 2.12 0 1.53-.01 2.76-.01 3.14 0 .3.2.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

export default function HomePage() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-5 py-5 sm:px-8">
      <header className="flex items-center justify-between">
        <Brand />
        <ThemeToggle />
      </header>
      <HomeHero />
      <footer className="mt-10 border-t border-border/60 pt-5 pb-2">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-bold tracking-[0.2em] uppercase">Instant</p>
            <p className="text-muted-foreground text-xs tracking-widest uppercase">
              Engineered by{" "}
              <a
                href="https://saurabh-yadav.me"
                target="_blank"
                rel="noreferrer"
                className="text-foreground font-semibold hover:text-primary"
              >
                Saurabh Yadav
              </a>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" asChild>
              <a
                href="https://github.com/itsSauraj/instant"
                target="_blank"
                rel="noreferrer"
                aria-label="View source on GitHub"
              >
                <GithubIcon />
              </a>
            </Button>
            <Button variant="outline" size="icon" asChild>
              <a
                href="https://saurabh-yadav.me"
                target="_blank"
                rel="noreferrer"
                aria-label="Visit saurabh-yadav.me"
              >
                <Globe />
              </a>
            </Button>
          </div>
        </div>
        <p className="text-muted-foreground pt-4 text-center text-xs">
          Peer-to-peer. Nothing is stored on a server.
        </p>
      </footer>
    </div>
  );
}
