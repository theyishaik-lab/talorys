/** Vite `?raw` imports: a file's source text (used by the wiring checks). */
declare module "*?raw" {
  const text: string;
  export default text;
}

/** Vite's `import.meta.glob` (eager `?raw` reads of many files, used by the wiring checks). */
interface ImportMeta {
  glob(pattern: string, options: { eager: true; query: "?raw"; import: "default" }): Record<string, string>;
}
