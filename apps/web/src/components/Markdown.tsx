import { memo, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { cn, copyText } from "../lib/utils";

function CodeBlock({ children, className }: { children?: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const text = String(children ?? "").replace(/\n$/, "");
  const lang = /language-(\w+)/.exec(className ?? "")?.[1];
  return (
    <div className="group relative" dir="ltr">
      <div className="absolute right-2 top-2 flex items-center gap-2">
        {lang && <span className="text-[11px] uppercase tracking-wide text-fg-subtle">{lang}</span>}
        <button type="button"
          onClick={() => {
            void copyText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="rounded-md border border-border bg-surface p-1 text-fg-subtle opacity-0 transition-opacity hover:text-fg group-hover:opacity-100 focus:opacity-100"
          aria-label="Copy code"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      <pre dir="ltr">
        <code className={className}>{text}</code>
      </pre>
    </div>
  );
}

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const isBlock = /language-/.test(className ?? "") || String(children).includes("\n");
    return isBlock ? <CodeBlock className={className}>{children}</CodeBlock> : <code dir="ltr">{children}</code>;
  },
  // Each block decides its own direction from its first strong character, so a Hebrew answer that
  // quotes an English line (or the reverse) reads correctly paragraph by paragraph.
  p: ({ children }) => <p dir="auto">{children}</p>,
  h1: ({ children }) => <h1 dir="auto">{children}</h1>,
  h2: ({ children }) => <h2 dir="auto">{children}</h2>,
  h3: ({ children }) => <h3 dir="auto">{children}</h3>,
  h4: ({ children }) => <h4 dir="auto">{children}</h4>,
  li: ({ className, children }) => (
    <li className={className} dir="auto">
      {children}
    </li>
  ),
  blockquote: ({ children }) => <blockquote dir="auto">{children}</blockquote>,
  th: ({ children, style }) => <th dir="auto" style={style}>{children}</th>,
  td: ({ children, style }) => <td dir="auto" style={style}>{children}</td>,
  // Links open in a new tab without referrer or opener.
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
  // Never load remote images from model output (privacy + exfiltration defence).
  img: ({ alt }) => <span className="text-fg-subtle">[image: {alt}]</span>,
};

/** Task list items with clickable checkboxes; `line` is the 0-based source line. */
function taskComponents(onToggleTask: (line: number) => void): Components {
  return {
    ...components,
    input: ({ checked, type }) =>
      type === "checkbox" ? <input type="checkbox" checked={!!checked} readOnly aria-label={checked ? "Mark as not done" : "Mark as done"} /> : null,
    li: ({ node, className, children }) => {
      const line = (node?.position?.start.line ?? 0) - 1;
      const isTask = className?.includes("task-list-item");
      const done = isTask && node?.children.some((c) => c.type === "element" && c.tagName === "input" && c.properties?.checked);
      return (
        <li
          className={cn(className, done && "task-done")}
          dir="auto"
          onClick={isTask ? (e) => {
            if ((e.target as HTMLElement).tagName === "INPUT") onToggleTask(line);
          } : undefined}
        >
          {children}
        </li>
      );
    },
  };
}

/** Safe Markdown renderer: raw HTML is not rendered (react-markdown default). */
export const Markdown = memo(function Markdown({ content, compact, onToggleTask }: { content: string; compact?: boolean; onToggleTask?: (line: number) => void }) {
  const comps = useMemo(() => (onToggleTask ? taskComponents(onToggleTask) : components), [onToggleTask]);
  return (
    <div className={cn("prose-talorys", compact && "text-sm leading-6")} dir="auto">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={comps} skipHtml>
        {content}
      </ReactMarkdown>
    </div>
  );
});
