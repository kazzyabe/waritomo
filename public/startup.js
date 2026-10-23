function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

export async function runStartup({ app, loadingScreen, initialize, onError, afterReady, waitForPaint = nextPaint }) {
  app.hidden = true;
  app.inert = true;
  app.setAttribute("aria-busy", "true");
  loadingScreen.hidden = false;

  let initialized = false;
  try {
    await initialize();
    initialized = true;
  } catch (error) {
    onError(error);
  } finally {
    // Also reveal the existing sign-in / storage error screen on failure.
    loadingScreen.hidden = true;
    app.hidden = false;
    app.inert = false;
    app.setAttribute("aria-busy", "false");
  }

  if (initialized && afterReady) {
    // Let the revealed home screen paint before asking LINE to open a window.
    await waitForPaint();
    void afterReady();
  }
}

export async function requestStartupFriendship(liff) {
  try {
    if (!liff?.isInClient?.()) return "external";
    if (!liff.isLoggedIn?.()) return "signed-out";

    const friendship = typeof liff.getFriendship === "function"
      ? await liff.getFriendship().catch(() => null)
      : null;
    if (friendship?.friendFlag) return "already-friend";

    if (
      typeof liff.requestFriendship !== "function" ||
      !liff.isApiAvailable?.("requestFriendship")
    ) return "unsupported";

    // No parameters uses the linked official account and LINE's minimal
    // default confirmation. Resolution does not mean the user added it.
    await liff.requestFriendship();
    return "requested";
  } catch (error) {
    // An optional invitation must never prevent loading or using the app.
    console.warn("LINE friendship confirmation unavailable", error?.code || "unknown");
    return "failed";
  }
}
