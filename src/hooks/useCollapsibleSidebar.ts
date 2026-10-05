import { useCallback, useEffect, useState } from "react";

// Below this width the labeled sidebar is an overlay drawer, not a persistent column.
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
  const narrow = useNarrowWindow();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (!narrow) setDrawerOpen(false);
  }, [narrow]);

  const toggle = useCallback(() => {
    setDrawerOpen((value) => !value);
  }, []);

  const close = useCallback(() => {
    setDrawerOpen(false);
  }, []);

  return { narrow, drawerOpen, toggle, close };
}
