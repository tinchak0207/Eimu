// 文档站共用 UI 组件：自原单页 page.tsx 逐字移出，不做任何改写。
// 无 "use client"：纯展示组件，服务端/客户端页面均可使用。

export function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-ios-2xl bg-[rgba(0,0,0,0.06)] p-4 font-mono text-ios-footnote leading-relaxed text-[#242830]">
      <code>{children}</code>
    </pre>
  );
}

export function SectionTitle({
  icon: Icon,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-[#007AFF]" />
      <h2 className="text-ios-title3 font-semibold text-[rgba(0,0,0,0.85)]">{children}</h2>
    </div>
  );
}

export function Specular() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
  );
}

export function Step({
  n,
  title,
  note,
  code,
}: {
  n: string;
  title: string;
  note: React.ReactNode;
  code?: string;
}) {
  return (
    <div className="p-5 sm:p-7">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#007AFF] text-ios-caption1 font-bold text-white">
          {n}
        </span>
        <h3 className="text-ios-callout font-semibold text-[rgba(0,0,0,0.85)]">{title}</h3>
      </div>
      <p className="mt-2.5 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">{note}</p>
      {code ? (
        <div className="mt-3">
          <CodeBlock>{code}</CodeBlock>
        </div>
      ) : null}
    </div>
  );
}

export function KeyCard({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="lg-card flex flex-col rounded-ios-3xl p-5">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-[#007AFF]" />
        <p className="text-ios-callout font-semibold text-[rgba(0,0,0,0.85)]">{title}</p>
      </div>
      <div className="mt-2.5 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.58)]">{children}</div>
    </div>
  );
}

export function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-[rgba(0,0,0,0.05)] px-1.5 py-0.5 font-mono text-[#242830]">{children}</code>
  );
}
