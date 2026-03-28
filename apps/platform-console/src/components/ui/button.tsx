import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "./utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center font-black uppercase tracking-[0.1em] border-4 border-black transition-all duration-150 active:translate-x-[4px] active:translate-y-[4px] active:!shadow-none select-none disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap",
  {
    variants: {
      variant: {
        default:
          "bg-[#A3E635]/90 backdrop-blur-sm text-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:-translate-x-1 hover:-translate-y-1 hover:bg-[#A3E635] hover:shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] active:shadow-none",
        secondary:
          "bg-white/75 backdrop-blur-sm text-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:-translate-x-1 hover:-translate-y-1 hover:bg-white/90 hover:shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] active:shadow-none",
        destructive:
          "bg-red-500/90 backdrop-blur-sm text-white shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:-translate-x-1 hover:-translate-y-1 hover:bg-red-500 hover:shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] active:shadow-none",
        outline:
          "bg-transparent text-black shadow-[4px_4px_0px_0px_rgba(0,0,0,0)] hover:-translate-x-1 hover:-translate-y-1 hover:bg-white/75 hover:backdrop-blur-sm hover:shadow-[6px_6px_0px_0px_rgba(0,0,0,0.1)] active:shadow-none",
        ghost:
          "border-transparent text-black hover:-translate-x-1 hover:-translate-y-1 hover:border-black hover:bg-white/50 hover:backdrop-blur-sm hover:shadow-none active:shadow-none",
        dark: "bg-black/80 backdrop-blur-sm text-white shadow-[4px_4px_0px_0px_rgba(163,230,53,1)] hover:-translate-x-1 hover:-translate-y-1 hover:bg-black hover:shadow-[6px_6px_0px_0px_rgba(163,230,53,1)] active:shadow-none",
        link: "border-transparent shadow-none bg-transparent text-black hover:text-[#A3E635] active:translate-x-0 active:translate-y-0 active:opacity-60 select-text transition-colors",
      },
      size: {
        default: "px-6 py-3 text-sm",
        sm: "px-4 py-2 text-xs",
        lg: "px-8 py-4 text-base",
        icon: "h-12 w-12",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
