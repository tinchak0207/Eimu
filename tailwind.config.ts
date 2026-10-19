import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        // iOS 26 system colors
        ios: {
          blue:   "#007AFF",
          green:  "#34C759",
          red:    "#FF3B30",
          orange: "#FF9500",
          yellow: "#FFCC00",
          purple: "#AF52DE",
          pink:   "#FF2D55",
          teal:   "#5AC8FA",
          indigo: "#5856D6",
          gray:   {
            1: "#8E8E93",
            2: "#AEAEB2",
            3: "#C7C7CC",
            4: "#D1D1D6",
            5: "#E5E5EA",
            6: "#F2F2F7",
          },
          label: {
            primary:   "rgba(0,0,0,0.85)",
            secondary: "rgba(0,0,0,0.50)",
            tertiary:  "rgba(0,0,0,0.30)",
            quaternary:"rgba(0,0,0,0.18)",
          },
        },
      },
      borderRadius: {
        // iOS 26 continuous corner radius scale
        "ios-xs": "0.5rem",
        "ios-sm": "0.75rem",
        "ios-md": "1rem",
        "ios-lg": "1.25rem",
        "ios-xl": "1.5rem",
        "ios-2xl": "2rem",
        "ios-3xl": "2.5rem",
        "ios-4xl": "3rem",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        // iOS 26 system font stack
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          '"SF Pro Display"',
          '"SF Pro Text"',
          "var(--font-geist-sans)",
          "system-ui",
          "sans-serif",
        ],
        mono: [
          '"SF Mono"',
          "var(--font-geist-mono)",
          "ui-monospace",
          "monospace",
        ],
      },
      fontSize: {
        // iOS 26 Dynamic Type scale
        "ios-caption2": ["0.6875rem", { lineHeight: "1rem",    letterSpacing: "0.01em" }],
        "ios-caption1": ["0.75rem",   { lineHeight: "1.125rem", letterSpacing: "0.005em" }],
        "ios-footnote": ["0.8125rem", { lineHeight: "1.125rem", letterSpacing: "0.005em" }],
        "ios-subhead":  ["0.9375rem", { lineHeight: "1.25rem",  letterSpacing: "-0.01em" }],
        "ios-callout":  ["1rem",      { lineHeight: "1.375rem", letterSpacing: "-0.01em" }],
        "ios-body":     ["1.0625rem", { lineHeight: "1.5rem",   letterSpacing: "-0.015em" }],
        "ios-headline": ["1.0625rem", { lineHeight: "1.375rem", letterSpacing: "-0.015em", fontWeight: "600" }],
        "ios-title3":   ["1.25rem",   { lineHeight: "1.625rem", letterSpacing: "-0.02em" }],
        "ios-title2":   ["1.375rem",  { lineHeight: "1.75rem",  letterSpacing: "-0.025em" }],
        "ios-title1":   ["1.75rem",   { lineHeight: "2.125rem", letterSpacing: "-0.03em" }],
        "ios-largetitle":["2.125rem", { lineHeight: "2.5rem",   letterSpacing: "-0.04em" }],
      },
      backdropBlur: {
        "ios-thin":    "8px",
        "ios-regular": "20px",
        "ios-thick":   "40px",
        "ios-chrome":  "60px",
      },
      transitionTimingFunction: {
        "ios-spring": "cubic-bezier(0.34, 1.56, 0.64, 1)",
        "ios-ease":   "cubic-bezier(0.4, 0, 0.2, 1)",
        "ios-bounce": "cubic-bezier(0.68, -0.55, 0.265, 1.55)",
      },
      keyframes: {
        "lg-appear": {
          "0%":   { opacity: "0", transform: "scale(0.94) translateY(8px)" },
          "100%": { opacity: "1", transform: "scale(1) translateY(0)" },
        },
        "lg-dismiss": {
          "0%":   { opacity: "1", transform: "scale(1) translateY(0)" },
          "100%": { opacity: "0", transform: "scale(0.94) translateY(8px)" },
        },
        "lg-shimmer": {
          "0%":   { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        "lg-appear":  "lg-appear 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both",
        "lg-dismiss": "lg-dismiss 0.25s cubic-bezier(0.4, 0, 0.2, 1) both",
        "lg-shimmer": "lg-shimmer 1.8s ease-in-out infinite",
      },
    },
  },
  plugins: [tailwindcssAnimate],
};
export default config;
