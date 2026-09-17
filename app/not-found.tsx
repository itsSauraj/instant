import Link from "next/link";
import { SearchX } from "lucide-react";

import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-5 py-5 sm:px-8">
      <Brand />
      <div className="flex flex-1 items-center justify-center">
        <div className="panel max-w-md p-7 text-center">
          <span className="bg-muted mx-auto grid size-14 place-items-center rounded-full">
            <SearchX className="text-muted-foreground size-6" />
          </span>
          <h1 className="mt-5 text-lg font-semibold">That session code isn&apos;t valid</h1>
          <p className="text-muted-foreground mt-1.5 text-sm">
            Invite links look like <span className="font-mono">/room/k3f9-mq2t</span>, and a code
            of your own is 4 to 32 letters and numbers. Check the link you were sent, or start a
            session of your own.
          </p>
          <Button asChild className="mt-6 w-full">
            <Link href="/">Go to the home page</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
