import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { Shield, LockKeyhole } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert } from "@/components/ui/alert"
import { useAuth } from "@/hooks/useAuth"

const BRAND_COLORS = ["#FACC15", "#8B5CF6", "#3B82F6", "#EC4899", "#A3E635", "#F97316", "#6366F1", "#EF4444", "#14B8A6"]

function BrandBackdrop() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 opacity-40">
        {BRAND_COLORS.map((color, index) => (
          <div key={`${color}-${index}`} style={{ backgroundColor: color }} />
        ))}
      </div>

      <div className="absolute inset-0 opacity-20">
        <svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern id="brand-grid" x="0" y="0" width="200" height="200" patternUnits="userSpaceOnUse">
              <rect width="200" height="200" fill="none" />
              <rect x="0" y="0" width="200" height="200" fill="none" stroke="#111111" strokeWidth="5" strokeLinecap="square" />
              <g stroke="#111111" strokeWidth="5" fill="none" strokeLinecap="square">
                <line x1="0" y1="0" x2="60" y2="60" />
                <line x1="200" y1="0" x2="140" y2="60" />
                <line x1="0" y1="200" x2="60" y2="140" />
                <line x1="200" y1="200" x2="140" y2="140" />
                <rect x="60" y="60" width="80" height="80" />
                <circle cx="100" cy="100" r="40" />
                <line x1="60" y1="60" x2="140" y2="140" />
                <line x1="140" y1="60" x2="60" y2="140" />
              </g>
              <g fill="#111111" fontFamily="'Inter', 'Helvetica Neue', Arial, sans-serif" fontWeight="900" letterSpacing="0.05em">
                <text x="12" y="38" fontSize="22" textAnchor="start">CALL</text>
                <text x="188" y="180" fontSize="22" textAnchor="end">ANYTHING</text>
              </g>
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#brand-grid)" />
        </svg>
      </div>

      <div className="absolute left-[10%] top-24 h-52 w-64 bg-black/11" />
      <div className="absolute bottom-32 right-[15%] h-60 w-72 bg-black/10 -rotate-6" />
      <div className="absolute top-[42%] right-[8%] h-56 w-56 rounded-full bg-black/12" />
      <div className="absolute bottom-[48%] left-[12%] h-48 w-48 rounded-full bg-black/10" />
      <div className="absolute left-20 top-20 h-64 w-64 rotate-12 bg-[#A3E635]/30" />
      <div className="absolute bottom-20 right-20 h-80 w-80 -rotate-12 bg-[#8B5CF6]/25" />
    </div>
  )
}

export function SetupPage() {
  const { setup } = useAuth()
  const navigate = useNavigate()
  const [passphrase, setPassphrase] = useState("")
  const [confirm, setConfirm] = useState("")
  const [bootstrapSecret, setBootstrapSecret] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (passphrase !== confirm) { setError("两次输入不一致"); return }
    if (passphrase.length < 6) { setError("口令至少 6 个字符"); return }
    setLoading(true)
    const result = await setup(passphrase, bootstrapSecret || undefined)
    setLoading(false)
    if (result.ok) navigate("/")
    else setError(result.error ?? "Setup 失败")
  }

  return (
    <div className="isolate relative flex h-screen items-center justify-center">
      <BrandBackdrop />
      <div className="relative z-10 w-full max-w-sm space-y-6 rounded-none border-4 border-black bg-white/80 backdrop-blur-sm p-8 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex h-12 w-12 items-center justify-center border-4 border-black bg-[#8B5CF6] shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
            <Shield className="h-5 w-5 text-white" />
          </div>
          <h1 className="text-lg font-bold">初始化 Platform Console</h1>
          <p className="text-sm text-muted-foreground">设置管理口令</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <Alert variant="destructive"><p className="text-sm">{error}</p></Alert>}
          <div className="space-y-1.5">
            <Label>口令</Label>
            <Input type="password" placeholder="至少 6 个字符" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label>确认口令</Label>
            <Input type="password" placeholder="再次输入" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Bootstrap Secret（可选）</Label>
            <Input type="password" placeholder="平台 bootstrap secret" value={bootstrapSecret} onChange={(e) => setBootstrapSecret(e.target.value)} />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "初始化中…" : "完成设置"}
          </Button>
        </form>
      </div>
    </div>
  )
}

export function UnlockPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [passphrase, setPassphrase] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    const result = await login(passphrase)
    setLoading(false)
    if (result.ok) navigate("/")
    else setError(result.error ?? "口令错误")
  }

  return (
    <div className="isolate relative flex h-screen items-center justify-center">
      <BrandBackdrop />
      <div className="relative z-10 w-full max-w-sm space-y-6 rounded-none border-4 border-black bg-white/80 backdrop-blur-sm p-8 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex h-12 w-12 items-center justify-center border-4 border-black bg-[#8B5CF6] shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
            <LockKeyhole className="h-5 w-5 text-white" />
          </div>
          <h1 className="text-lg font-bold">解锁 Platform Console</h1>
          <p className="text-sm text-muted-foreground">输入管理口令</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <Alert variant="destructive"><p className="text-sm">{error}</p></Alert>}
          <div className="space-y-1.5">
            <Label>口令</Label>
            <Input type="password" placeholder="输入口令" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoFocus />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "解锁中…" : "解锁"}
          </Button>
        </form>
      </div>
    </div>
  )
}
