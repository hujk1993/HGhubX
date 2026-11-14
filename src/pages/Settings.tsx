import { Button, SegmentedControl, Surface, TextArea } from "../components/ios/controls";
import { useEffect, useState, type ReactNode } from "react";
import { api, APP_VERSION, hostOf, logLine, platform, type UpdateInfo } from "../api";
import { useStore } from "../store";
import { Modal, Toggle } from "../components/ui";
import LinePicker from "../components/LinePicker";
import ProxySettings from "../components/ProxySettings";
import { autoLineEnabled, setAutoLine } from "../autoLine";
import { copyPlaybackLog, initPlaybackLog, setPlaybackLog, tracePlayback, usePlaybackLog } from "../playbackDiagnostics";
import { formatNetDiag, shortVerdict } from "../netDiagReport";
import { copyText } from "../clipboard";
import { IBack, IBoltF, IBroom, IChevR, IHeart, IInfo, ILink, ILockF, IMoon, IRefresh, ISun, IVolMute } from "../icons";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <>
    <div className="ios-section-label">{title}</div>
    <Surface className="ios-setting-group">{children}</Surface>
  </>;
}

/* 独立设置页：线路 / 外观 / 播放 / 本地数据 / 清理缓存 / 网络诊断 / 关于
   入口：Windows 侧栏「设置」、Android「我的」右上角齿轮 */
