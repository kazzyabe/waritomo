export async function runStartup({ app, loadingScreen, initialize, onError }) {
  app.hidden = true;
  app.inert = true;
  app.setAttribute("aria-busy", "true");
  loadingScreen.hidden = false;

  try {
    await initialize();
  } catch (error) {
    onError(error);
  } finally {
    // Also reveal the existing sign-in / storage error screen on failure.
    loadingScreen.hidden = true;
    app.hidden = false;
    app.inert = false;
    app.setAttribute("aria-busy", "false");
  }
}

export async function requestStartupFriendship(liff) {
  try {
    if (
      !liff?.isInClient?.() ||
      !liff.isLoggedIn?.() ||
      typeof liff.requestFriendship !== "function" ||
      !liff.isApiAvailable?.("requestFriendship")
    ) return;

    const friendship = typeof liff.getFriendship === "function"
      ? await liff.getFriendship().catch(() => null)
      : null;
    if (friendship?.friendFlag) return;

    // No parameters uses the linked official account and LINE's minimal
    // default confirmation. Resolution does not mean the user added it.
    await liff.requestFriendship();
  } catch {
    // An optional invitation must never prevent loading or using the app.
  }
}
