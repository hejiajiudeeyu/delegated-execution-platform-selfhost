import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card";
import { StatusBadge, StatusType } from "./status-badge";
import { cn } from "./utils";
import { LucideIcon, ArrowUpRight } from "lucide-react";

interface ServiceCardProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  description: string;
  icon: LucideIcon;
  status?: StatusType;
  statusLabel?: string;
  provider?: string;
  callsCount?: number | string;
  tags?: string[];
  footer?: React.ReactNode;
}

export function ServiceCard({
  title,
  description,
  icon: Icon,
  status = "success",
  statusLabel,
  provider,
  callsCount,
  tags = [],
  footer,
  className,
  ...props
}: ServiceCardProps) {
  return (
    <Card 
      className={cn(
        "group relative flex flex-col overflow-hidden transition-all duration-300 hover:-translate-y-1.5 hover:shadow-xl hover:border-foreground/50 active:scale-[0.98] active:duration-150 cursor-pointer bg-card hover:bg-muted/20", 
        className
      )} 
      {...props}
    >
      <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-all -translate-x-2 translate-y-2 group-hover:translate-x-0 group-hover:translate-y-0 duration-300 z-20">
        <ArrowUpRight className="w-5 h-5 text-foreground drop-shadow-sm" />
      </div>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-4 relative z-10">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-secondary rounded-xl text-secondary-foreground group-hover:bg-primary group-hover:text-primary-foreground shadow-sm transition-colors">
            <Icon className="w-5 h-5" />
          </div>
          <div className="pr-4">
            <CardTitle className="text-base font-bold tracking-tight">{title}</CardTitle>
            {provider && <div className="text-xs text-muted-foreground font-medium mt-0.5">{provider}</div>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 pb-4 relative z-10 flex flex-col">
        <CardDescription className="line-clamp-2 text-sm leading-relaxed mb-4 text-muted-foreground group-hover:text-foreground/80 transition-colors">
          {description}
        </CardDescription>
        
        <div className="mt-auto flex flex-col gap-3">
          <div className="flex items-center justify-between text-xs font-semibold">
            {callsCount ? (
              <div className="flex items-center gap-1.5 tracking-tight">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)] animate-pulse" />
                <span className="font-mono">{callsCount.toLocaleString()}</span> 次调用
              </div>
            ) : <div />}
            <StatusBadge status={status} label={statusLabel} />
          </div>
          
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <span key={tag} className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold tracking-wide uppercase bg-secondary text-secondary-foreground border border-transparent group-hover:border-border transition-colors">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </CardContent>
      {footer && (
        <CardFooter className="pt-0 pb-4 relative z-10 mt-auto">
          <div className="w-full pt-4 border-t border-border/50 group-hover:border-border transition-colors">{footer}</div>
        </CardFooter>
      )}
      <div className="absolute inset-x-0 bottom-0 h-1 bg-gradient-to-r from-transparent via-primary/20 to-transparent translate-y-full group-hover:translate-y-0 transition-transform duration-300" />
    </Card>
  );
}
