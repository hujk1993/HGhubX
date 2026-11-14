import { useId, useState } from "react";
import { api, isMobile } from "../api";
import type { User } from "../types";
import { useStore } from "../store";
import { Modal, Sheet } from "./ui";
import { Button, Form, Input, SegmentedControl } from "./ios/controls";
import { Loader } from "./ios/effects";
import { IClose, ILogin } from "../icons";

export default function LoginModal() {
  const { loginOpen, setLoginOpen, setUser, toast } = useStore();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const errorId = useId();
  const title = mode === "login" ? "登录 HGhubX" : "注册 HGhubX";
  const submit = async () => {
    if (busy) return;
    if (!username.trim() || !password) { setErr("请输入账号与密码"); return; }
    setBusy(true); setErr("");
    try {
      const result = mode === "login" ? await api.login(username.trim(), password) : await api.register(username.trim(), password, email.trim());
      setUser(result.user as User); setPassword(""); setLoginOpen(false);
      toast(mode === "login" ? `欢迎回来，${result.user?.nickname || username}` : "注册成功", "ok");
    } catch (error) { setErr((error as Error).message || "操作失败"); }
    finally { setBusy(false); }
  };
  const content = <div className="ios-auth">
    <div className="ios-dialog-heading"><span className="ios-heading-icon"><ILogin size={21} /></span><h2>{title}</h2>
      <Button className="ios-icon-button" aria-label="关闭登录" onClick={() => setLoginOpen(false)}><IClose size={19} /></Button>
    </div>
    <p className="ios-description">登录后参与互动，收藏与观看记录也可在本地使用。</p>
    <SegmentedControl className="ios-auth-tabs" aria-label="账号操作" activeIndex={mode === "login" ? 0 : 1}>
      {([ ["login", "登录"], ["register", "注册"] ] as const).map(([key, label]) => <Button key={key}
        aria-pressed={mode === key} onClick={() => { setMode(key); setErr(""); }}>{label}</Button>)}
    </SegmentedControl>
    <Form className="ios-auth-form" aria-busy={busy} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label className="ios-field"><span>账号</span><Input aria-label="账号" data-autofocus autoComplete="username" name="username" placeholder="输入账号" value={username}
        onChange={event => setUsername(event.target.value)} aria-invalid={!!err} aria-describedby={err ? errorId : undefined} /></label>
      <label className="ios-field"><span>密码</span><Input aria-label="密码" autoComplete={mode === "login" ? "current-password" : "new-password"} name="password" type="password"
        placeholder="输入密码" value={password} onChange={event => setPassword(event.target.value)} aria-invalid={!!err} aria-describedby={err ? errorId : undefined} /></label>
      {mode === "register" && <label className="ios-field"><span>邮箱 <small>可选</small></span><Input aria-label="邮箱" type="email" autoComplete="email" name="email"
        placeholder="用于账号联系" value={email} onChange={event => setEmail(event.target.value)} /></label>}
      {err && <p id={errorId} role="alert" className="ios-field-error">{err}</p>}
      <Button variant="primary" className="ios-auth-submit" type="submit" disabled={busy}>
        {busy && <Loader className="size-5" />}{busy ? "处理中…" : mode === "login" ? "登录" : "创建账号"}
      </Button>
    </Form>
    <p className="ios-description ios-auth-note">登录状态与当前站点绑定；使用自定义镜像时，登录请求会发送到你填写的站点，跨站点切换需重新登录。</p>
  </div>;
  return isMobile ? <Sheet open={loginOpen} onClose={() => setLoginOpen(false)} label={title}>{content}</Sheet>
    : <Modal open={loginOpen} onClose={() => setLoginOpen(false)} label={title} width={440}>{content}</Modal>;
}
