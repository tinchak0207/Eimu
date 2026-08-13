import { AdminLogin } from "@/components/admin/AdminLogin";
import { AdminPoolManager } from "@/components/admin/AdminPoolManager";
import { getAdminSession } from "@/lib/admin-session";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const session = await getAdminSession();
  return session ? <AdminPoolManager username={session.username} /> : <AdminLogin />;
}
