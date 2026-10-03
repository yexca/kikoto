(() => {
  const storedMode = localStorage.getItem("kikoto:theme");
  const mode = storedMode === "light" || storedMode === "dark" || storedMode === "system" ? storedMode : "system";
  const storedPreset = localStorage.getItem("kikoto:theme-preset");
  const preset =
    storedPreset === "claude"
      ? "anthropic"
      : storedPreset === "anthropic" ||
          storedPreset === "openai" ||
          storedPreset === "apple" ||
          storedPreset === "google-md"
        ? storedPreset
        : "anthropic";
  const storedPalette = localStorage.getItem("kikoto:theme-palette");
  const palette =
    storedPalette === "original" ||
    storedPalette === "graphite" ||
    storedPalette === "cobalt" ||
    storedPalette === "iris"
      ? storedPalette
      : "original";
  const dark = mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.themePreset = preset;
  document.documentElement.dataset.themePalette = palette;
  const themeColors = {
    anthropic: { light: "#f7f3ed", dark: "#1a1715" },
    openai: { light: "#fafafa", dark: "#141414" },
    apple: { light: "#f2f2f7", dark: "#111112" },
    "google-md": { light: "#f8fafd", dark: "#121316" },
  };
  document.querySelector('meta[name="theme-color"]').content = themeColors[preset][dark ? "dark" : "light"];
})();
