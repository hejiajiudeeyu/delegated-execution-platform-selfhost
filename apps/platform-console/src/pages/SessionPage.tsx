import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";
import { ActionResult, BusyButton, useAction } from "@/components/shared";
import { gateway } from "@/lib/api";
import { PHASE_LABEL, useConsole } from "@/state/console";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

const RECOVERY_CONFIRMATION_PHRASE = "RESET";

function StateStrip() {
  const { phase } = useConsole();
  const text =
    phase === "unreachable"
      ? "网关没有应答——请确认 platform-console-gateway 正在运行,然后点右上角“刷新状态”。"
      : phase === "setup"
        ? "网关尚未初始化——用部署密钥创建第一个控制台口令。"
        : phase === "locked"
          ? "网关已锁定——输入控制台口令解锁;没有口令?下方向导可安全重置。"
          : "已解锁——审批、计费与审计工具可用。";
  const tone =
    phase === "unlocked" ? "bg-emerald-50 text-emerald-700" : phase === "unreachable" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-800";
  return <div className={cn("mb-5 rounded-xl px-4 py-3 text-sm font-medium", tone)}>{`${PHASE_LABEL[phase]}:${text}`}</div>;
}

function Steps({ current }: { current: 0 | 1 | 2 }) {
  const labels = ["粘贴部署密钥", "设置新口令", "输入确认词"];
  return (
    <div className="mb-5 flex">
      {labels.map((label, i) => (
        <div key={label} className="relative flex-1 pt-7 text-center text-xs">
          {i < labels.length - 1 && <span className="absolute left-1/2 top-2.5 h-0.5 w-full bg-border" />}
          <span
            className={cn(
              "absolute left-1/2 top-0 z-10 flex h-5 w-5 -translate-x-1/2 items-center justify-center rounded-full text-[11px] font-bold text-white",
              i < current ? "bg-emerald-500" : i === current ? "bg-primary" : "bg-border"
            )}
          >
            {i < current ? "✓" : i + 1}
          </span>
          <span className={cn(i === current ? "font-semibold text-foreground" : "text-muted-foreground")}>{label}</span>
        </div>
      ))}
    </div>
  );
}

function RecoveryWizard({ mode }: { mode: "setup" | "recover" }) {
  const { markUnlocked } = useConsole();
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [secret, setSecret] = useState("");
  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [confirmWord, setConfirmWord] = useState("");
  const action = useAction(async () => {
    const r = mode === "setup" ? await gateway.setup(secret.trim(), pass1) : await gateway.recover(secret.trim(), pass1);
    if (r.ok) {
      toast.success(mode === "setup" ? "初始化完成,已解锁" : "重置完成,已用新口令解锁");
      await markUnlocked(r.body?.token);
    }
    return r;
  });

  const passMismatch = pass2.length > 0 && pass1 !== pass2;
  const passTooShort = pass1.length > 0 && pass1.length < 8;
  const step1Ok = secret.trim().length > 0;
  const step2Ok = pass1.length >= 8 && pass1 === pass2;
  const confirmOk = confirmWord === RECOVERY_CONFIRMATION_PHRASE;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{mode === "setup" ? "初始化控制台(三步)" : "丢失口令?通过部署密钥重置(三步)"}</CardTitle>
        {mode === "recover" && (
          <p className="text-sm text-muted-foreground">
            重置会<b>清空旧的加密存储</b>(含已保存的管理密钥),完成后需重新配置网关凭据。
          </p>
        )}
      </CardHeader>
      <CardContent>
        <Steps current={step} />

        {step === 0 && (
          <div className="space-y-3">
            <div>
              <Label htmlFor="rw-secret">部署密钥(bootstrap secret)</Label>
              <Input
                id="rw-secret"
                type="password"
                autoComplete="off"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="粘贴部署环境变量 PLATFORM_CONSOLE_BOOTSTRAP_SECRET 的值"
                className="mt-1.5"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                由部署这套系统的人持有,来自网关运行环境(部署目录 <code className="font-mono">.env</code>)。
              </p>
            </div>
            <Button disabled={!step1Ok} onClick={() => setStep(1)}>
              继续 → 第 2 步
            </Button>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            <div>
              <Label htmlFor="rw-p1">新口令(至少 8 位)</Label>
              <Input id="rw-p1" type="password" autoComplete="new-password" value={pass1} onChange={(e) => setPass1(e.target.value)} className="mt-1.5" />
              {passTooShort && <p className="mt-1 text-xs text-red-600">还差 {8 - pass1.length} 位。</p>}
            </div>
            <div>
              <Label htmlFor="rw-p2">再输入一次</Label>
              <Input
                id="rw-p2"
                type="password"
                autoComplete="new-password"
                value={pass2}
                onChange={(e) => setPass2(e.target.value)}
                className={cn("mt-1.5", passMismatch && "border-red-400 bg-red-50/50")}
              />
              {passMismatch && <p className="mt-1 text-xs text-red-600">两次输入不一致,请检查后重试。</p>}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep(0)}>上一步</Button>
              <Button disabled={!step2Ok} onClick={() => setStep(2)}>继续 → 第 3 步</Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              {mode === "recover"
                ? "确认执行破坏性重置:旧存储将被清空,当前所有控制台会话将退出。"
                : "确认初始化:将创建加密存储并以新口令解锁。"}
            </div>
            <div>
              <Label htmlFor="rw-confirm">在下方空白框中输入大写 {RECOVERY_CONFIRMATION_PHRASE} 以确认</Label>
              <Input
                id="rw-confirm"
                autoComplete="off"
                value={confirmWord}
                onChange={(e) => setConfirmWord(e.target.value)}
                placeholder="在此输入确认词"
                className={cn("mt-1.5 font-mono", confirmWord && !confirmOk && "border-red-400 bg-red-50/50")}
              />
              {confirmWord.length > 0 && !confirmOk && <p className="mt-1 text-xs text-red-600">需要输入大写 {RECOVERY_CONFIRMATION_PHRASE}。</p>}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep(1)}>上一步</Button>
              <BusyButton busy={action.busy} disabled={!confirmOk} onClick={() => void action.run()}>
                {mode === "setup" ? "初始化并解锁" : "重置存储并设置新口令"}
              </BusyButton>
            </div>
            <ActionResult result={action.result} okText={mode === "setup" ? "初始化完成,已解锁。" : "重置完成,已解锁——下一步请到“网关凭据”重新保存管理密钥。"} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function UnlockCard() {
  const { markUnlocked } = useConsole();
  const [passphrase, setPassphrase] = useState("");
  const action = useAction(async () => {
    const r = await gateway.login(passphrase);
    if (r.ok) {
      toast.success("已解锁");
      await markUnlocked(r.body?.token);
    }
    return r;
  });
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">用口令解锁</CardTitle></CardHeader>
      <CardContent>
        <Label htmlFor="unlock-pass">控制台口令</Label>
        <Input
          id="unlock-pass"
          type="password"
          autoComplete="current-password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && passphrase) void action.run(); }}
          placeholder="输入口令后回车即解锁"
          className="mt-1.5 max-w-md"
        />
        <p className="mt-1.5 text-xs text-muted-foreground">口令由上一位操作员设置,通常记录在部署交接档案(服务器 CONSOLE-PASSPHRASE.txt)。</p>
        <div className="mt-3">
          <BusyButton busy={action.busy} disabled={!passphrase} onClick={() => void action.run()}>解锁</BusyButton>
        </div>
        <ActionResult result={action.result} okText="已解锁。" />
      </CardContent>
    </Card>
  );
}

