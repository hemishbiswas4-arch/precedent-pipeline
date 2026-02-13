"use client";

import { ThemeToggle } from "@/app/components/consumer/ThemeToggle";

type ThemeMode = "light" | "dark";

export function HeroHeader(props: {
  showAdvanced: boolean;
  onToggleAdvanced: () => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
}) {
  const { showAdvanced, onToggleAdvanced, theme, onToggleTheme } = props;
  return (
    <section className="hero-section surface-panel reveal-up">
      <div className="hero-meta">
        <p className="eyebrow">Precedent Finder</p>
        <div className="hero-actions">
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <button className="ghost-btn" type="button" onClick={onToggleAdvanced}>
            {showAdvanced ? "Hide advanced" : "Advanced"}
          </button>
        </div>
      </div>
      <h1>Find the most relevant Supreme Court and High Court precedents, fast</h1>
      <p>
        Describe your situation in plain language. The system searches, verifies, and ranks the closest legal
        precedents with confidence signals and transparent reasoning.
      </p>
    </section>
  );
}
