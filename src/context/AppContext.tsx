import { createContext, useContext, useState, type ReactNode } from "react";
import type { LibraryBook } from "../types/generated";
export type NavTab = "bookshelf" | "discover" | "subscription" | "settings";
export interface ShelfViewState {
  query: string;
  groupId: string;
  layout: "list" | "grid";
  scroll: number;
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
  const [shelf, setShelfState] = useState<ShelfViewState>({
    query: "",
    groupId: "all",
    layout: "list",
    scroll: 0,
  });
  const setShelf = (patch: Partial<ShelfViewState>) =>
    setShelfState((prev) => ({ ...prev, ...patch }));
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
