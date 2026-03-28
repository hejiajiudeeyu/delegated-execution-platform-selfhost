import * as React from "react";
import { cn } from "./utils";

const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { accentColor?: string; decorativeColor?: string }
>(({ className, accentColor, decorativeColor, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "border-4 border-black bg-white/75 backdrop-blur-sm shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] flex flex-col overflow-hidden",
      className
    )}
    {...props}
  >
    {decorativeColor && (
      <div className="flex h-14 border-b-4 border-black shrink-0">
        {decorativeColor.includes(",") ? (
          decorativeColor.split(",").map((col, i) => (
            <div
              key={i}
              className={cn("flex-1", i !== 0 && "border-l-4 border-black")}
              style={{ backgroundColor: col }}
            />
          ))
        ) : (
          <div className="w-full" style={{ backgroundColor: decorativeColor }} />
        )}
      </div>
    )}
    {!decorativeColor && accentColor && (
      <div
        className="h-2 border-b-4 border-black shrink-0"
        style={{ backgroundColor: accentColor }}
      />
    )}
    {props.children}
  </div>
));
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("p-5 flex flex-col space-y-3", className)} {...props} />
  )
);
CardHeader.displayName = "CardHeader";

const CardKicker = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p
      ref={ref}
      className={cn("text-xs font-black uppercase tracking-[0.3em] text-zinc-500", className)}
      {...props}
    />
  )
);
CardKicker.displayName = "CardKicker";

const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn("text-2xl sm:text-3xl font-black uppercase leading-tight", className)}
      {...props}
    />
  )
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn("text-sm font-bold leading-6 text-zinc-800", className)} {...props} />
  )
);
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("px-5 pb-5 flex-1", className)} {...props} />
  )
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("px-5 py-4 border-t-4 border-black flex items-center bg-white/75 backdrop-blur-sm", className)}
      {...props}
    />
  )
);
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardKicker, CardTitle, CardDescription, CardContent, CardFooter };
