"use client";

import type { CSSProperties } from "react";
import { AGENT_TEMPLATES } from "@/lib/agent-templates";
import { REPLICATE_FILMS, type ReplicateFilm } from "@/lib/replicate-films";
import { cn } from "@/lib/utils";
import "../case-showcase.css";
import "./agent-template-carousel.css";

const CARD_STYLE: CSSProperties = {
  position: "relative",
  left: "auto",
  top: "auto",
  marginLeft: 0,
  marginTop: 0,
  width: 220,
  height: 148,
  flex: "0 0 auto",
  ["--case-card-w" as string]: "220px",
  ["--case-card-h" as string]: "148px",
};

export function ReplicateFilmRow({
  films = REPLICATE_FILMS,
  onReplicate,
}: {
  films?: readonly ReplicateFilm[];
  onReplicate: (sentence: string) => void;
}) {
  return (
    <section className="w-full shrink-0 px-3 pb-3" aria-label="复刻这部片">
      <div className="flex flex-nowrap gap-3 overflow-x-auto pb-1">
        {films.map((film, index) => {
          const accent = AGENT_TEMPLATES[index % AGENT_TEMPLATES.length]?.accent;
          return (
            <button
              key={film.id}
              type="button"
              className="case-slab cursor-pointer border-0 bg-transparent p-0 text-left"
              style={CARD_STYLE}
              onClick={() => onReplicate(film.sentence)}
            >
              <div className="case-face">
                <div className="case-media">
                  <div className="case-photo">
                    <div className={cn("absolute inset-0 bg-gradient-to-br", accent)}>
                      <div className="atc-info">
                        <div className="atc-title">{film.title}</div>
                        <div className="atc-script-entry">{film.sentence}</div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="case-edge" aria-hidden="true" />
                <div className="case-surface" aria-hidden="true">
                  <div className="case-sheen" />
                  <div className="case-rim case-rim-l" />
                  <div className="case-rim case-rim-r" />
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
