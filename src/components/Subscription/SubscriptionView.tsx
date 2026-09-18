import { Header } from "../Layout/Header";
import { Icon } from "../ui/Icon";
export function SubscriptionView() {
  return (
    <div className="pt-24 px-5 md:px-8 max-w-4xl w-full mx-auto">
      <Header title="订阅" subtitle="RSS" />
      <div className="bg-surface-container-low border border-surface-variant rounded-2xl p-10 text-center space-y-4">
        <Icon name="collections_bookmark" size={32} className="mx-auto text-primary" />
        <h2 className="font-title-editorial text-xl">RSS 订阅尚未开放</h2>
        <p className="text-secondary text-sm">订阅源、文章抓取与阅读状态将在后续阶段接入。</p>
        <button disabled className="rounded-xl bg-surface-container px-4 py-2 text-secondary">
          添加订阅 · 未开放
        </button>
      </div>
    </div>
  );
}
