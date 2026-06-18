import { anyApi, cronJobs } from "convex/server";

const crons = cronJobs();

crons.interval(
  "expire stale task leases",
  { minutes: 5 },
  anyApi.lifecycle.expireStaleLeases,
  {}
);

crons.interval(
  "cleanup stale task runs",
  { minutes: 15 },
  anyApi.lifecycle.cleanupStaleRuns,
  {}
);

export default crons;
