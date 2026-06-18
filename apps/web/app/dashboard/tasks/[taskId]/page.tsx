import { TaskDetailClient } from "./TaskDetailClient";

export default async function TaskDetailPage({
  params
}: {
  readonly params: Promise<{ readonly taskId: string }>;
}) {
  const { taskId } = await params;

  return (
    <main>
      <TaskDetailClient taskId={decodeURIComponent(taskId)} />
    </main>
  );
}
