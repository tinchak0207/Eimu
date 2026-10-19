"use client";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-base font-medium text-[rgba(0,0,0,0.85)]">页面出错了</p>
      <p className="max-w-md text-sm text-[rgba(0,0,0,0.55)]">{error.message || "请重试"}</p>
      <button
        type="button"
        onClick={reset}
        className="rounded-full bg-[rgba(0,0,0,0.86)] px-4 py-2 text-sm text-white"
      >
        重试
      </button>
    </div>
  );
}
