export function makeFooter(
  threadId: string,
  reviewId?: string,
  role?: "reviewer" | "writer",
): string {
  const parts: string[] = [];
  if (role) parts.push(role);
  parts.push(`thread::${threadId}`);
  if (reviewId) parts.push(`review::${reviewId}`);
  return `\n\n---\n<sub>${parts.join(" | ")}</sub>`;
}
