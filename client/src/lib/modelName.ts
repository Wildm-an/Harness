/**
 * The model name without its provider: "BugsAI/qwen3" -> "qwen3". The app shows only the model
 * name. The model menus show the provider of each model in their headings.
 */
export function modelName(label: string): string {
  return label.split("/").pop() || label;
}
