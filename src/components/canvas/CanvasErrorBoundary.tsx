"use client";

import { Component, type ReactNode } from "react";

interface CanvasErrorBoundaryProps {
  children: ReactNode;
}

interface CanvasErrorBoundaryState {
  error: Error | null;
}

/** 画布主体出错时留在面板内，不把整页打成白屏。 */
export class CanvasErrorBoundary extends Component<CanvasErrorBoundaryProps, CanvasErrorBoundaryState> {
  state: CanvasErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): CanvasErrorBoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div role="alert" className="flex h-full min-h-[240px] w-full flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-sm text-[rgba(0,0,0,0.72)]">画布出错了</p>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="rounded-full bg-[rgba(0,0,0,0.86)] px-4 py-2 text-sm text-white"
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
