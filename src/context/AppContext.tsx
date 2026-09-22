import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { useShelfPreferences } from "../application/runtime";
import type { ShelfSort, LibraryBook } from "../types/generated";
export type NavTab = "bookshelf" | "discover" | "subscription" | "settings";
export interface ShelfViewState {
  query: string;
  groupId: string;
  layout: "list" | "grid";
  scroll: number;
  sort: ShelfSort;
}
interface Navigation {
  activeTab: NavTab;
  setActiveTab: (tab: NavTab) => void;
  activeBook: LibraryBook | null;
  openReader: (book: LibraryBook) => void;
  closeReader: () => void;
  shelf: ShelfViewState;
  setShelf: (patch: Partial<ShelfViewState>) => void;
}
const Context = createContext<Navigation | null>(null);
export function AppProvider({ children }: { children: ReactNode }) {
  const [activeTab, setActiveTab] = useState<NavTab>("bookshelf");
  const [activeBook, setActiveBook] = useState<LibraryBook | null>(null);
  const { state: preferences, store } = useShelfPreferences();
  const [transient, setTransient] = useState({ query: "", scroll: 0 });
  useEffect(() => {
    void store.load();
  }, [store]);
  const shelf: ShelfViewState = {
    ...transient,
    ...(preferences.value ?? { groupId: "all", layout: "list", sort: "recent_read" }),
  };
  const setShelf = (patch: Partial<ShelfViewState>) => {
    if (patch.query !== undefined || patch.scroll !== undefined)
      setTransient((prev) => ({
        query: patch.query ?? prev.query,
        scroll: patch.scroll ?? prev.scroll,
      }));
    if (patch.layout !== undefined || patch.groupId !== undefined || patch.sort !== undefined)
      store.set({
        layout: patch.layout ?? shelf.layout,
        groupId: patch.groupId ?? shelf.groupId,
        sort: patch.sort ?? shelf.sort,
      });
  };
  return (
    <Context.Provider
      value={{
        activeTab,
        setActiveTab,
        activeBook,
        openReader: (book) => {
          setShelf({ scroll: window.scrollY });
          setActiveBook(book);
        },
        closeReader: () => setActiveBook(null),
        shelf,
        setShelf,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useApp() {
  const value = useContext(Context);
  if (!value) throw new Error("AppProvider is required");
  return value;
}
