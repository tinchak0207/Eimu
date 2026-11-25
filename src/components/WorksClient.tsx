"use client";

// 「我的作品」网页版：与小程序 pages/project/index 同一组接口、同一套话术。
// 做完了没有 → 整片 → 镜头墙 → 点一镜对照新旧 → 用这条（只动这一镜）→ 说一句改这镜（带镜号去助理）。
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  adoptVersion, fetchMaster, fetchProjects, fetchReview, fetchShared, forkShared, importScript, isSignedIn,
  publishShare, revokeShare, stashAgentDraft,
  type MasterReceipt, type ProjectReview, type ProjectSummaryRow, type SharedView,
} from "@/lib/canvas/review-client";

type Shot = ProjectReview["shots"][number];

const STATE_LABEL: Record<Shot["state"], string> = {
  ready: "可直接用", stale: "改过，旧稿待重做", pending: "生成中", failed: "失败，可单独补跑", empty: "还没出",
};
const STATE_TONE: Record<Shot["state"], string> = {
  ready: "text-green-600", stale: "text-orange-600", pending: "text-blue-600", failed: "text-red-600", empty: "text-foreground/45",
};

function Thumb({ url, kind, className = "h-32" }: { url?: string; kind?: "image" | "video"; className?: string }) {
  if (!url) return <div className={`flex w-full items-center justify-center rounded-xl bg-black/[0.04] text-xs text-foreground/40 ${className}`}>暂无</div>;
  if (kind === "video") return <video src={url} muted playsInline preload="metadata" controls className={`w-full rounded-xl bg-black object-cover ${className}`} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" loading="lazy" className={`w-full rounded-xl bg-black/[0.04] object-cover ${className}`} />;
}

const btn = "inline-flex min-h-11 items-center justify-center rounded-full px-5 text-sm font-medium transition disabled:opacity-50";
const btnPrimary = `${btn} bg-blue-600 text-white hover:bg-blue-700`;
const btnGhost = `${btn} bg-black/[0.06] text-foreground hover:bg-black/[0.1]`;

