import { Button, SegmentedControl, Surface } from "../../shared/ui/ios/controls";
import { Toggle } from "../../shared/ui/ui";
import { IBoltF, IClock, IClose, IExpand } from "../../shared/ui/icons";
import { tr } from "../../shared/i18n";

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function PlaybackSettingsPanel({ rate, onRate, preferHevc, onPreferHevc, portraitFit, onPortraitFit, onClose }: {
  rate: number;
  onRate: (rate: number) => void;
  preferHevc: boolean;
  onPreferHevc: (on: boolean) => void;
  portraitFit: "contain" | "cover";
  onPortraitFit: (fit: "contain" | "cover") => void;
  onClose: () => void;
}) {
  return <div className="playback-settings-sheet">
    <header className="playback-settings-header">
      <div><h2>{tr("播放设置")}</h2><p>{tr("不影响当前播放进度")}</p></div>
      <Button aria-label={tr("关闭播放设置")} className="ios-icon-button" onClick={onClose}><IClose size={18} /></Button>
    </header>
    <div className="playback-settings-list">
      <Surface className="ios-setting-group playback-settings-group">
        <div className="ios-settings-row playback-setting-row">
          <span className="ios-setting-icon"><IBoltF size={16} /></span>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] text-on">{tr("优先高清")}</div>
            <div className="text-[12px] text-mut">{tr("开启后默认高清，关闭后默认标清")}</div>
          </div>
          <Toggle desktop on={preferHevc} onChange={onPreferHevc} label={tr("优先高清")} />
        </div>
        <div className="ios-settings-row playback-setting-row">
          <span className="ios-setting-icon"><IExpand size={16} /></span>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] text-on">{tr("画面尺寸")}</div>
            <div className="text-[12px] text-mut">{tr("竖屏视频的填充方式")}</div>
          </div>
          <SegmentedControl className="playback-setting-size" aria-label={tr("画面尺寸")} activeIndex={portraitFit === "contain" ? 0 : 1}>
            <Button aria-pressed={portraitFit === "contain"} onClick={() => onPortraitFit("contain")}>{tr("适应")}</Button>
            <Button aria-pressed={portraitFit === "cover"} onClick={() => onPortraitFit("cover")}>{tr("铺满")}</Button>
          </SegmentedControl>
        </div>
        <div className="ios-settings-row playback-setting-row playback-setting-rate-row">
          <span className="ios-setting-icon"><IClock size={16} /></span>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] text-on">{tr("倍速")}</div>
            <div className="text-[12px] text-mut">{tr("立即应用到当前视频")}</div>
          </div>
          <SegmentedControl className="playback-setting-rates" aria-label={tr("播放倍速")} activeIndex={RATES.indexOf(rate)}>
            {RATES.map(value => <Button key={value} aria-pressed={rate === value} aria-label={tr("倍速 {0} 倍", value)} onClick={() => onRate(value)}>{value}×</Button>)}
          </SegmentedControl>
        </div>
      </Surface>
    </div>
  </div>;
}
