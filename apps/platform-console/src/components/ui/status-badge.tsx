import { Badge, BadgeProps } from "./badge";
import { cn } from "./utils";
import { CheckCircle2, AlertCircle, Clock, XCircle, Activity, AlertTriangle, XOctagon, Wrench, LucideIcon } from "lucide-react";

export type StatusType = "success" | "warning" | "error" | "info" | "pending" | "health" | "degraded" | "outage" | "maintenance";

interface StatusBadgeProps extends Omit<BadgeProps, "variant"> {
  status: StatusType;
  label?: string;
  showIcon?: boolean;
}

const statusConfig: Record<StatusType, { icon: LucideIcon; className: string }> = {
  health: {
    icon: Activity,
    className: "bg-emerald-500/15 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/25",
  },
  degraded: {
    icon: AlertTriangle,
    className: "bg-amber-500/15 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400 border-amber-500/20 hover:bg-amber-500/25",
  },
  outage: {
    icon: XOctagon,
    className: "bg-destructive/15 text-destructive border-destructive/20 hover:bg-destructive/25",
  },
  maintenance: {
    icon: Wrench,
    className: "bg-blue-500/15 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400 border-blue-500/20 hover:bg-blue-500/25",
  },
  success: {
    icon: CheckCircle2,
    className: "bg-emerald-500/15 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/25",
  },
  warning: {
    icon: AlertCircle,
    className: "bg-amber-500/15 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400 border-amber-500/20 hover:bg-amber-500/25",
  },
  error: {
    icon: XCircle,
    className: "bg-destructive/15 text-destructive border-destructive/20 hover:bg-destructive/25",
  },
  info: {
    icon: AlertCircle,
    className: "bg-blue-500/15 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400 border-blue-500/20 hover:bg-blue-500/25",
  },
  pending: {
    icon: Clock,
    className: "bg-muted text-muted-foreground border-border hover:bg-muted/80",
  },
};

export function StatusBadge({ status, label, showIcon = true, className, ...props }: StatusBadgeProps) {
  const config = statusConfig[status];
  const Icon = config.icon;
  
  return (
    <Badge 
      variant="outline" 
      className={cn("gap-1.5 font-medium px-2.5 py-0.5", config.className, className)} 
      {...props}
    >
      {showIcon && <Icon className="h-3.5 w-3.5 shrink-0" />}
      {label || status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  );
}