export function WorksClient() {
  const router = useRouter();
  const params = useSearchParams();
  const sharedId = params.get("share") ?? "";
  const openId = params.get("open") ?? "";
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [projects, setProjects] = useState<ProjectSummaryRow[]>([]);
  const [review, setReview] = useState<ProjectReview | null>(null);
  const [master, setMaster] = useState<MasterReceipt | null>(null);
  const [shared, setShared] = useState<SharedView | null>(null);
  const [myShareId, setMyShareId] = useState("");
  const [episode, setEpisode] = useState<number | null>(null);
  const [openShot, setOpenShot] = useState<string | null>(null);
  const [compare, setCompare] = useState<string | null>(null);
  const [script, setScript] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const flash = useCallback((text: string) => { setToast(text); setTimeout(() => setToast(""), 3200); }, []);

  const openProject = useCallback(async (id: string) => {
    setError("");
    try {
      const [r, m] = await Promise.all([fetchReview(id), fetchMaster(id)]);
      setReview(r); setMaster(m);
    } catch (e) { setError(e instanceof Error ? e.message : "读取作品失败"); }
  }, []);

  useEffect(() => {
    setSignedIn(isSignedIn());
    setReady(true);
    if (sharedId) { fetchShared(sharedId).then(setShared).catch(() => setError("这个分享不存在或已被撤销")); return; }
    if (!isSignedIn()) return;
    if (openId) { void openProject(openId); return; }
    fetchProjects().then((list) => setProjects(list)).catch((e) => setError(e instanceof Error ? e.message : "读取作品失败"));
  }, [sharedId, openId, openProject]);

  const shots = (review?.shots ?? []).filter((s) => episode === null || s.episodeNo === episode);
  const current = review?.shots.find((s) => s.nodeId === openShot) ?? null;

  async function adopt(shot: Shot, pick: { version?: string; candidateId?: string }, label: string) {
    if (!review || busy) return;
    setBusy(true);
    try {
      setReview(await adoptVersion(review.projectId, shot.nodeId, pick));
      flash(`${label}，其余镜头、台词、配乐没有动`);
      setCompare(null);
    } catch (e) { flash(e instanceof Error ? e.message : "没有改成，原样保留"); } finally { setBusy(false); }
  }
  function sayAbout(text: string) {
    stashAgentDraft(text);
    router.push("/?agent=1");
  }
  async function doImport() {
    if (!script.trim() || busy) return;
    setBusy(true);
    try {
      const r = await importScript(script);
      setScript("");
      if (r.sampleDraft) stashAgentDraft(r.sampleDraft);
      flash(r.policy === "finished" ? `已按原文切成 ${r.shotCount} 镜，台词一字不改` : `已建好项目（${r.shotCount} 镜）`);
      await openProject(r.projectId);
    } catch (e) { flash(e instanceof Error ? e.message : "导入失败，没有创建任何东西"); } finally { setBusy(false); }
  }
  async function share() {
    if (!review || busy) return;
    setBusy(true);
    try {
      const id = await publishShare(review.projectId);
      setMyShareId(id);
      await navigator.clipboard?.writeText(`${location.origin}/works?share=${id}`).catch(() => undefined);
      flash("已发布这一刻的版本，链接已复制；之后你再改，不影响已发布的这份");
    } catch (e) { flash(e instanceof Error ? e.message : "发布失败"); } finally { setBusy(false); }
  }
  async function unshare() {
    if (!myShareId) return;
    try { await revokeShare(myShareId); setMyShareId(""); flash("已撤销，对方再打开会看到「已撤销」"); } catch (e) { flash(e instanceof Error ? e.message : "撤销失败"); }
  }
  async function copyShared() {
    if (!sharedId || busy) return;
    if (!isSignedIn()) { flash("先登录，再复制成你的项目"); return; }
    setBusy(true);
    try {
      const id = await forkShared(sharedId);
      router.push(`/works?open=${encodeURIComponent(id)}`);
    } catch (e) { flash(e instanceof Error ? e.message : "复制失败，没有创建任何东西"); } finally { setBusy(false); }
  }

  if (!ready) return <div className="min-h-screen" />;

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-4 pb-28 pt-8 sm:px-6">
      {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}

      {sharedId ? (
        <section className="space-y-3">
          {shared ? <h1 className="text-xl font-semibold">{shared.title || "分享的作品"}</h1> : null}
          {shared ? <p className="text-sm text-foreground/55">{shared.summary}（这是作者发布的版本，只读）</p> : null}
          {shared ? <button type="button" className={btnPrimary} disabled={busy} onClick={() => void copyShared()}>{busy ? "复制中…" : "复制成我的项目，接着做"}</button> : null}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {shared?.shots.map((s) => (
              <div key={`${s.episodeNo ?? 0}-${s.shotNumber}`} className="rounded-2xl border border-black/5 bg-white/60 p-2">
                <Thumb url={s.adoptedUrl} kind={s.adoptedKind} />
                <p className="mt-1.5 text-sm font-medium">{`${s.episodeNo ? `第${s.episodeNo}集 ` : ""}第 ${s.shotNumber} 镜`}</p>
              </div>
            ))}
          </div>
        </section>
      ) : !signedIn ? (
        <p className="py-20 text-center text-sm text-foreground/55">登录后查看你的作品。<Link href="/" className="ml-1 text-blue-600">回首页登录</Link></p>
      ) : !review ? (
        <section className="space-y-3">
          <h1 className="text-xl font-semibold">我的作品</h1>
          {projects.length === 0 && !error ? <p className="text-sm text-foreground/50">还没有作品。回到对话说出想拍的片子，做出来后会出现在这里。</p> : null}
          <div className="rounded-2xl border border-black/5 bg-white/60 p-4">
            <p className="font-medium">已有剧本？直接导入</p>
            <p className="mt-0.5 text-xs text-foreground/45">按原文切镜，台词不改；导入不花钱。之后可先只试第 1 镜的风格。</p>
            <textarea value={script} onChange={(e) => setScript(e.target.value)} maxLength={20000} rows={5} placeholder={"场1 天台 黄昏\n她：你来晚了。"} className="mt-2 w-full rounded-xl border border-black/10 bg-white p-3 text-sm" />
            <button type="button" className={`${script.trim() ? btnPrimary : btnGhost} mt-2`} disabled={!script.trim() || busy} onClick={() => void doImport()}>{busy ? "导入中…" : "导入剧本"}</button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {projects.map((p) => (
              <button key={p.id} type="button" className="rounded-2xl border border-black/5 bg-white/60 px-4 py-3 text-left hover:bg-white" onClick={() => void openProject(p.id)}>
                <p className="font-medium">{p.title || "未命名作品"}</p>
                <p className="text-xs text-foreground/45">{p.nodeCount} 个节点</p>
              </button>
            ))}
          </div>
        </section>
      ) : (
        <section className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-xl font-semibold">{review.title || "未命名作品"}</h1>
            <button type="button" className="text-sm text-blue-600" onClick={() => { setReview(null); setMaster(null); setEpisode(null); void fetchProjects().then(setProjects).catch(() => undefined); }}>全部作品 / 导入剧本</button>
          </div>
          <div className="rounded-2xl border border-black/5 bg-white/60 p-4">
            <p>{review.summary.headline}</p>
            {review.summary.nextAction ? (
              <button type="button" className={`${btnPrimary} mt-2`} onClick={() => sayAbout(review.summary.nextAction!.label)}>{review.summary.nextAction.label}</button>
            ) : null}
            {review.continuity.cardCount > 0 || review.continuity.narrationVoice ? (
              <p className="mt-1 text-xs text-foreground/45">已留存：{review.continuity.cardCount} 张角色/场景卡{review.continuity.narrationVoice ? ` · 旁白音色 ${review.continuity.narrationVoice}` : ""}，接着做下一集会沿用</p>
            ) : null}
          </div>
          <div className="rounded-2xl border border-black/5 bg-white/60 p-4">
            {master?.hasCut && master.latest ? (
              <div>
                <p className="font-medium">整片已导出{master.latest.durationSec ? ` · ${Math.round(master.latest.durationSec)} 秒` : ""}</p>
                <video src={master.latest.deliveryUrl} controls className="mt-2 max-h-80 w-full rounded-xl bg-black" />
                <a className={`${btnGhost} mt-2`} href={master.latest.deliveryUrl} download target="_blank" rel="noreferrer">下载整片</a>
              </div>
            ) : (
              <p className="text-sm text-foreground/55">{master?.known === false ? "暂时查不到整片状态" : "还没有导出整片：镜头都满意后对我说「合成整片」"}</p>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" className={`${btnGhost} flex-1`} disabled={busy} onClick={() => void share()}>{myShareId ? "重新发布当前版本" : "发布给朋友（可接着做）"}</button>
            {myShareId ? <button type="button" className={btnGhost} onClick={() => void unshare()}>撤销</button> : null}
          </div>
          {review.episodes.length > 1 ? (
            <div className="flex gap-2 overflow-x-auto">
              {[{ id: "all", no: null as number | null, title: "全部" }, ...review.episodes.map((e) => ({ id: e.id, no: e.episodeNo as number | null, title: `第 ${e.episodeNo} 集 ${e.ready}/${e.shots}` }))].map((e) => (
                <button key={e.id} type="button" className={`inline-flex min-h-9 shrink-0 items-center rounded-full px-3 text-sm ${episode === e.no ? "bg-blue-600 text-white" : "bg-black/[0.05]"}`} onClick={() => setEpisode(e.no)}>{e.title}</button>
              ))}
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {shots.map((s) => (
              <button key={s.nodeId} type="button" className="rounded-2xl border border-black/5 bg-white/60 p-2 text-left hover:bg-white" onClick={() => { setOpenShot(s.nodeId); setCompare(null); }}>
                <Thumb url={s.adoptedUrl} kind={s.adoptedKind} />
                <p className="mt-1.5 text-sm font-medium">{`${s.episodeNo ? `第${s.episodeNo}集 ` : ""}第 ${s.shotNumber} 镜`}</p>
                <p className={`text-xs ${STATE_TONE[s.state]}`}>{s.newVersionWaiting ? "新版等你选" : STATE_LABEL[s.state]}{s.versions.length > 1 ? ` · ${s.versions.length} 版` : ""}</p>
              </button>
            ))}
          </div>
        </section>
      )}

      {current ? (
        <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/40 sm:items-center" onClick={() => setOpenShot(null)}>
          <div className="max-h-[88dvh] w-full max-w-2xl overflow-y-auto rounded-t-3xl bg-background p-5 sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold">{`第 ${current.shotNumber} 镜`}<span className={`ml-2 text-sm ${STATE_TONE[current.state]}`}>{current.newVersionWaiting ? "新版等你选" : STATE_LABEL[current.state]}</span></h2>
            <p className="mt-1 text-sm text-foreground/55">{current.summary}</p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div><p className="pb-1 text-xs text-foreground/45">当前采用</p><Thumb url={current.adoptedUrl} kind={current.adoptedKind} className="h-40" /></div>
              {compare ? (() => { const v = current.versions.find((x) => x.version === compare); return <div><p className="pb-1 text-xs text-foreground/45">对照这一版{v?.stale ? "（旧稿）" : ""}</p><Thumb url={v?.url} kind={v?.kind} className="h-40" /></div>; })() : <div className="flex items-center justify-center rounded-xl bg-black/[0.03] text-xs text-foreground/40">点下面一版来对照</div>}
            </div>
            <p className="mt-4 text-sm text-foreground/55">所有版本（点一版对照，再决定用不用）</p>
            <div className="mt-1 flex gap-2 overflow-x-auto">
              {current.versions.map((v, i) => (
                <button key={v.version} type="button" className={`w-28 shrink-0 text-left ${compare === v.version ? "" : "opacity-80"}`} onClick={() => setCompare(v.adopted ? null : v.version)}>
                  <Thumb url={v.url} kind={v.kind} className="h-20" />
                  <span className="block text-xs text-foreground/55">{`第 ${i + 1} 版${v.adopted ? " · 当前" : ""}${v.stale ? " · 旧稿" : ""}`}</span>
                </button>
              ))}
              {current.candidates.map((c, i) => (
                <button key={c.id} type="button" className="w-28 shrink-0 text-left" onClick={() => { if (!c.adopted) void adopt(current, { candidateId: c.id }, `已改用候选 ${i + 1}`); }}>
                  <Thumb url={c.url} kind="video" className="h-20" />
                  <span className="block text-xs text-foreground/55">{`候选 ${i + 1}${c.adopted ? " · 当前" : "（点一下用这条）"}`}</span>
                </button>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {compare ? <button type="button" className={btnPrimary} disabled={busy} onClick={() => { const v = current.versions.find((x) => x.version === compare); if (v) void adopt(current, { version: v.version }, "已改用这一版"); }}>用这条</button> : null}
              <button type="button" className={btnGhost} onClick={() => sayAbout(`第 ${current.shotNumber} 镜（${current.summary}）：`)}>说一句改这镜</button>
              {current.adoptedUrl ? <a className={btnGhost} href={current.adoptedUrl} download target="_blank" rel="noreferrer">下载这一镜</a> : null}
            </div>
          </div>
        </div>
      ) : null}
      {toast ? <div className="fixed inset-x-6 bottom-8 z-[99] mx-auto max-w-md rounded-full bg-black/80 px-4 py-2.5 text-center text-sm text-white">{toast}</div> : null}
    </main>
  );
}
