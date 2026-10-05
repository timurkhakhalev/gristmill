// SSR entry point for renderer-component structure tests. The dictation .tsx
// modules are compiled with the classic JSX runtime under the tsx loader, so
// they resolve React from the global scope instead of importing it.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

globalThis.React = React;

export const renderStatic = (
  type: React.ElementType,
  // Component props are the component's own contract; createElement accepts
  // them structurally through the any props slot of ElementType.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- props come from the component under test
  props?: any,
  ...children: React.ReactNode[]
): string => renderToStaticMarkup(React.createElement(type, props, ...children));

export { React };
