import { ResultDetailClient } from "./ResultDetailClient";

export default async function ResultDetailPage({
  params
}: {
  readonly params: Promise<{ readonly resultPackageId: string }>;
}) {
  const { resultPackageId } = await params;

  return (
    <main>
      <ResultDetailClient resultPackageId={decodeURIComponent(resultPackageId)} />
    </main>
  );
}
