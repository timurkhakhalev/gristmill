// SSR entry point for renderer-component structure tests. The dictation .tsx
// modules are compiled with the classic JSX runtime under the tsx loader, so
// they resolve React from the global scope instead of importing it.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

globalThis.React = React;

export const renderStatic = (type: unknown, props: unknown, ...children: unknown[]): string =>
  renderToStaticMarkup(
    React.createElement(
      type as React.ElementType,
      props as React.Attributes,
      ...(children as React.ReactNode[])
    )
  );

export { React };
