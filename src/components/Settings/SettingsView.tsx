import { useState } from "react";
import { Header } from "../Layout/Header";
import { useSettings } from "../../application/runtime";
import { Button } from "../ui/button";
import { Slider } from "../ui/slider";
import { Switch } from "../ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { Icon } from "../ui/Icon";
export function SettingsView() {
  const { state, store } = useSettings();
  const [panel, setPanel] = useState<"font" | "animation" | null>(null);
  const value = state.value;
  return (
    <div className="flex-1 pt-20 pb-28 md:pb-8 bg-surface">
      <Header title="设置" subtitle="Preferences" />
      <main className="max-w-3xl w-full mx-auto px-4 md:px-8 space-y-5">
        {state.error && (
          <div role="alert" className="rounded-xl p-4 bg-error-container text-error text-sm">
            偏好设置{value ? "保存" : "读取"}失败：{state.error}
            <Button
              variant="outline"
              className="ml-3"
              onClick={() => (value ? store.retry() : void store.load())}
            >
              重试
            </Button>
          </div>
        )}
        {!value ? (
          <p role="status">正在读取偏好设置…</p>
        ) : (
          <>
            <section className="rounded-2xl bg-surface-container-low border border-surface-variant/50 p-5 space-y-5">
              <h2 className="font-title-editorial text-lg">阅读体验</h2>
              <button
                onClick={() => setPanel("font")}
                className="w-full flex justify-between text-left items-center"
              >
                <span className="flex items-center gap-3">
                  <Icon name="format_size" />
                  字体与字号
                </span>
                <span className="text-sm text-secondary">
                  {value.fontFamily === "serif" ? "宋体 / 衬线" : "系统无衬线"} · {value.fontSize}px
                </span>
              </button>
              <div>
                <label className="text-sm block mb-3" htmlFor="line-height">
                  行高：{value.lineHeight.toFixed(1)}
                </label>
                <Slider
                  id="line-height"
                  aria-label="行高"
                  min={1.2}
                  max={2.4}
                  step={0.1}
                  value={value.lineHeight}
                  onValueChange={(height) =>
                    store.set({ lineHeight: Array.isArray(height) ? height[0] : height })
                  }
                />
              </div>
              <button
                onClick={() => setPanel("animation")}
                className="w-full flex justify-between text-left items-center"
              >
                <span className="flex items-center gap-3">
                  <Icon name="auto_stories" />
                  翻页效果
                </span>
                <span className="text-sm text-secondary">
                  {value.pageTurnEffect === "curl" ? "仿真翻页" : "即时翻页"}
                </span>
              </button>
            </section>
            <section className="rounded-2xl bg-surface-container-low border border-surface-variant/50 p-5 space-y-5">
              <h2 className="font-title-editorial text-lg">外观</h2>
              <div className="flex gap-2">
                {(["system", "light", "dark"] as const).map((mode, index) => (
                  <Button
                    key={mode}
                    variant={value.theme === mode ? "default" : "outline"}
                    aria-pressed={value.theme === mode}
                    onClick={() => store.set({ theme: mode })}
                  >
                    {["跟随系统", "浅色", "深色"][index]}
                  </Button>
                ))}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {(["warm-tea", "bone-white", "xuan-paper", "jade-green"] as const).map(
                  (tone, index) => (
                    <button
                      key={tone}
                      aria-pressed={value.paperTone === tone}
                      onClick={() => store.set({ paperTone: tone })}
                      className={`rounded-xl border p-4 text-xs ${value.paperTone === tone ? "border-primary ring-1 ring-primary" : "border-surface-variant"}`}
                    >
                      <span
                        className="block h-10 mb-3 rounded-lg border border-black/10"
                        style={{ background: ["#fbf9f3", "#faf8f5", "#f3ece0", "#e7ebe4"][index] }}
                      />
                      {["柔雅暖茶", "羊脂白", "宣纸微黄", "墨绿温润"][index]}
                    </button>
                  ),
                )}
              </div>
              <label className="flex items-center justify-between gap-4 text-sm">
                OLED 纯黑背景
                <Switch
                  checked={value.oledBlack}
                  onCheckedChange={(checked) => store.set({ oledBlack: checked })}
                  aria-label="OLED 纯黑背景"
                />
              </label>
            </section>
            <section className="rounded-2xl bg-surface-container-low border border-surface-variant/50 p-5 space-y-4">
              <h2 className="font-title-editorial text-lg">同步与存储</h2>
              {["WebDAV 同步与备份", "缓存管理", "书源管理", "书架分组"].map((label) => (
                <div key={label} className="flex justify-between text-sm">
                  <span>{label}</span>
                  <span className="text-secondary">未开放</span>
                </div>
              ))}
            </section>
            <p role="status" className="text-xs text-secondary">
              {state.saving
                ? "正在保存偏好设置…"
                : state.error
                  ? "偏好设置尚未保存"
                  : "偏好设置已保存到本地"}
            </p>
            <Dialog
              open={panel !== null}
              onOpenChange={(open) => {
                if (!open) setPanel(null);
              }}
            >
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{panel === "font" ? "字体与字号" : "翻页效果"}</DialogTitle>
                  <DialogDescription>
                    {panel === "font"
                      ? "排版变化会保留当前阅读位置。"
                      : "跟随系统减少动态效果时，自动使用即时翻页。"}
                  </DialogDescription>
                </DialogHeader>
                {panel === "font" ? (
                  <div className="space-y-5">
                    <div className="flex gap-2">
                      <Button
                        aria-pressed={value.fontFamily === "serif"}
                        variant="outline"
                        onClick={() => store.set({ fontFamily: "serif" })}
                      >
                        衬线字体
                      </Button>
                      <Button
                        aria-pressed={value.fontFamily === "sans"}
                        variant="outline"
                        onClick={() => store.set({ fontFamily: "sans" })}
                      >
                        系统字体
                      </Button>
                    </div>
                    <label className="block" htmlFor="font-size">
                      字号：{value.fontSize}px
                    </label>
                    <Slider
                      id="font-size"
                      aria-label="字号"
                      value={value.fontSize}
                      min={14}
                      max={32}
                      step={1}
                      onValueChange={(size) =>
                        store.set({ fontSize: Array.isArray(size) ? size[0] : size })
                      }
                    />
                  </div>
                ) : (
                  <div className="space-y-2">
                    {(["curl", "instant"] as const).map((effect) => (
                      <Button
                        key={effect}
                        variant={value.pageTurnEffect === effect ? "default" : "outline"}
                        className="w-full"
                        aria-pressed={value.pageTurnEffect === effect}
                        onClick={() => store.set({ pageTurnEffect: effect })}
                      >
                        {effect === "curl" ? "仿真翻页" : "即时翻页"}
                      </Button>
                    ))}
                    <p className="text-xs text-secondary pt-2">滑动翻页、连续滚动 · 未开放</p>
                  </div>
                )}
              </DialogContent>
            </Dialog>
          </>
        )}
      </main>
    </div>
  );
}
