import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ActionResult, BusyButton, TechDetails, useAction } from "@/components/shared";
import { gateway, type ApiResult } from "@/lib/api";
import { probeAdminCredential, useConsole } from "@/state/console";
import { toast } from "sonner";

export function CredentialsPage() {
  const { credentialVerified, setCredentialVerified, refresh } = useConsole();
  const [apiKey, setApiKey] = useState("");
  const [probeResult, setProbeResult] = useState<null | boolean>(null);

  const save = useAction(async (): Promise<ApiResult> => {
    const trimmed = apiKey.trim();
    const saved = await gateway.saveCredential(trimmed);
    if (!saved.ok) return saved;
    // R3: a saved key is not a verified key. Probe the platform through the
    // proxy immediately and only report success when the key actually works.
    const verdict = await probeAdminCredential();
    setProbeResult(verdict);
    setCredentialVerified(verdict);
    if (verdict === true) {
      toast.success("凭据已保存并通过验证");
      setApiKey("");
      await refresh();
      return saved;
    }
    if (verdict === false) {
      return {
        ...saved,
        ok: false,
        failure: "auth",
        message: "密钥已保存,但对平台验证失败(401)——通常是粘贴时带上了变量名、空格或换行,请只粘贴 sk_admin_ 开头的完整密钥并重新保存。"
      };
    }
    return {
      ...saved,
      ok: false,
      failure: "gateway_down",
      message: "密钥已保存,但暂时无法连接平台完成验证。请稍后在本页重试验证。"
    };
  });

  const looksWrong = apiKey.length > 0 && (!apiKey.trim().startsWith("sk_admin_") || /\s/.test(apiKey.trim()) || apiKey.includes("="));

  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-widest text-muted-foreground">设置 / 网关凭据</div>
      <h1 className="mb-1 text-2xl font-bold">网关凭据</h1>
      <p className="mb-5 text-muted-foreground">
        Operator API Key 保存进加密的网关存储并由服务端代理使用,保存后不再显示。审批、计费、审计工具都依赖它。
      </p>

      <Card className={credentialVerified === true ? "border-emerald-200" : credentialVerified === false ? "border-red-200" : undefined}>
        <CardHeader>
          <CardTitle className="text-base">
            当前状态:
            {credentialVerified === true && <span className="ml-2 text-emerald-600">已验证 ✓(平台连通)</span>}
            {credentialVerified === false && <span className="ml-2 text-red-600">无效 ✗(平台返回 401)</span>}
            {credentialVerified === null && <span className="ml-2 text-muted-foreground">未验证</span>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Label htmlFor="admin-key">Operator API Key</Label>
          <Input
            id="admin-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="只粘贴 sk_admin_ 开头的完整密钥"
            className="mt-1.5 max-w-xl font-mono"
          />
          {looksWrong && (
            <p className="mt-1.5 text-xs text-amber-700">
              提示:密钥应以 <code className="font-mono">sk_admin_</code> 开头,且不含空格、换行或 <code className="font-mono">=</code>。看起来当前内容可能带上了多余字符。
            </p>
          )}
          <p className="mt-1.5 text-xs text-muted-foreground">
            密钥来自部署环境变量 <code className="font-mono">PLATFORM_ADMIN_API_KEY</code>(部署目录 .env);保存时会自动向平台验证一次,通过后徽章才会变绿。
          </p>
          <div className="mt-3">
            <BusyButton busy={save.busy} disabled={!apiKey.trim()} onClick={() => void save.run()}>
              保存并验证
            </BusyButton>
          </div>
          <ActionResult result={save.result} okText="凭据已保存并通过平台验证,审批/计费/审计工具已可用。" />
          {probeResult === null && save.result?.ok === false && save.result.failure === "gateway_down" && (
            <TechDetails raw={save.result.raw} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
