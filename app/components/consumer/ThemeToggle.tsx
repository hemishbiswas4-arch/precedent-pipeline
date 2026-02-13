"use client";

type ThemeMode = "light" | "dark";

export function ThemeToggle(props: {
  theme: ThemeMode;
  onToggle: () => void;
}) {
  const { theme, onToggle } = props;
  const nextThemeLabel = theme === "light" ? "Dark" : "Light";
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={`Switch to ${nextThemeLabel} mode`}
      onClick={onToggle}
    >
      <span className="theme-icon" aria-hidden="true">
        {theme === "light" ? "☀" : "☾"}
      </span>
      <span>{nextThemeLabel} mode</span>
    </button>
  );
}