export default function Settings({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { theme, themePreference, setTheme, favs, history, muteOnStartup, setMuteOnStartup, preferHevc, setPreferHevc, strictSecurity, strictSecurityReady, securityPending, cliRelaxed, setStrictSecurity, toast } = useStore();
  const [about, setAbout] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [lineOpen, setLineOpen] = useState(false);
  const [lineBase, setLineBase] = useState("");
  const [autoLineOn, setAutoLineOn] = useState(autoLineEnabled);
  const [clearing, setClearing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  /** 应用内更新进行到哪一步（空串=没在更新） */
  const [updating, setUpdating] = useState("");
  const playbackLog = usePlaybackLog();
  const [copyingLog, setCopyingLog] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagReport, setDiagReport] = useState<string | null>(null);
  const [copyingReport, setCopyingReport] = useState(false);

  useEffect(() => { void initPlaybackLog(); }, []);

  const readLine = () => { api.lineState().then((state) => setLineBase(state.base)).catch(() => {}); };
  useEffect(() => {
    const sync = () => { readLine(); setAutoLineOn(autoLineEnabled()); };
    sync();
    window.addEventListener("hg:line-changed", sync);
    window.addEventListener("hg:auto-line-changed", sync);
    return () => {
      window.removeEventListener("hg:line-changed", sync);
      window.removeEventListener("hg:auto-line-changed", sync);
    };
  }, []);

  const checkUpdate = async () => {
    setChecking(true);
    try {
      const info = await api.checkUpdate();
      if (info.has_update) setUpdate(info);
      else toast(`已是最新版本 v${info.current}`, "ok");
    } catch (e) {
      toast((e as Error).message || "检查更新失败", "info");
    } finally {
      setChecking(false);
    }
  };
  /** 更新：用系统浏览器打开下载页，由系统/浏览器完成下载与安装。
   *
   * 不再自己下载 APK 并调安装器 —— 那条路在安卓上要额外过 FileProvider
   * 与「安装未知应用」授权，失败点多，体验并不比浏览器好。
   */
  const doUpdate = async () => {
    if (!update) return;
    setUpdating("打开中…");
    try {
      await api.openUrl(update.url);
    } catch (e) {
      await copyText(update.url)
        .then(() => toast("下载地址已复制，可在浏览器粘贴打开", "ok"))
        .catch(() => toast((e as Error).message || "打开失败", "info"));
    } finally {
      setUpdating("");
    }
  };

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 pt-3 pb-4" style={{ paddingTop: "calc(var(--sat, 0px) + 12px)" }}>
        <Button onClick={onBack} aria-label="返回" className="ios-icon-button mb-3"><IBack size={20} /></Button>
        <h1 className="ios-page-title text-on">设置</h1>
        <p className="text-[13px] text-mut mt-2">让 HGhubX 更合你的习惯</p>
      </div>

      <div className="ios-page-body flex-1 scroll-y px-4 pt-1 pb-10">
        <div className={wide ? "max-w-[720px] mx-auto" : ""}>
          <Section title="外观">
            <div className="ios-appearance-row items-center">
              <span className="ios-setting-icon">{themePreference === "system" ? <IRefresh size={16} /> : theme === "dark" ? <IMoon size={16} /> : <ISun size={16} />}</span>
              <div className="flex-1">
                <div className="text-[14px] text-on">外观</div>
                <div className="text-[12px] text-mut">{themePreference === "system" ? `跟随系统（当前${theme === "dark" ? "深色" : "浅色"}）` : theme === "dark" ? "深色外观" : "浅色外观"}</div>
              </div>
              <SegmentedControl className="ios-appearance-picker" aria-label="外观模式" activeIndex={(["system", "light", "dark"] as const).indexOf(themePreference)}>
                {([['system', '跟随'], ['light', '浅色'], ['dark', '深色']] as const).map(([value, label]) => (
                  <Button key={value} type="button" aria-pressed={themePreference === value}
                    onClick={() => setTheme(value)}>
                    {label}
                  </Button>
                ))}
              </SegmentedControl>
            </div>
          </Section>

          <Section title="播放">
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="ios-setting-icon"><IVolMute size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">启动时静音</div>
                <div className="text-[12px] text-mut">默认开启，每次启动均静音；关闭后记住上次静音状态。下次启动生效。</div>
              </div>
              <Toggle on={muteOnStartup} onChange={setMuteOnStartup} label="启动时静音" />
            </div>
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="ios-setting-icon"><IBoltF size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">优先高清</div>
                <div className="text-[12px] text-mut">有高清就用 HEVC，播不了会自动切回标准</div>
              </div>
              <Toggle on={preferHevc} onChange={setPreferHevc} label="优先高清" />
            </div>
          </Section>

          <Section title="本地数据">
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="ios-setting-icon"><IHeart size={16} /></span>
              <div className="flex-1">
                <div className="text-[14px] text-on">本地片库</div>
                <div className="text-[12px] text-mut">{favs.length} 部收藏 · {history.length} 条观看记录</div>
              </div>
            </div>
            <Button onClick={() => setClearOpen(true)} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable">
              <span className="ios-setting-icon"><IBroom size={16} /></span>
              <div className="flex-1">
                <div className="text-[14px] text-on">清理缓存</div>
                <div className="text-[12px] text-mut">封面 / 播放缓存与本地记录</div>
              </div>
              <IChevR size={15} className="text-mut" />
            </Button>
          </Section>

          <Section title="网络">
            <ProxySettings />
            <Button onClick={() => setLineOpen(true)} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable">
              <span className="ios-setting-icon"><IBoltF size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">播放源</div>
                <div className="text-[12px] text-mut truncate">{lineBase ? hostOf(lineBase) : "读取中…"}</div>
              </div>
              <IChevR size={15} className="text-mut" />
            </Button>
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="ios-setting-icon"><IRefresh size={15} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">自动选择线路</div>
                <div className="text-[12px] text-mut">主站不可用时检测已发布镜像；关闭后保留手动选择</div>
              </div>
              <Toggle label="自动选择线路" on={autoLineOn} onChange={(on) => {
                void setAutoLine(on).catch(() => toast("自动选线暂停失败，请重试", "info"));
                setAutoLineOn(on);
                toast(on ? "已开启自动选择线路" : "已关闭自动选线，可手动选择播放源", "info");
              }} />
            </div>
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="ios-setting-icon"><ILockF size={15} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">严格安全模式</div>
                <div className="text-[12px] text-mut">
                  {cliRelaxed
                    ? "已由启动参数 --no-strict 切换为兼容模式；可手动重新开启"
                    : "默认开启，防上游投毒与内网探测；若导致正文或特殊代理异常可关闭（或用 --no-strict 启动）"}
                </div>
              </div>
              <Toggle
                on={strictSecurity}
                disabled={!strictSecurityReady || securityPending}
                onChange={(on) => {
                  void setStrictSecurity(on).then(() => {
                    toast(on ? "已开启严格安全模式" : "已切换为兼容模式（关闭激进清洗与守卫）", "info");
                  }).catch(() => toast("安全设置保存失败，已保持原模式", "info"));
                }}
                label="严格安全模式"
              />
            </div>
            {/* 打不开时先点这里：把 DNS / 代理 / HTTP 结果复制给维护者 */}
            <Button disabled={diagnosing} onClick={async () => {
              setDiagnosing(true);
              try {
                const diag = await api.netDiag();
                // 落盘走原始 JSON（便于脚本统计），复制给对方的是分段可读报告。
                logLine(`[net_diag] ${JSON.stringify(diag)}`);
                const http = (diag.http ?? {}) as { ms?: number; status?: number };
                const dns = (diag.dns ?? {}) as { count?: number; has_fake_ip?: boolean };
                const env = (diag.env ?? {}) as Record<string, unknown>;
                tracePlayback("net.diag", {
                  verdict: String(diag.verdict ?? ""),
                  host: hostOf(String(diag.host ?? "")), http_status: http.status ?? null, http_ms: http.ms ?? null,
                  dns_count: dns.count ?? null, fake_ip: dns.has_fake_ip ?? null,
                  proxy: Object.values(env).some(Boolean), strict: strictSecurity,
                });
                const report = formatNetDiag(diag);
                try {
                  await copyText(report);
                  toast(`诊断已复制 · ${shortVerdict(diag)}`, "ok");
                } catch {
                  setDiagReport(report);
                  toast("诊断已完成，复制失败，可在报告中重试", "info");
                }
              } catch (e) {
                const detail = e instanceof Error ? e.message : typeof e === "string" ? e : "请稍后重试";
                toast(`网络诊断失败：${detail}`, "info");
              } finally {
                setDiagnosing(false);
              }
            }} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable disabled:opacity-60">
              <span className="ios-setting-icon"><ILink size={16} /></span>
              <div className="flex-1">
                <div className="text-[14px] text-on">{diagnosing ? "正在诊断…" : "网络诊断"}</div>
                <div className="text-[12px] text-mut">DNS / TCP / 系统代理 / 官网连通性，一键复制带结论的报告</div>
              </div>
              <IChevR size={15} className="text-mut" />
            </Button>
          </Section>

          <Section title="播放诊断">
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="ios-setting-icon"><IInfo size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">播放诊断日志</div>
                <div className="text-[12px] text-mut">版本、平台、当前线路和播放失败原因始终记录；开关只额外记录拖动与缓冲细节</div>
                {playbackLog.error && <div role="alert" className="text-[12px] text-danger">{playbackLog.error}</div>}
              </div>
              <Toggle label="播放诊断日志" on={playbackLog.enabled} disabled={!playbackLog.ready || playbackLog.pending}
                onChange={(on) => { void setPlaybackLog(on).then(() => toast(on ? "已开启播放诊断，请复现问题" : "已关闭播放诊断，已有日志保留", "ok")).catch(() => toast("日志设置保存失败，请重试", "info")); }} />
            </div>
            <Button disabled={!playbackLog.ready || playbackLog.pending || copyingLog} onClick={async () => {
              setCopyingLog(true);
              try { await copyPlaybackLog(); toast("播放诊断日志已复制", "ok"); }
              catch (e) { toast((e as Error).message || "复制日志失败", "info"); }
              finally { setCopyingLog(false); }
            }} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable disabled:opacity-60">
              <span className="ios-setting-icon"><ILink size={16} /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-on">{copyingLog ? "正在复制…" : "复制播放诊断日志"}</div>
                <div className="text-[12px] text-mut break-all">含版本、平台、当前线路、播放失败原因，粘贴即完整{playbackLog.path ? ` · ${playbackLog.path}` : ""}</div>
              </div>
              <IChevR size={15} className="text-mut" />
            </Button>
          </Section>

          <Section title="其他">
            <Button onClick={checkUpdate} disabled={checking} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable disabled:opacity-60">
              <span className="ios-setting-icon"><IRefresh size={16} /></span>
              <div className="flex-1">
                <div className="text-[14px] text-on">检查更新</div>
                <div className="text-[12px] text-mut">{checking ? "检查中…" : `当前 v${APP_VERSION} · 对比 GitHub Release`}</div>
              </div>
              <IChevR size={15} className="text-mut" />
            </Button>
            <Button onClick={() => setAbout(true)} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable">
              <span className="ios-setting-icon"><IInfo size={16} /></span>
              <div className="flex-1">
                <div className="text-[14px] text-on">关于 HGhubX</div>
                <div className="text-[12px] text-mut">版本 {APP_VERSION} · 仅限非商业使用</div>
              </div>
              <IChevR size={15} className="text-mut" />
            </Button>
          </Section>

          <div className="text-center text-[12px] text-dim mt-5">HGhubX {APP_VERSION} · {platform === "android" ? "Android" : platform === "ios" ? "iOS" : platform === "macos" ? "macOS" : platform === "linux" ? "Linux" : "Windows"} 客户端</div>
        </div>
      </div>

      <LinePicker open={lineOpen} onClose={() => { setLineOpen(false); readLine(); }} />

      <Modal open={diagReport !== null} onClose={() => setDiagReport(null)} width={520}>
        <div className="p-5">
          <h2 className="text-[15px] font-bold text-on">网络诊断报告</h2>
          <p className="text-[13px] text-mut mt-2">诊断已完成，自动复制未成功。可以重试复制，或在下方选择报告文字。</p>
          <TextArea readOnly aria-label="网络诊断报告" value={diagReport ?? ""}
            className="w-full h-64 mt-3 p-3 rounded-(--r-sm) bg-s3 text-[12px] text-on resize-none" />
          <div className="flex gap-2 mt-4">
            <Button onClick={() => setDiagReport(null)} className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[14px] text-on pressable">关闭</Button>
            <Button disabled={copyingReport} onClick={async () => {
              if (diagReport === null) return;
              setCopyingReport(true);
              try { await copyText(diagReport); toast("网络诊断报告已复制", "ok"); setDiagReport(null); }
              catch { toast("复制失败，请选择报告文字手动复制", "info"); }
              finally { setCopyingReport(false); }
            }} className="flex-1 h-9 rounded-(--r-ctl) brand-grad text-[14px] pressable disabled:opacity-60">{copyingReport ? "正在复制…" : "复制报告"}</Button>
          </div>
        </div>
      </Modal>

      <Modal open={about} onClose={() => setAbout(false)} width={392}>
        <div className="p-5">
          <div className="flex items-center gap-3">
            <span className="w-11 h-11 rounded-(--r-sm) brand-grad glow-neon flex items-center justify-center text-on-primary text-[17px] font-black">H</span>
            <div>
              <div className="text-[16px] font-bold text-on leading-tight">HGhubX</div>
              <div className="text-[12px] text-mut mt-0.5">HGhubX 客户端 v{APP_VERSION}</div>
            </div>
          </div>

          <p className="text-[13px] text-on/70 leading-relaxed mt-4">
            基于 Rust + Tauri 2 构建的跨平台客户端，支持 Windows、macOS、Linux、Android 与 iOS。
            界面采用 iOS 圆角与玻璃材质风格，播放器采用沉浸式竖屏信息流。
          </p>

          <Surface className="mt-4 rounded-(--r-sm) bg-s3/60 p-3 text-[12px] text-mut leading-relaxed">
            本项目仅供学习与交流，所有内容均来自上游站点，客户端不存储、不分发任何视频内容。
            请于 24 小时内删除相关资源，并支持正版。
          </Surface>

          <div className="mt-4 divide-y divide-s3">
            <Button onClick={() => { api.openUrl("https://github.com/zxsos/HGhubX").catch(() => { copyText("https://github.com/zxsos/HGhubX").then(() => toast("仓库地址已复制", "ok")).catch(() => {}); }); }}
              className="w-full flex items-center gap-2 py-2.5 text-left pressable">
              <ILink size={15} className="text-mut" />
              <span className="text-[13px] text-on/85">github.com/zxsos/HGhubX</span>
              <span className="ml-auto text-[12px] text-primary">复制</span>
            </Button>
            <Button onClick={() => { copyText("https://huangguoai.com").then(() => toast("站点地址已复制", "ok")).catch(() => {}); }}
              className="w-full flex items-center gap-2 py-2.5 text-left pressable">
              <ILink size={15} className="text-mut" />
              <span className="text-[13px] text-on/85">huangguoai.com</span>
              <span className="ml-auto text-[12px] text-primary">复制</span>
            </Button>
            <div className="flex items-center gap-2 py-2.5">
              <IInfo size={15} className="text-mut" />
              <span className="text-[13px] text-on/85">PolyForm Noncommercial 1.0.0</span>
              <span className="ml-auto text-[12px] text-mut">仅限非商业</span>
            </div>
          </div>

          <Button onClick={() => setAbout(false)} className="mt-4 w-full h-9 rounded-(--r-ctl) bg-s3 text-[14px] text-on pressable">知道了</Button>
        </div>
      </Modal>

      <Modal open={clearOpen} onClose={() => setClearOpen(false)} width={330}>
        <div className="p-5">
          <div className="text-[15px] font-bold text-on">清理缓存</div>
          <p className="text-[13px] text-mut leading-relaxed mt-2">
            只清除封面与播放列表缓存（解密图 / m3u8）。收藏、观看记录、搜索历史与登录状态都会保留。
          </p>
          <div className="flex gap-2 mt-5">
            <Button onClick={() => setClearOpen(false)} className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[14px] text-on/80 pressable">取消</Button>
            <Button disabled={clearing} onClick={async () => {
              setClearing(true);
              try { await api.clearCache(); } catch { /* 忽略 */ }
              setClearing(false);
              setClearOpen(false);
              toast("缓存已清理", "ok");
            }} className="flex-1 h-9 rounded-(--r-ctl) bg-primary text-[14px] font-semibold text-on-primary pressable disabled:opacity-60">
              {clearing ? "清理中…" : "确定清理"}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={!!update?.has_update} onClose={() => setUpdate(null)} width={392}>
        <div className="p-5">
          <div className="text-[16px] font-bold text-on">发现新版本</div>
          <p className="text-[12px] text-mut mt-1.5">
            v{update?.current} → <b className="text-on">v{update?.latest}</b>
            {update?.published_at ? ` · ${update.published_at.slice(0, 10)}` : ""}
          </p>
          {!!update?.notes && (
            <Surface className="mt-3 max-h-[180px] scroll-y rounded-(--r-sm) bg-s2 p-3 text-[12px] text-mut whitespace-pre-wrap leading-relaxed">{update.notes}</Surface>
          )}
          <div className="flex gap-2 mt-4">
            <Button onClick={() => setUpdate(null)} disabled={!!updating}
              className="flex-1 h-9 rounded-(--r-ctl) bg-s3 text-[14px] text-on/80 pressable disabled:opacity-60">稍后</Button>
            <Button onClick={() => void doUpdate()} disabled={!!updating}
              className="flex-1 h-9 rounded-(--r-ctl) bg-primary text-[14px] font-semibold text-on-primary pressable disabled:opacity-60">
              {updating || "前往下载"}
            </Button>
          </div>
          <div className="text-[12px] text-dim mt-2.5 break-all">{update?.url}</div>
        </div>
      </Modal>
    </div>
  );
}
