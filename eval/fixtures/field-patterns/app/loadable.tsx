import { Suspense, type ComponentType, type LazyExoticComponent } from "react";

/** The field app's code-splitting helper: every page element goes through it. */
export function Loadable(Component: LazyExoticComponent<ComponentType>) {
  return function LoadableWrapper() {
    return (
      <Suspense fallback={<div>Loading…</div>}>
        <Component />
      </Suspense>
    );
  };
}
