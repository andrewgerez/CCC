import * as T from "@radix-ui/react-tabs";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export const Tabs = T.Root;
export const TabsContent = ({ className, ...p }: ComponentProps<typeof T.Content>) => (
  <T.Content className={cn("min-h-0 flex-1 focus:outline-none data-[state=inactive]:hidden", className)} {...p} />
);
export const TabsList = ({ className, ...p }: ComponentProps<typeof T.List>) => (
  <T.List className={cn("flex items-center gap-0.5 overflow-x-auto border-b border-line px-2", className)} {...p} />
);
export const TabsTrigger = ({ className, ...p }: ComponentProps<typeof T.Trigger>) => (
  <T.Trigger
    className={cn(
      "relative flex h-9 shrink-0 items-center gap-1.5 px-2 text-xs font-medium text-muted transition-colors hover:text-fg-2",
      "after:absolute after:inset-x-1.5 after:-bottom-px after:h-[2px] after:rounded-full after:bg-transparent data-[state=active]:text-fg data-[state=active]:after:bg-cyan",
      className,
    )}
    {...p}
  />
);
