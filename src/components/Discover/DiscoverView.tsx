import { Header } from "../Layout/Header";
import { Icon } from "../ui/Icon";
export function DiscoverView() {
  return (
    <div className="pt-24 px-5 md:px-8 max-w-4xl w-full mx-auto">
      <Header title="发现" subtitle="Find books" />
      <div className="bg-surface-container-low border border-surface-variant rounded-2xl p-10 text-center space-y-4">
        <Icon name="explore" size={32} className="mx-auto text-primary" />
        <h2 className="font-title-editorial text-xl">书源发现尚未开放</h2>
        <p className="text-secondary text-sm">
          当前可从书架导入本地 TXT。书源兼容将在基础阅读完成后提供。
        </p>
        <button disabled className="rounded-xl bg-surface-container px-4 py-2 text-secondary">
          搜索书源 · 未开放
        </button>
      </div>
    </div>
  );
}
