import { useState } from "react";
import { Header } from "../Layout/Header";
import { Icon } from "../ui/Icon";
import { useLibrary, useSettings } from "../../application/runtime";
import type { ReaderPreferences } from "../../types/generated";
type PaperTone = ReaderPreferences["paperTone"];
type ThemeMode = ReaderPreferences["theme"];
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export function SettingsView() {
  const { state, store } = useSettings();
  const { state: library } = useLibrary();
  const [activeModal, setActiveModal] = useState<"typography" | "animation" | null>(null);
  const value = state.value;
  if (!value)
    return (
      <div className="pt-20 px-4">
        <Header title="设置" subtitle="SETTINGS" />
        {state.error ? (
          <div role="alert">
            偏好设置读取失败：{state.error}
            <Button onClick={() => void store.load()}>重试</Button>
          </div>
        ) : (
          <p role="status">正在读取偏好设置…</p>
        )}
      </div>
    );
  const {
    theme,
    paperTone,
    oledBlack: isOledBlack,
    fontSize,
    lineHeight,
    fontFamily,
    pageTurnEffect,
  } = value;
  const setTheme = (theme: ThemeMode) => store.set({ theme });
  const setPaperTone = (paperTone: PaperTone) => store.set({ paperTone });
  const setIsOledBlack = (oledBlack: boolean) => store.set({ oledBlack });
  const setFontSize = (update: number | ((size: number) => number)) =>
    store.set({ fontSize: typeof update === "number" ? update : update(fontSize) });
  const setLineHeight = (lineHeight: number) => store.set({ lineHeight });
  const setFontFamily = (fontFamily: ReaderPreferences["fontFamily"]) => store.set({ fontFamily });
  const setPageTurnEffect = (pageTurnEffect: ReaderPreferences["pageTurnEffect"]) =>
    store.set({ pageTurnEffect });
  const paperToneLabels: Record<PaperTone, string> = {
    "warm-tea": "柔雅暖茶",
    "bone-white": "羊脂白",
    "xuan-paper": "宣纸微黄",
    "jade-green": "墨绿温润",
  };

  const pageTurnLabels: Record<string, string> = {
    curl: "平滑仿真翻页",
    slide: "平滑滑动切换",
    instant: "极简无动效",
    scroll: "连续纵向滚动",
  };

  return (
    <div className="flex-1 flex flex-col relative w-full pt-14 pb-20 md:pb-8 bg-surface min-w-0">
      <Header title="设置" subtitle="SETTINGS" />

      <main className="flex-1 flex flex-col relative w-full max-w-3xl mx-auto px-4 md:px-8 pb-space-lg space-y-4 pt-3">
        {state.error && (
          <div role="alert" className="rounded-xl bg-error-container text-error p-3 text-xs">
            偏好设置保存失败：{state.error}
            <Button size="sm" variant="outline" onClick={() => store.retry()}>
              重试
            </Button>
          </div>
        )}
        {/* 1. Pure Reading Statistics Summary */}
        <Card className="w-full bg-surface-container rounded-xl p-4 shadow-sm border-transparent ring-0">
          <div className="flex items-center justify-between mb-2">
            <span className="font-label-caps text-xs text-secondary tracking-wider flex items-center gap-1.5">
              <Icon name="insights" size={15} className="text-primary" fill />
              本地阅读概览
            </span>
            <span className="font-label-md text-xs text-primary font-medium">阅读统计未开放</span>
          </div>

          <div className="grid grid-cols-3 divide-x-0 gap-2 text-center">
            {/* Stat 1 */}
            <div className="flex flex-col items-center justify-center py-1">
              <div className="flex items-baseline gap-0.5">
                <span className="font-headline-md text-xl sm:text-2xl text-on-surface font-semibold tracking-tight">
                  —
                </span>
                <span className="font-label-md text-xs text-secondary">小时</span>
              </div>
              <span className="font-label-md text-xs text-secondary mt-0.5">累计阅读</span>
            </div>

            {/* Stat 2 */}
            <div className="flex flex-col items-center justify-center py-1">
              <div className="flex items-baseline gap-0.5">
                <span className="font-headline-md text-xl sm:text-2xl text-primary font-semibold tracking-tight">
                  —
                </span>
                <span className="font-label-md text-xs text-primary font-medium">分钟</span>
              </div>
              <span className="font-label-md text-xs text-secondary mt-0.5">今日专注</span>
            </div>

            {/* Stat 3 */}
            <div className="flex flex-col items-center justify-center py-1">
              <div className="flex items-baseline gap-0.5">
                <span className="font-headline-md text-xl sm:text-2xl text-on-surface font-semibold tracking-tight">
                  {library.loading || library.error ? "—" : library.books.length}
                </span>
                <span className="font-label-md text-xs text-secondary">本</span>
              </div>
              <span className="font-label-md text-xs text-secondary mt-0.5">藏书总数</span>
            </div>
          </div>
        </Card>

        {/* 2. Grouped Settings List */}
        <div className="space-y-4">
          {/* Group 1: 阅读与排版 */}
          <section className="flex flex-col space-y-1.5">
            <h3 className="font-label-caps text-[11px] text-secondary px-1 uppercase tracking-wider">
              阅读与排版
            </h3>
            <Card className="bg-surface-container-low rounded-xl overflow-hidden shadow-sm border-transparent ring-0 p-0">
              {/* Row 1: 排版与字体 */}
              <button
                type="button"
                onClick={() => setActiveModal("typography")}
                className="w-full flex items-center justify-between px-4 py-3 text-left transition-colors hover:bg-surface-container active:bg-surface-container-high"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="w-8 h-8 rounded-lg bg-surface-container flex items-center justify-center text-primary shrink-0">
                    <Icon name="format_size" size={18} />
                  </span>
                  <div className="flex flex-col min-w-0">
                    <span className="font-body-md text-sm text-on-surface font-medium truncate">
                      排版与字体
                    </span>
                    <span className="font-label-md text-xs text-secondary">衬线字库与基准比例</span>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0 ml-2">
                  <span className="font-label-lg text-xs sm:text-sm text-secondary">
                    {fontFamily === "serif" ? "思源宋体" : "系统黑体"} · {fontSize}px
                  </span>
                  <Icon name="chevron_right" size={16} className="text-outline-variant" />
                </div>
              </button>

              <div className="h-[1px] bg-surface-container mx-4" />

              {/* Row 2: 纸质翻页动效 */}
              <button
                type="button"
                onClick={() => setActiveModal("animation")}
                className="w-full flex items-center justify-between px-4 py-3 text-left transition-colors hover:bg-surface-container active:bg-surface-container-high"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="w-8 h-8 rounded-lg bg-surface-container flex items-center justify-center text-primary shrink-0">
                    <Icon name="auto_stories" size={18} />
                  </span>
                  <div className="flex flex-col min-w-0">
                    <span className="font-body-md text-sm text-on-surface font-medium truncate">
                      纸质翻页动效
                    </span>
                    <span className="font-label-md text-xs text-secondary">仿真弯折与平滑过场</span>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0 ml-2">
                  <span className="font-label-lg text-xs sm:text-sm text-secondary">
                    {pageTurnLabels[pageTurnEffect]}
                  </span>
                  <Icon name="chevron_right" size={16} className="text-outline-variant" />
                </div>
              </button>

              <div className="h-[1px] bg-surface-container mx-4" />

              {/* Row 3: 页面边距与行距 */}
              <div className="px-4 py-3 flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="w-8 h-8 rounded-lg bg-surface-container flex items-center justify-center text-primary shrink-0">
                    <Icon name="space_bar" size={18} />
                  </span>
                  <div className="flex flex-col min-w-0">
                    <span className="font-body-md text-sm text-on-surface font-medium truncate">
                      阅读正文行距
                    </span>
                    <span className="font-label-md text-xs text-secondary">版芯呼吸感倍率</span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  {[1.6, 1.8, 2.0].map((lh) => (
                    <Button
                      key={lh}
                      type="button"
                      variant={lineHeight === lh ? "default" : "secondary"}
                      size="sm"
                      onClick={() => setLineHeight(lh)}
                      className={`h-7 px-2 text-xs ${
                        lineHeight === lh
                          ? "bg-primary text-on-primary"
                          : "bg-surface-container text-secondary hover:text-on-surface"
                      }`}
                    >
                      {lh}x
                    </Button>
                  ))}
                </div>
              </div>
            </Card>
          </section>

          {/* Group 2: 外观与纸张色调 */}
          <section className="flex flex-col space-y-1.5">
            <h3 className="font-label-caps text-[11px] text-secondary px-1 uppercase tracking-wider">
              外观与纸张色调
            </h3>
            <Card className="bg-surface-container-low rounded-xl p-4 space-y-4 shadow-sm border-transparent ring-0">
              {/* Appearance Mode Selector */}
              <div className="flex flex-col space-y-2">
                <span className="font-body-md text-sm text-on-surface font-medium">界面外观</span>
                <div className="grid grid-cols-3 gap-1.5 bg-surface-container p-1 rounded-lg">
                  {(["system", "light", "dark"] as ThemeMode[]).map((mode) => {
                    const isSelected = theme === mode;
                    return (
                      <Button
                        key={mode}
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-pressed={isSelected}
                        onClick={() => setTheme(mode)}
                        className={`h-8 px-1 text-xs rounded-md transition-all text-center flex items-center justify-center gap-1 ${
                          isSelected
                            ? "bg-surface text-primary font-semibold shadow-sm"
                            : "text-secondary hover:text-on-surface hover:bg-transparent"
                        }`}
                      >
                        {isSelected && (
                          <span className="w-1.5 h-1.5 rounded-full bg-primary inline-block shrink-0" />
                        )}
                        <span className="truncate">
                          {mode === "system"
                            ? "跟随系统"
                            : mode === "light"
                              ? "浅色模式"
                              : "深色模式"}
                        </span>
                      </Button>
                    );
                  })}
                </div>
              </div>

              <div className="h-[1px] bg-surface-container" />

              {/* Paper Swatches */}
              <div className="flex flex-col space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-body-md text-sm text-on-surface font-medium">
                    墨韵纸感色调
                  </span>
                  <span className="font-label-md text-xs text-primary font-medium">
                    {paperToneLabels[paperTone]}
                  </span>
                </div>

                <div className="grid grid-cols-4 gap-2">
                  {/* Swatch 1: 柔雅暖茶 */}
                  <button
                    type="button"
                    onClick={() => {
                      setPaperTone("warm-tea");
                    }}
                    className={`flex flex-col items-center p-1.5 sm:p-2 rounded-xl bg-[#fbf8f1] dark:bg-[#25221e] border border-amber-900/10 dark:border-amber-100/10 transition-transform active:scale-95 shadow-xs ${
                      paperTone === "warm-tea" ? "ring-2 ring-[#925429] dark:ring-[#d49960]" : ""
                    }`}
                  >
                    <div className="w-full h-7 sm:h-8 rounded-lg bg-[#eee5d8] dark:bg-[#342e27] flex items-center justify-center mb-1">
                      {paperTone === "warm-tea" && (
                        <Icon
                          name="check"
                          size={15}
                          className="text-[#925429] dark:text-[#d49960] font-bold"
                        />
                      )}
                    </div>
                    <span
                      className={`font-label-caps text-[11px] ${
                        paperTone === "warm-tea"
                          ? "text-[#925429] dark:text-[#d49960] font-semibold"
                          : "text-secondary"
                      }`}
                    >
                      暖茶
                    </span>
                  </button>

                  {/* Swatch 2: 羊脂白 */}
                  <button
                    type="button"
                    onClick={() => {
                      setPaperTone("bone-white");
                    }}
                    className={`flex flex-col items-center p-1.5 sm:p-2 rounded-xl bg-[#faf8f5] dark:bg-[#1f2124] border border-slate-900/10 dark:border-slate-100/10 transition-transform active:scale-95 shadow-xs ${
                      paperTone === "bone-white" ? "ring-2 ring-[#2a3b4c] dark:ring-[#96aec6]" : ""
                    }`}
                  >
                    <div className="w-full h-7 sm:h-8 rounded-lg bg-[#eae6df] dark:bg-[#2f333a] flex items-center justify-center mb-1">
                      {paperTone === "bone-white" && (
                        <Icon
                          name="check"
                          size={15}
                          className="text-[#2a3b4c] dark:text-[#96aec6] font-bold"
                        />
                      )}
                    </div>
                    <span
                      className={`font-label-caps text-[11px] ${
                        paperTone === "bone-white"
                          ? "text-[#2a3b4c] dark:text-[#96aec6] font-semibold"
                          : "text-secondary"
                      }`}
                    >
                      脂白
                    </span>
                  </button>

                  {/* Swatch 3: 宣纸微黄 */}
                  <button
                    type="button"
                    onClick={() => {
                      setPaperTone("xuan-paper");
                    }}
                    className={`flex flex-col items-center p-1.5 sm:p-2 rounded-xl bg-[#f4ede1] dark:bg-[#252019] border border-orange-950/10 dark:border-orange-100/10 transition-transform active:scale-95 shadow-xs ${
                      paperTone === "xuan-paper" ? "ring-2 ring-[#a43d24] dark:ring-[#cc745a]" : ""
                    }`}
                  >
                    <div className="w-full h-7 sm:h-8 rounded-lg bg-[#e6d8c2] dark:bg-[#383025] flex items-center justify-center mb-1">
                      {paperTone === "xuan-paper" && (
                        <Icon
                          name="check"
                          size={15}
                          className="text-[#a43d24] dark:text-[#cc745a] font-bold"
                        />
                      )}
                    </div>
                    <span
                      className={`font-label-caps text-[11px] ${
                        paperTone === "xuan-paper"
                          ? "text-[#a43d24] dark:text-[#cc745a] font-semibold"
                          : "text-secondary"
                      }`}
                    >
                      微黄
                    </span>
                  </button>

                  {/* Swatch 4: 墨绿温润 */}
                  <button
                    type="button"
                    onClick={() => {
                      setPaperTone("jade-green");
                    }}
                    className={`flex flex-col items-center p-1.5 sm:p-2 rounded-xl bg-[#edf1eb] dark:bg-[#1b231d] border border-emerald-950/10 dark:border-emerald-100/10 transition-transform active:scale-95 shadow-xs ${
                      paperTone === "jade-green" ? "ring-2 ring-[#225e41] dark:ring-[#6ab38a]" : ""
                    }`}
                  >
                    <div className="w-full h-7 sm:h-8 rounded-lg bg-[#d5e0d3] dark:bg-[#28352c] flex items-center justify-center mb-1">
                      {paperTone === "jade-green" && (
                        <Icon
                          name="check"
                          size={15}
                          className="text-[#225e41] dark:text-[#6ab38a] font-bold"
                        />
                      )}
                    </div>
                    <span
                      className={`font-label-caps text-[11px] ${
                        paperTone === "jade-green"
                          ? "text-[#225e41] dark:text-[#6ab38a] font-semibold"
                          : "text-secondary"
                      }`}
                    >
                      温绿
                    </span>
                  </button>
                </div>
              </div>

              <div className="h-[1px] bg-surface-container" />

              {/* OLED Black Switch using shadcn Switch */}
              <div className="flex items-center justify-between">
                <div className="flex flex-col min-w-0 pr-3">
                  <span className="font-body-md text-sm text-on-surface font-medium">
                    纯黑夜间背景
                  </span>
                  <span className="font-label-md text-xs text-secondary">
                    关闭底层泛光，深度适配 OLED 屏幕省电
                  </span>
                </div>
                <Switch
                  aria-label="OLED 纯黑背景"
                  checked={isOledBlack}
                  onCheckedChange={setIsOledBlack}
                />
              </div>
            </Card>
          </section>

          {/* Group 3: 书籍与存储 */}
          <section className="flex flex-col space-y-1.5">
            <h3 className="font-label-caps text-[11px] text-secondary px-1 uppercase tracking-wider">
              书籍与存储
            </h3>
            <Card className="bg-surface-container-low rounded-xl overflow-hidden shadow-sm border-transparent ring-0 p-0">
              {/* Row 1: 本地书源 */}
              <button
                type="button"
                disabled
                className="w-full flex items-center justify-between px-4 py-3 text-left transition-colors hover:bg-surface-container opacity-60 cursor-not-allowed"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="w-8 h-8 rounded-lg bg-surface-container flex items-center justify-center text-primary shrink-0">
                    <Icon name="folder_open" size={18} />
                  </span>
                  <div className="flex flex-col min-w-0">
                    <span className="font-body-md text-sm text-on-surface font-medium truncate">
                      本地书源与目录
                    </span>
                    <span className="font-label-md text-xs text-secondary">
                      TXT / EPUB 关联存储路径
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0 ml-2">
                  <Icon name="chevron_right" size={16} className="text-outline-variant" />
                </div>
              </button>

              <div className="h-[1px] bg-surface-container mx-4" />

              {/* Row 2: WebDAV */}
              <button
                type="button"
                disabled
                className="w-full flex items-center justify-between px-4 py-3 text-left transition-colors hover:bg-surface-container opacity-60 cursor-not-allowed"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="w-8 h-8 rounded-lg bg-surface-container flex items-center justify-center text-primary shrink-0">
                    <Icon name="sync" size={18} />
                  </span>
                  <div className="flex flex-col min-w-0">
                    <span className="font-body-md text-sm text-on-surface font-medium truncate">
                      WebDAV 局域网备份
                    </span>
                    <span className="font-label-md text-xs text-secondary">
                      自建 NAS / 私有网盘书签快照
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0 ml-2">
                  <Icon name="chevron_right" size={16} className="text-outline-variant" />
                </div>
              </button>

              <div className="h-[1px] bg-surface-container mx-4" />

              {/* Row 3: 离线缓存 */}
              <button
                type="button"
                disabled
                className="w-full flex items-center justify-between px-4 py-3 text-left transition-colors hover:bg-surface-container opacity-60 cursor-not-allowed"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="w-8 h-8 rounded-lg bg-surface-container flex items-center justify-center text-primary shrink-0">
                    <Icon name="pie_chart" size={18} />
                  </span>
                  <div className="flex flex-col min-w-0">
                    <span className="font-body-md text-sm text-on-surface font-medium truncate">
                      离线缓存管理
                    </span>
                    <span className="font-label-md text-xs text-secondary">
                      预解析章节索引与字形缓存
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0 ml-2">
                  <Icon name="chevron_right" size={16} className="text-outline-variant" />
                </div>
              </button>
            </Card>
          </section>

          {/* Group 4: 关于与版本 */}
          <section className="flex flex-col space-y-1.5">
            <h3 className="font-label-caps text-[11px] text-secondary px-1 uppercase tracking-wider">
              关于
            </h3>
            <Card className="bg-surface-container-low rounded-xl p-4 shadow-sm flex flex-row items-center justify-between border-transparent ring-0">
              <div className="flex items-center gap-3 min-w-0">
                <span className="w-8 h-8 rounded-lg bg-surface-container flex items-center justify-center text-primary shrink-0">
                  <Icon name="auto_stories" size={18} />
                </span>
                <div className="flex flex-col min-w-0">
                  <span className="font-body-md text-sm text-on-surface font-medium truncate">
                    手不释卷 · GripRead
                  </span>
                  <span className="font-label-md text-xs text-secondary">v0.1.0 · 极简无干扰</span>
                </div>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled
                className="text-xs text-primary h-7 px-2.5 rounded-lg bg-surface-container shrink-0 opacity-60 cursor-not-allowed"
              >
                检查更新
              </Button>
            </Card>
          </section>
        </div>

        {/* Philosophy Signoff */}
        <div className="flex flex-col items-center justify-center text-center pt-4 pb-2 space-y-1 text-secondary opacity-75">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-5 h-[1px] bg-outline-variant" />
            <Icon name="bookmark" size={13} className="text-primary" />
            <div className="w-5 h-[1px] bg-outline-variant" />
          </div>
          <p className="font-title-editorial text-sm text-on-surface tracking-wide font-semibold">
            心澄神静 · 专注字里行间
          </p>
          <p className="font-label-caps text-[10px] text-secondary">
            LOCAL FIRST · DISTRACTION-FREE NOVEL SANCTUARY
          </p>
        </div>
        <p role="status" className="text-xs text-secondary text-center">
          {state.saving
            ? "正在保存偏好设置…"
            : state.error
              ? "偏好设置尚未保存"
              : "偏好设置已保存到本地"}
        </p>
      </main>

      {/* Typography Dialog */}
      <Dialog
        open={activeModal === "typography"}
        onOpenChange={(open) => !open && setActiveModal(null)}
      >
        <DialogContent className="bg-surface border-surface-variant/50 max-w-sm w-[calc(100%-2rem)] rounded-2xl p-5 space-y-4">
          <DialogHeader className="text-left">
            <DialogTitle className="font-title-editorial text-base font-semibold text-on-surface">
              排版与字体设置
            </DialogTitle>
            <DialogDescription className="text-xs text-secondary">
              设置自动保存；减少动态效果时使用即时翻页。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 text-xs text-left">
            <div>
              <label className="text-secondary block mb-1.5 font-medium">字体选择</label>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant={fontFamily === "serif" ? "default" : "outline"}
                  onClick={() => setFontFamily("serif")}
                  className={`h-9 text-xs justify-center ${
                    fontFamily === "serif"
                      ? "bg-primary text-on-primary"
                      : "border-surface-variant/50 bg-surface-container text-secondary"
                  }`}
                >
                  思源宋体 (Serif)
                </Button>
                <Button
                  type="button"
                  variant={fontFamily === "sans" ? "default" : "outline"}
                  onClick={() => setFontFamily("sans")}
                  className={`h-9 text-xs justify-center ${
                    fontFamily === "sans"
                      ? "bg-primary text-on-primary"
                      : "border-surface-variant/50 bg-surface-container text-secondary"
                  }`}
                >
                  系统黑体 (Sans)
                </Button>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-secondary font-medium">字号大小</label>
                <span className="text-primary font-semibold">{fontSize}px</span>
              </div>
              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  onClick={() => setFontSize((s) => Math.max(14, s - 1))}
                  className="w-8 h-8 rounded-lg bg-surface-container text-secondary hover:text-on-surface shrink-0"
                >
                  A-
                </Button>
                <div className="flex-1 py-1">
                  <Slider
                    aria-label="字号"
                    min={14}
                    max={32}
                    step={1}
                    value={fontSize}
                    onValueChange={(val) => {
                      if (typeof val === "number") setFontSize(val);
                      else if (Array.isArray(val) && val.length > 0) setFontSize(val[0]);
                    }}
                  />
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  onClick={() => setFontSize((s) => Math.min(32, s + 1))}
                  className="w-8 h-8 rounded-lg bg-surface-container text-secondary hover:text-on-surface shrink-0"
                >
                  A+
                </Button>
              </div>
            </div>
          </div>

          <DialogFooter className="pt-2">
            <Button
              type="button"
              onClick={() => setActiveModal(null)}
              className="w-full bg-primary text-on-primary text-xs h-9"
            >
              完成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Page Turn Animation Dialog */}
      <Dialog
        open={activeModal === "animation"}
        onOpenChange={(open) => !open && setActiveModal(null)}
      >
        <DialogContent className="bg-surface border-surface-variant/50 max-w-sm w-[calc(100%-2rem)] rounded-2xl p-5 space-y-4">
          <DialogHeader className="text-left">
            <DialogTitle className="font-title-editorial text-base font-semibold text-on-surface">
              纸质翻页动效
            </DialogTitle>
            <DialogDescription className="text-xs text-secondary">
              设置自动保存；减少动态效果时使用即时翻页。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 text-left">
            {(
              [
                { id: "curl", name: "平滑仿真翻页", desc: "仿纸张弯折拟态物理阴影" },
                { id: "slide", name: "平滑滑动切换", desc: "横向顺畅跟手位移" },
                { id: "instant", name: "极简无动效", desc: "瞬时切页，降低视觉疲劳" },
                { id: "scroll", name: "连续纵向滚动", desc: "类似长网页纵向阅读" },
              ] as const
            ).map((item) => (
              <Button
                key={item.id}
                disabled={item.id === "slide" || item.id === "scroll"}
                aria-pressed={pageTurnEffect === item.id}
                type="button"
                variant="ghost"
                onClick={() => {
                  if (item.id === "instant" || item.id === "curl") setPageTurnEffect(item.id);

                  setActiveModal(null);
                }}
                className={`w-full p-3 h-auto rounded-xl text-left flex items-center justify-between transition-all ${
                  pageTurnEffect === item.id
                    ? "bg-surface-container ring-1 ring-primary text-primary"
                    : "bg-surface-container-low text-secondary hover:bg-surface-container"
                }`}
              >
                <div>
                  <p className="text-xs font-medium text-on-surface">{item.name}</p>
                  <p className="text-[11px] text-secondary mt-0.5">{item.desc}</p>
                </div>
                {pageTurnEffect === item.id && (
                  <Icon name="check" size={16} className="text-primary" />
                )}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
