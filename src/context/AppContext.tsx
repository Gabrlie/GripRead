import { createContext, useContext, useState, useEffect, useRef, type ReactNode } from "react";
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
  /** Opens a book, optionally straight on its contents page. */
  openReader: (book: LibraryBook, page?: "contents") => void;
  /** The page to open with the book, once; the reader takes it on mount. */
  takeReaderPage: () => "contents" | null;
  /** Leaves the reader; `toDetail` reopens the book's detail page. */
  closeReader: (toDetail?: boolean) => void;
  /** The book whose detail page the shelf reopens, once. */
  takeDetailReturn: () => LibraryBook | null;
  shelf: ShelfViewState;
  setShelf: (patch: Partial<ShelfViewState>) => void;
}
const Context = createContext<Navigation | null>(null);
export function AppProvider({ children }: { children: ReactNode }) {
  const [activeTab, setActiveTab] = useState<NavTab>("bookshelf");
  const [activeBook, setActiveBook] = useState<LibraryBook | null>(null);
  const readerPage = useRef<"contents" | null>(null);
  const detailReturn = useRef<LibraryBook | null>(null);
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
        openReader: (book, page) => {
          setShelf({ scroll: window.scrollY });
          readerPage.current = page ?? null;
          setActiveBook(book);
        },
        takeReaderPage: () => {
          const page = readerPage.current;
          readerPage.current = null;
          return page;
        },
        closeReader: (toDetail) => {
          detailReturn.current = toDetail ? activeBook : null;
          setActiveBook(null);
        },
        takeDetailReturn: () => {
          const book = detailReturn.current;
          detailReturn.current = null;
          return book;
        },
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
