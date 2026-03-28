import { Card, CardContent, CardHeader, CardTitle } from "./card";
import { cn } from "./utils";
import { LucideIcon } from "lucide-react";

interface StatsCardProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  value: string | number;
  icon?: LucideIcon;
  description?: string;
  trend?: {
    value: number;
    label: string;
    direction: "up" | "down" | "neutral";
  };
}

export function StatsCard({
  title,
  value,
  icon: Icon,
  description,
  trend,
  className,
  ...props
}: StatsCardProps) {
  return (
    <Card className={cn("overflow-hidden", className)} {...props}>
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        {Icon && <Icon className="w-4 h-4 text-muted-foreground" />}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold font-display">{value}</div>
        {(description || trend) && (
          <p className="mt-1 text-xs text-muted-foreground flex items-center gap-1.5">
            {trend && (
              <span 
                className={cn(
                  "font-medium flex items-center",
                  trend.direction === "up" ? "text-emerald-500" : 
                  trend.direction === "down" ? "text-destructive" : "text-muted-foreground"
                )}
              >
                {trend.direction === "up" ? "↑" : trend.direction === "down" ? "↓" : "→"}
                {Math.abs(trend.value)}%
              </span>
            )}
            {trend && description && <span className="text-border px-0.5">•</span>}
            {description}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
