import { useCallback, useEffect, useRef, useState } from "react";

const PEEK_CLOSE_DELAY_MS = 120;
// Below this window width the sidebar rests as a rail so the content keeps its column.
const NARROW_QUERY = "(max-width: 899px)";

function useNarrowWindow() {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY);
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

export function useCollapsibleSidebar() {
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("sidebarCollapsed") === "true"
  );
  const narrow = useNarrowWindow();
  // Expanding while narrow is temporary and never overwrites the saved preference.
  const [narrowExpanded, setNarrowExpanded] = useState(false);
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressPeek = useRef(false);

  const toggle = useCallback(() => {
    clearTimeout(peekTimer.current);
    setPeek(false);
    if (narrow) {
      setNarrowExpanded((value) => !value);
      return;
    }
    const next = !collapsed;
    suppressPeek.current = next;
    localStorage.setItem("sidebarCollapsed", String(next));
    setCollapsed(next);
  }, [collapsed, narrow]);

  useEffect(() => {
    if (!narrow) setNarrowExpanded(false);
  }, [narrow]);

  const showPeek = useCallback(() => {
    if (suppressPeek.current) return;
    clearTimeout(peekTimer.current);
    setPeek(true);
  }, []);

  const hidePeek = useCallback(() => {
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeek(false), PEEK_CLOSE_DELAY_MS);
  }, []);

  const leaveToggle = useCallback(() => {
    suppressPeek.current = false;
    hidePeek();
  }, [hidePeek]);

  useEffect(() => () => clearTimeout(peekTimer.current), []);

  return { collapsed: narrow ? !narrowExpanded : collapsed, peek, toggle, showPeek, hidePeek, leaveToggle };
}
