import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";

import type { Book, ImportStatus } from "./types/generated";
import { tauriReaderService, type ReaderService } from "./services/ipc";
import { ReaderSession } from "./reader/session";

const WINDOW_UNITS = 3200;

const isTerminalImportPhase = (phase: ImportStatus["phase"]) =>
  phase === "completed" || phase === "failed" || phase === "cancelled";

interface AppProps {
  service?: ReaderService;
}

export function App({ service = tauriReaderService }: AppProps) {
  const [path, setPath] = useState("");
  const [books, setBooks] = useState<Book[]>([]);
  const [selectedBook, setSelectedBook] = useState<Book | null>(null);
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null);
  const [message, setMessage] = useState("Connect to the Tauri host to begin.");
  const [windowText, setWindowText] = useState("");
  const [windowInfo, setWindowInfo] = useState("No book opened");
  const sessionRef = useRef<ReaderSession | null>(null);
  const activeImportIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<number | null>(null);

  const stopImportPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const refreshBooks = useCallback(async () => {
    try {
      setBooks(await service.listBooks());
    } catch (error) {
      setMessage(String(error));
    }
  }, [service]);

  useEffect(() => {
    void refreshBooks();
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void service.onImportProgress((status) => {
      if (
        !activeImportIdRef.current ||
        status.operationId === activeImportIdRef.current
      ) {
        setImportStatus(status);
      }
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
      } else {
        unlisten = cleanup;
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
      stopImportPolling();
    };
  }, [refreshBooks, service, stopImportPolling]);

  useEffect(() => {
    if (!importStatus || !isTerminalImportPhase(importStatus.phase)) {
      return;
    }
    if (importStatus.phase === "completed" && importStatus.result) {
      setMessage(importStatus.result.duplicate ? "Existing asset reused." : "TXT imported.");
      void refreshBooks();
    } else if (importStatus.error) {
      setMessage(`${importStatus.error.code}: ${importStatus.error.message}`);
    }
  }, [importStatus, refreshBooks]);

  const importBook = async () => {
    if (!path.trim()) {
      setMessage("Enter a local TXT path first.");
      return;
    }
    try {
      stopImportPolling();
      const task = await service.startImport(path.trim());
      activeImportIdRef.current = task.operationId;
      setMessage(`Import started: ${task.operationId}`);
      const timer = window.setInterval(() => {
        void service
          .getImportStatus(task.operationId)
          .then((status) => {
            if (activeImportIdRef.current !== task.operationId) return;
            setImportStatus(status);
            if (isTerminalImportPhase(status.phase)) stopImportPolling();
          })
          .catch((error) => {
            if (activeImportIdRef.current !== task.operationId) return;
            stopImportPolling();
            setMessage(String(error));
          });
      }, 200);
      pollTimerRef.current = timer;
      window.setTimeout(() => {
        if (pollTimerRef.current === timer) stopImportPolling();
      }, 60_000);
    } catch (error) {
      setMessage(String(error));
    }
  };

  const openBook = async (book: Book) => {
    try {
      sessionRef.current?.dispose();
      const session = new ReaderSession(service);
      sessionRef.current = session;
      const content = await session.open(book.id, WINDOW_UNITS);
      setSelectedBook(book);
      setWindowText(content.text);
      setWindowInfo(`${content.startOffset}–${content.endOffset} / ${content.totalLength}`);
      setMessage("Reader window loaded through typed IPC.");
    } catch (error) {
      setMessage(String(error));
    }
  };

  const turn = async (direction: "next" | "previous") => {
    const session = sessionRef.current;
    if (!session) return;
    try {
      const content = await session.turn(direction, WINDOW_UNITS);
      if (!content) return;
      setWindowText(content.text);
      setWindowInfo(`${content.startOffset}–${content.endOffset} / ${content.totalLength}`);
    } catch (error) {
      setMessage(String(error));
    }
  };

  const savePosition = async () => {
    try {
      await sessionRef.current?.save();
      setMessage("Reader position saved.");
    } catch (error) {
      setMessage(String(error));
    }
  };

  return (
    <main className="smoke-shell">
      <motion.header
        className="smoke-header"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
      >
        <div>
          <p className="eyebrow">M0 LOGIC SMOKE HOST</p>
          <h1>GripRead</h1>
        </div>
        <p className="message" role="status">{message}</p>
      </motion.header>

      <section className="import-panel" aria-label="TXT import">
        <label htmlFor="txt-path">Local UTF-8 TXT path</label>
        <div className="import-controls">
          <input
            id="txt-path"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/path/to/book.txt"
          />
          <button type="button" onClick={() => void importBook()}>Import</button>
          {importStatus && !isTerminalImportPhase(importStatus.phase) && (
            <button
              type="button"
              className="secondary"
              onClick={() => void service.cancelImport(importStatus.operationId)}
            >
              Cancel
            </button>
          )}
        </div>
        {importStatus && (
          <p className="progress">
            {importStatus.phase} · {importStatus.bytesRead}/{importStatus.totalBytes} bytes
          </p>
        )}
      </section>

      <div className="smoke-grid">
        <section className="book-list" aria-label="Imported books">
          <div className="section-title">
            <h2>Local books</h2>
            <button type="button" className="secondary" onClick={() => void refreshBooks()}>Refresh</button>
          </div>
          {books.length === 0 ? (
            <p className="muted">No imported books yet.</p>
          ) : (
            <ul>
              {books.map((book) => (
                <li key={book.id}>
                  <button
                    type="button"
                    className={selectedBook?.id === book.id ? "book selected" : "book"}
                    onClick={() => void openBook(book)}
                  >
                    <span>{book.title}</span>
                    <small>{book.contentVersion.slice(0, 12)}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="reader-panel" aria-label="Reader content window">
          <div className="section-title">
            <div>
              <h2>{selectedBook?.title ?? "Reader window"}</h2>
              <p className="progress">{windowInfo}</p>
            </div>
            <button type="button" className="secondary" onClick={() => void savePosition()}>Save position</button>
          </div>
          <pre className="reader-window">{windowText || "Open an imported book to inspect a content window."}</pre>
          <div className="reader-controls">
            <button type="button" className="secondary" onClick={() => void turn("previous")}>Previous</button>
            <button type="button" onClick={() => void turn("next")}>Next</button>
          </div>
        </section>
      </div>
    </main>
  );
}
