import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "./utils";

const badgeVariants = cva(
  "inline-flex items-center justify-center px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.2em] border-2 border-black whitespace-nowrap shrink-0 transition-colors",
  {
    variants: {
      variant: {
        solid: "",
        outline: "bg-transparent text-black hover:bg-black hover:text-white",
        dark: "bg-black text-white",
      },
      tone: {
        neutral: "bg-[#F7F2E8] text-black",
        protocol: "bg-[#A3E635] text-black",
        client: "bg-[#3B82F6] text-white",
        caller: "bg-[#14B8A6] text-white",
        responder: "bg-[#F97316] text-white",
        platform: "bg-[#8B5CF6] text-white",
        selfhost: "bg-[#FACC15] text-black",
        destructive: "bg-[#EF4444] text-white",
      },
    },
    defaultVariants: {
      variant: "solid",
      tone: "neutral",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, tone, ...props }: BadgeProps) {
  const effectiveTone = variant === "outline" ? null : variant === "dark" ? null : tone;
  
  return (
    <div
      className={cn(badgeVariants({ variant, tone: effectiveTone, className }))}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
