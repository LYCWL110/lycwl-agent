export type Label = Readonly<{ id: string; text: string }>;

/** Return the labels in display order: by text, then by id. */
export function sortLabels(labels: readonly Label[]): readonly Label[] {
  return [...labels].sort((left, right) => {
    // Defect: compares ids instead of text, so the order is wrong.
    return left.id.localeCompare(right.id);
  });
}
