import { version } from "../../../package.json";
import { FullPage, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Icon } from "../ui/Icon";

/** The version shown in settings and here. */
export const APP_VERSION = version;

const FEATURES = [
  "本地 TXT 导入，自动识别编码和章节",
  "仿真、覆盖、平移等翻页，单页、双页和滚动阅读",
  "替换净化、简繁转换、朗读与自动翻页",
  "书签、阅读记录，WebDAV 备份与云书架",
];

/**
 * 关于: the app, its version, and the place for updates and the change log,
 * which will come from GitHub releases once update checking exists.
 */
export function AboutPage({ onClose }: { onClose: () => void }) {
  return (
    <FullPage label="关于" onClose={onClose}>
      <div className="flex flex-col items-center text-center gap-2 py-6">
        <span className="h-16 w-16 rounded-2xl bg-primary-container text-on-primary-container flex items-center justify-center">
          <Icon name="auto_stories" size={30} />
        </span>
        <h2 className="font-title-editorial text-xl font-semibold">手不释卷 · GripRead</h2>
        <p className="text-xs text-secondary">版本 {APP_VERSION}</p>
      </div>
      <PageSection title="简介">
        <div className="px-4 py-3 space-y-2 text-sm">
          <p>
            一款本地优先的小说阅读器，功能和布局参考「阅读（Legado）」，不需要账号也能完整使用。
          </p>
          <ul className="space-y-1 text-xs text-secondary">
            {FEATURES.map((feature) => (
              <li key={feature} className="flex gap-2">
                <Icon name="check" size={13} className="text-primary shrink-0 mt-0.5" />
                {feature}
              </li>
            ))}
          </ul>
        </div>
      </PageSection>
      <PageSection title="更新">
        <div className="px-4 py-3 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">当前版本 {APP_VERSION}</span>
            <Button size="sm" variant="outline" disabled>
              检查更新
            </Button>
          </div>
          <p className="text-[11px] text-secondary">
            检查更新和更新日志将从 GitHub 发布信息获取，暂未开放。
          </p>
        </div>
      </PageSection>
      <PageSection title="更新日志">
        <p className="px-4 py-3 text-xs text-secondary">更新日志将随检查更新一起提供。</p>
      </PageSection>
    </FullPage>
  );
}