function UnlockedCards() {
  const { session, logout, refresh } = useConsole();
  const navigate = useNavigate();
  const [nextPass, setNextPass] = useState("");
  const rotate = useAction(async () => {
    const r = await gateway.changePassphrase(nextPass);
    if (r.ok) {
      toast.success("口令已更换,请重新登录");
      await refresh();
    }
    return r;
  });
  const adminConfigured = Boolean(session?.admin_api_key_configured);
  return (
    <div className="space-y-5">
      <Card className={adminConfigured ? "border-emerald-200" : "border-amber-200"}>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
          <div>
            <b>{adminConfigured ? "管理凭据已保存" : "下一步:保存管理凭据"}</b>
            <p className="text-sm text-muted-foreground">
              {adminConfigured
                ? "Operator API Key 已在加密存储中;审批、目录与计费工具可用。"
                : "网关已解锁,但还没有保存 Operator API Key——审批、计费、审计工具在保存并验证之前不可用。"}
            </p>
          </div>
          <Button variant={adminConfigured ? "outline" : "default"} onClick={() => navigate("/credentials")}>
            {adminConfigured ? "查看网关凭据" : "去配置凭据 →"}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">会话维护</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex max-w-md flex-col gap-2">
            <Label htmlFor="rotate-pass">更换口令(至少 8 位)</Label>
            <div className="flex gap-2">
              <Input id="rotate-pass" type="password" autoComplete="new-password" value={nextPass} onChange={(e) => setNextPass(e.target.value)} />
              <BusyButton variant="outline" busy={rotate.busy} disabled={nextPass.length < 8} onClick={() => void rotate.run()}>更换</BusyButton>
            </div>
          </div>
          <ActionResult result={rotate.result} okText="口令已更换。所有会话已退出,请用新口令重新解锁。" />
          <Button variant="outline" onClick={() => void logout()}>退出登录</Button>
        </CardContent>
      </Card>
    </div>
  );
}

export function SessionPage() {
  const { phase } = useConsole();
  const [showRecovery, setShowRecovery] = useState(false);
  const body = useMemo(() => {
    if (phase === "unreachable") {
      return (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            网关不可达时无法操作会话。请检查服务状态后点右上角"刷新状态"。
          </CardContent>
        </Card>
      );
    }
    if (phase === "setup") return <RecoveryWizard mode="setup" />;
    if (phase === "unlocked") return <UnlockedCards />;
    return (
      <div className="space-y-5">
        <UnlockCard />
        {showRecovery ? (
          <RecoveryWizard mode="recover" />
        ) : (
          <button type="button" className="text-sm text-primary underline underline-offset-4" onClick={() => setShowRecovery(true)}>
            丢失口令?通过部署密钥重置 →
          </button>
        )}
      </div>
    );
  }, [phase, showRecovery]);

  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-widest text-muted-foreground">设置 / 会话与解锁</div>
      <h1 className="mb-1 text-2xl font-bold">会话与解锁</h1>
      <p className="mb-5 text-muted-foreground">解锁后才能使用审批、计费与审计工具。锁定不影响公开市场页面。</p>
      <StateStrip />
      {body}
    </div>
  );
}
