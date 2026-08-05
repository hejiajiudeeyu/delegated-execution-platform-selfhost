// The terminology layer.
//
// The v0.2.0 diagnosis found that four status fields sat side by side with
// nothing explaining how they relate, and that screens asked the operator to
// type internal primary keys they had no way to know. Both are the same
// problem: internal vocabulary leaking into the interface unexplained.
//
// So every internal term the console shows gets one plain sentence here, and
// the components read from this file rather than inventing their own wording.
// One place to fix a confusing label, and no way for two screens to explain
// the same field differently.
import type { ReactNode } from "react";
import { HelpCircle } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** The four axes are independent lines, not one status. Explaining that
 * relationship is the point — drawing them as four separate rows is what makes
 * the explanation unnecessary. */
export const AXIS_LABEL: Record<string, { title: string; plain: string }> = {
  execution: {
    title: "执行",
    plain: "责任方那边这件事做到哪一步了。"
  },
  delivery_integrity: {
    title: "交付校验",
    plain: "交回来的东西是否与承诺的一致（checksum 是否对得上）。"
  },
  acceptance: {
    title: "验收",
    plain: "调用方是否接受了这次交付，或者要求了修订。"
  },
  settlement: {
    title: "资金",
    plain: "这笔钱现在在哪：冻结、已结算、已退款，还是根本没有计费。"
  }
};

export const EXECUTION_VALUE: Record<string, string> = {
  submitted: "已提交，等待责任方接单",
  accepted: "已接单，尚未开始",
  queued: "已排队",
  executing: "执行中",
  delivered: "已交付",
  rejected: "责任方拒绝了这次调用",
  failed: "执行失败",
  timed_out: "超时",
  canceled: "已取消"
};

export const SETTLEMENT_VALUE: Record<string, string> = {
  none: "没有计费",
  held: "已冻结（尚未扣款）",
  settled: "已结算",
  refunded: "已退款",
  blocked: "因争议冻结"
};

export const ATTENTION_KIND: Record<string, { title: string; plain: string }> = {
  hotline_review_pending: {
    title: "热线待审核",
    plain: "有人提交了新热线，等你决定是否批准。"
  },
  responder_review_pending: {
    title: "设备待审核",
    plain: "有设备申请加入这个信任域，等你决定是否批准。"
  },
  call_stuck: {
    title: "调用卡住了",
    plain: "超过宽限期仍没有任何终态事件——多半是设备中途没了。"
  },
  funds_held_after_end: {
    title: "钱没退回来",
    plain: "调用已经结束，但资金还冻结着。不处理就一直占着额度。"
  },
  device_unavailable: {
    title: "设备不可用",
    plain: "离线、降级或维护中，暂时接不了活。"
  }
};

export const ARTIFACT_ROLE: Record<string, string> = {
  input: "输入",
  output: "输出",
  evidence: "证据"
};

export const ARTIFACT_LIFECYCLE: Record<string, { label: string; plain: string }> = {
  allocated: { label: "已分配", plain: "槽位开好了，字节还没传完——这种状态取不到内容。" },
  committed: { label: "已提交", plain: "字节已写入且 checksum 已核对，内容可以取。" },
  expired: { label: "已过期", plain: "超过保留期。" },
  deleted: { label: "已删除", plain: "字节已清除，只留下描述符。" }
};

export const EVENT_LABEL: Record<string, string> = {
  TASK_TOKEN_ISSUED: "调用已创建",
  DELIVERY_META_ISSUED: "投递信息已下发",
  ACKED: "设备已接单",
  ARTIFACT_ALLOCATED: "开出文件槽位",
  ARTIFACT_COMMITTED: "文件已写入并校验",
  PROGRESS: "执行进度",
  SOFT_TIMEOUT: "超过软超时，仍在运行",
  COMPLETED: "执行完成",
  FAILED: "执行失败",
  TIMED_OUT: "超时",
  RECONCILED: "重启后对账收口",
  BILLING_HELD: "资金已冻结",
  BILLING_SETTLED: "资金已结算",
  BILLING_REFUNDED: "资金已退款"
};

// Stages a device reports while a call runs (contracts
// REQUEST_PROGRESS_STAGE). Shown inside a PROGRESS timeline row.
export const PROGRESS_STAGE_LABEL: Record<string, string> = {
  input_fetching: "正在取回输入文件",
  executing: "正在执行",
  output_uploading: "正在上传结果文件"
};

export const ACTOR_LABEL: Record<string, string> = {
  responder: "设备",
  caller: "调用方",
  platform: "平台",
  // The platform stamps checksum verification as `system`, which read as a
  // shouty raw enum on screen.
  system: "平台自动"
};

export function describeEvent(eventType: string): string {
  return EVENT_LABEL[eventType] || eventType;
}

/** A term with its plain-language explanation one hover away. Used wherever an
 * internal field name has to appear on screen at all. */
export function Term({ children, plain }: { children: ReactNode; plain: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-help items-center gap-1 border-b border-dotted border-muted-foreground/40">
          {children}
          <HelpCircle className="h-3 w-3 text-muted-foreground/70" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs leading-relaxed">{plain}</TooltipContent>
    </Tooltip>
  );
}
