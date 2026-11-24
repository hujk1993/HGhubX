import { useId, useState } from "react";
import { MAX_BLOCKED_TAGS, MAX_TAG_LENGTH, normalizeTag, useContentPreferences } from "../../shared/model/contentPreferences";
import { Button, Form, Input } from "../../shared/ui/ios/controls";
import { Modal, Toggle } from "../../shared/ui/ui";
import { IClose } from "../../shared/ui/icons";
import "../../styles/content-preferences.css";
import { tr } from "../../shared/i18n";

export default function ContentPreferencesSettings() {
  const { preferences, storageError, blockTags, unblockTag, setPaused, setHideUntagged, clearBlockedTags, isTagBlocked } = useContentPreferences();
  const [value, setValue] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [removal, setRemoval] = useState<{ tag: string } | { all: true } | null>(null);
  const errorId = useId();
  const tags = preferences.blockedTags.filter(tag => normalizeTag(tag).includes(normalizeTag(query)));
  const add = () => {
    const tag = value.trim().replace(/\s+/g, " ");
    setMessage("");
    if (!tag) { setError(tr("请输入要屏蔽的完整标签。")); return; }
    if (tag.length > MAX_TAG_LENGTH) { setError(tr("标签最多 {0} 个字符。", MAX_TAG_LENGTH)); return; }
    if (isTagBlocked(tag)) { setError(tr("该标签已在屏蔽列表中。")); return; }
    if (preferences.blockedTags.length >= MAX_BLOCKED_TAGS) { setError(tr("最多保存 {0} 个标签，请先移除不再需要的标签。", MAX_BLOCKED_TAGS)); return; }
    blockTags([tag]); setValue(""); setError(""); setMessage(tr("已屏蔽标签：{0}", tag));
  };
  const remove = () => {
    if (!removal) return;
    if ("all" in removal) { clearBlockedTags(); setMessage(tr("已清空屏蔽标签。")); }
    else { unblockTag(removal.tag); setMessage(tr("已取消屏蔽：{0}", removal.tag)); }
    setRemoval(null);
  };
  return <div className="content-preferences-settings">
    <div className="content-preference-state" data-paused={preferences.paused}>
      <span className="content-preference-state-dot" aria-hidden="true" />
      <div className="min-w-0 text-[12px] leading-relaxed text-mut"><p className="font-semibold text-[13px] text-on">{preferences.paused ? tr("屏蔽已暂停") : preferences.blockedTags.length || preferences.hideUntagged ? tr("内容筛选已开启") : tr("尚未设置屏蔽规则")}</p>
        <p className="mt-1">{preferences.paused ? tr("已保存的规则保留，恢复后继续生效。") : tr("已保存 {0} / {1} 个标签；仅影响本机内容展示。", preferences.blockedTags.length, MAX_BLOCKED_TAGS)}</p>
      </div>
    </div>
    <div className="content-preference-switches">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0"><h3 className="text-[14px] font-semibold text-on">{tr("暂停全部屏蔽")}</h3>
          <p className="text-[12px] text-mut mt-1">{tr("暂时展示所有内容，已保存的标签仍会保留。")}</p></div>
        <Toggle desktop label={tr("暂停全部屏蔽")} on={preferences.paused} onChange={setPaused} />
      </div>
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0"><h3 className="text-[14px] font-semibold text-on">{tr("隐藏无标签视频")}</h3>
          <p className="text-[12px] text-mut mt-1">{tr("默认保留无标签内容；开启后也会受“暂停全部屏蔽”控制。")}</p></div>
        <Toggle desktop label={tr("隐藏无标签视频")} on={preferences.hideUntagged} onChange={setHideUntagged} />
      </div>
    </div>
    <Form className="space-y-2" onSubmit={event => { event.preventDefault(); add(); }}>
      <label className="block text-[13px] font-semibold text-on" htmlFor={`${errorId}-add`}>{tr("添加屏蔽标签")}</label>
      <div className="flex flex-wrap gap-2">
        <Input id={`${errorId}-add`} aria-label={tr("添加屏蔽标签")} value={value} onChange={event => { setValue(event.target.value); setError(""); }}
          placeholder={tr("输入完整标签，例如：恐怖")} autoComplete="off" maxLength={MAX_TAG_LENGTH} aria-invalid={!!error} aria-describedby={error ? errorId : undefined}
          className="flex-1 w-full min-w-[160px]" />
        <Button type="submit" variant="primary" className="min-h-11 px-4 rounded-(--r-ctl)">{tr("屏蔽标签")}</Button>
      </div>
      {error && <p id={errorId} role="alert" className="text-[13px] text-danger break-words">{error}</p>}
    </Form>
    <div className="content-preference-library">
      <div className="content-preference-library-heading">
        <h3 className="text-[13px] font-semibold text-on">{tr("已屏蔽标签 · {0}", preferences.blockedTags.length)}</h3>
        <Button className="min-h-11 px-3 text-danger" disabled={!preferences.blockedTags.length} onClick={() => setRemoval({ all: true })}>{tr("清空标签")}</Button>
      </div>
      {preferences.blockedTags.length > 0 && <label className="block text-[13px] text-mut">
        <span className="block mb-2">{tr("搜索已屏蔽标签")}</span>
        <Input aria-label={tr("搜索已屏蔽标签")} placeholder={tr("按标签名称查找")} value={query} onChange={event => setQuery(event.target.value)} className="w-full" />
      </label>}
      <ul aria-label={tr("已屏蔽标签")} className="content-preference-tag-list" tabIndex={tags.length ? 0 : undefined}>
        {tags.map(tag => <li key={normalizeTag(tag)}>
          <span className="text-[13px] text-on break-words min-w-0">{tag}</span>
          <Button aria-label={tr("取消屏蔽 {0}", tag)} onClick={() => setRemoval({ tag })}><IClose size={16} /></Button>
        </li>)}
      </ul>
      {!tags.length && <p className="text-[13px] text-mut">{preferences.blockedTags.length ? tr("没有匹配的屏蔽标签。") : tr("还没有屏蔽标签。你也可以在视频“不感兴趣”或标签页面添加。")}</p>}
    </div>
    <p role="status" aria-live="polite" className="text-[13px] text-mut break-words">{message || (preferences.paused ? tr("屏蔽已暂停。") : tr("偏好立即生效，仅保存在本机。"))}</p>
    {storageError && <div role="alert" className="rounded-(--r-md) bg-s3 p-3 text-[13px] text-danger">
      <p>{storageError}</p><Button className="mt-2 min-h-11 px-3 text-on" onClick={() => setPaused(preferences.paused)}>{tr("重试保存")}</Button>
    </div>}
    <details className="content-preference-help text-[12px] text-mut leading-relaxed">
      <summary className="min-h-11 flex items-center cursor-pointer text-[13px] text-on">{tr("屏蔽如何生效")}</summary>
      <p>{tr("按完整标签匹配，忽略标签前后空格和英文大小写，命中任意一个标签即生效。首页和直接打开的内容会自动跳过；搜索、分类、排行榜等列表默认隐藏，可临时展开；收藏和历史保留占位记录。")}</p>
      <p className="mt-2">{tr("标签依赖内容提供方，缺失或不准确的标签可能影响结果。修改偏好不会删除收藏和观看记录。")}</p>
    </details>
    <Modal open={!!removal} onClose={() => setRemoval(null)} label={removal && "all" in removal ? tr("清空屏蔽标签") : tr("取消屏蔽标签")}>
      <div className="p-5">
        <h2 className="text-[18px] font-bold">{removal && "all" in removal ? tr("清空屏蔽标签") : tr("取消屏蔽标签")}</h2>
        <p className="content-preference-confirm-copy mt-3 text-[14px] text-mut">{removal && "tag" in removal ? tr("取消屏蔽“{0}”？相关内容会重新出现在列表中。", removal.tag) : tr("清空全部屏蔽标签？“隐藏无标签视频”开关保持当前设置。")}</p>
        <div className="mt-4 flex gap-3"><Button variant="secondary" className="flex-1 min-h-11" onClick={() => setRemoval(null)}>{tr("保留")}</Button>
          <Button variant="danger" className="flex-1 min-h-11" onClick={remove}>{tr("确认{0}", removal && "all" in removal ? tr("清空") : tr("取消屏蔽"))}</Button></div>
      </div>
    </Modal>
  </div>;
}
