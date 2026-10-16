import { createServerFn } from "@tanstack/react-start";
import { ingestRepository } from "./ingest.ts";

export const ingestGithubRepo = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const url = typeof input === "object" && input && "url" in input ? String((input as { url: unknown }).url) : "";
    if (!url || url.length > 300) throw new Error("Enter a GitHub repository URL.");
    return { url };
  })
  .handler(async ({ data }) => ingestRepository(data.url));
