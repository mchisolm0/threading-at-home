import { DashboardClient } from "./DashboardClient";

export default function DashboardPage() {
  if (process.env.NEXT_PUBLIC_CONVEX_URL === undefined) {
    return (
      <main>
        <section>
          <p>OSS Capacity</p>
          <h1>Convex configuration required.</h1>
          <p>Set NEXT_PUBLIC_CONVEX_URL to load the authenticated dashboard.</p>
        </section>
      </main>
    );
  }

  return (
    <main>
      <DashboardClient />
    </main>
  );
}
