export type RootTabPath = "/" | "/search" | "/library";

export function shouldNavigateToTabRoot(
  pathname: string,
  targetPath: RootTabPath,
  hasDismissibleRoute: boolean,
): boolean {
  // A pushed screen still needs both the stack unwind and an explicit tab
  // selection because the highlighted tab may not be the tab underneath it.
  if (hasDismissibleRoute) return true;

  // Re-selecting an already-focused root only creates a new navigation-state
  // object and re-renders the mounted screen. Keep the existing instance still.
  return pathname !== targetPath;
}
