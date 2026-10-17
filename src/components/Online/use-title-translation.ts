import { useContext, useEffect, useRef, useState } from "react";
import { RuntimeContext } from "../../application/runtime";
import { sameLanguage } from "../../application/translation";
import { t } from "../../i18n";
import { describeError } from "../Cloud/format";
import { toast } from "../ui/toast";

/**
 * 翻译 on a list of books (搜索, 发现): while on, the titles shown are
 * translated with the default engine, those arriving later too, until
 * 显示原文. Titles already in the target language keep their own.
 */
export function useTitleTranslation(titles: readonly string[]) {
  // Pages shown without the app's runtime (some tests) simply cannot translate.
  const service = useContext(RuntimeContext)?.services.translation;
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [translated, setTranslated] = useState<ReadonlyMap<string, string | null>>(new Map());
  const asked = useRef(new Set<string>());

  useEffect(() => {
    if (!on || !service) return;
    const wanted = [...new Set(titles)].filter((title) => title && !asked.current.has(title));
    if (!wanted.length) return;
    for (const title of wanted) asked.current.add(title);
    setBusy(true);
    void service
      .translateTexts(wanted)
      .then(
        (answers) =>
          setTranslated((current) => {
            const next = new Map(current);
            wanted.forEach((title, index) => next.set(title, answers[index] ?? null));
            return next;
          }),
        (failure: unknown) => {
          for (const title of wanted) asked.current.delete(title);
          toast({ text: describeError(failure), error: true });
        },
      )
      .finally(() => setBusy(false));
  }, [on, titles, service]);

  const toggle = () => {
    if (on || !service) {
      setOn(false);
      return;
    }
    void service.getSettings().then(
      (settings) => {
        if (!settings.engines.length)
          toast({ text: t("translation.book.needEngine"), error: true });
        else setOn(true);
      },
      (failure: unknown) => toast({ text: describeError(failure), error: true }),
    );
  };

  return {
    on,
    busy,
    toggle,
    /** The title's translation while on, when it has one. */
    title: (original: string): string | undefined =>
      on ? (translated.get(original) ?? undefined) : undefined,
  };
}

/**
 * 翻译简介 on a book's details: the introduction's translation while on,
 * asked for once, with 显示原文 back.
 */
export function useIntroTranslation(intro: string | null | undefined) {
  const service = useContext(RuntimeContext)?.services.translation;
  const [translated, setTranslated] = useState<{ intro: string; text: string | null } | null>(null);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  // 翻译简介 is offered only for an introduction in another language.
  const [foreign, setForeign] = useState<boolean | null>(null);
  useEffect(() => {
    setForeign(null);
    if (!service || !intro?.trim()) return;
    let active = true;
    void Promise.all([service.getSettings(), service.detectLanguages([intro])]).then(
      ([settings, [language]]) => {
        if (!active) return;
        const same = Boolean(language) && sameLanguage(language, settings.target);
        setForeign(!same);
      },
      () => active && setForeign(true),
    );
    return () => {
      active = false;
    };
  }, [service, intro]);
  const current = translated && translated.intro === intro ? translated.text : undefined;
  const toggle = () => {
    if (on || !service || !intro) {
      setOn(false);
      return;
    }
    if (current !== undefined) {
      setOn(true);
      return;
    }
    setBusy(true);
    void service
      .getSettings()
      .then((settings) => {
        if (!settings.engines.length) {
          toast({ text: t("translation.book.needEngine"), error: true });
          return;
        }
        return service.translateTexts([intro]).then(([text]) => {
          setTranslated({ intro, text: text ?? null });
          if (text) setOn(true);
          else toast({ text: t("translation.intro.same") });
        });
      })
      .catch((failure: unknown) => toast({ text: describeError(failure), error: true }))
      .finally(() => setBusy(false));
  };
  return {
    available: Boolean(service && intro && foreign),
    on,
    busy,
    toggle,
    text: on && current ? current : (intro ?? ""),
  };
}

/** The 翻译简介 button's label for its state. */
export function introLabel(intro: { on: boolean; busy: boolean }): string {
  if (intro.busy) return t("translation.titles.busy");
  return intro.on ? t("translation.titles.original") : t("translation.intro.translate");
}
