import Link from "next/link";

import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="text-muted-foreground hover:text-foreground hover:bg-accent rounded-full px-3 py-1.5 text-sm font-medium transition-colors"
    >
      {children}
    </Link>
  );
}

/**
 * Floating island navbar for the marketing and legal pages. The room page
 * keeps its own header: session controls belong to the session, not the site.
 *
 * Fixed and centered with a gap on every side, so pages rendering it need
 * enough top padding to clear it (pt-24 works at every breakpoint).
 */
export function SiteNav() {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-40 px-4">
      <header className="pointer-events-auto mx-auto flex h-14 w-full max-w-3xl items-center rounded-full border bg-card/70 pr-2 pl-4 shadow-soft backdrop-blur-xl sm:pl-5">
        <Brand />
        <nav aria-label="Site" className="ml-auto flex items-center gap-1">
          <NavLink href="/privacy">Privacy</NavLink>
          <NavLink href="/terms">Terms</NavLink>
        </nav>
        <span aria-hidden className="bg-border mx-2 hidden h-5 w-px sm:block" />
        <ThemeToggle />
      </header>
    </div>
  );
}
