import { useApp, type NavTab } from "../../context/AppContext";
import { Icon } from "../ui/Icon";

interface TabItem {
  id: NavTab;
  label: string;
  icon: string;
}

const TABS: TabItem[] = [
  { id: "bookshelf", label: "书架", icon: "auto_stories" },
  { id: "discover", label: "发现", icon: "explore" },
  { id: "subscription", label: "订阅", icon: "collections_bookmark" },
  { id: "settings", label: "设置", icon: "tune" },
];

export function Navbar() {
  const { activeTab, setActiveTab, activeBook } = useApp();

  // If reader is open, navigation is hidden
  if (activeBook) return null;

  return (
    <>
      {/* Mobile Apple-style Floating Island Dock */}
      <nav
        className="glass-dock fixed bottom-4 inset-x-4 max-w-sm mx-auto z-40 rounded-full md:hidden transition-all duration-200 pointer-events-auto select-none"
        aria-label="Mobile Navigation Dock"
      >
        <div className="flex items-center justify-around h-[60px] px-2 py-1">
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                aria-current={isActive ? "page" : undefined}
                className={`relative flex flex-col items-center justify-center min-w-[58px] py-1 rounded-full transition-all duration-200 active:scale-95 ${
                  isActive ? "text-primary font-medium" : "text-secondary hover:text-on-surface"
                }`}
              >
                <div
                  className={`flex items-center justify-center w-9 h-7 rounded-full transition-all duration-200 ${
                    isActive ? "bg-primary-fixed/30" : ""
                  }`}
                >
                  <Icon name={tab.icon} size={22} fill={isActive} />
                </div>
                <span className="font-label-md text-[11px] mt-0.5 tracking-tight">{tab.label}</span>
                {isActive && (
                  <span className="absolute -bottom-0.5 w-1 h-1 rounded-full bg-primary" />
                )}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Desktop Left Sidebar */}
      <aside
        className="hidden md:flex flex-col w-64 h-screen fixed top-0 left-0 glass-sidebar z-40 p-6 select-none"
        aria-label="Desktop Sidebar"
      >
        <div className="flex items-center gap-3 mb-8 px-2">
          <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center text-on-primary shadow-sm">
            <Icon name="auto_stories" size={22} fill />
          </div>
          <div>
            <h1 className="font-title-editorial text-xl font-semibold tracking-tight text-on-surface">
              手不释卷
            </h1>
            <p className="font-label-caps text-secondary text-[11px] tracking-wider uppercase">
              GripRead · 本地优先
            </p>
          </div>
        </div>

        <nav className="flex-1 space-y-1.5">
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-3.5 px-4 py-3 rounded-xl transition-all text-left ${
                  isActive
                    ? "bg-primary/10 text-primary font-medium shadow-xs"
                    : "text-secondary hover:bg-surface-container/50 hover:text-on-surface"
                }`}
              >
                <Icon name={tab.icon} size={22} fill={isActive} />
                <span className="font-body-md text-sm">{tab.label}</span>
                {isActive && <div className="ml-auto w-1.5 h-1.5 rounded-full bg-primary" />}
              </button>
            );
          })}
        </nav>

        <div className="pt-4 border-t border-surface-variant/30 px-2 text-secondary text-xs opacity-75">
          <p className="font-title-editorial text-on-surface/90">心澄神静 · 专注字里行间</p>
          <p className="mt-1 font-label-caps text-[10px] tracking-wider">
            LOCAL FIRST NOVEL SANCTUARY
          </p>
        </div>
      </aside>
    </>
  );
}
