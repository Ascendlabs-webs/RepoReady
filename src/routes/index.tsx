import { createFileRoute } from "@tanstack/react-router";
import { RepoReady } from "@/components/repo-ready";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <RepoReady />;
}
