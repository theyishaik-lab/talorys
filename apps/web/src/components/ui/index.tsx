import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  forwardRef,
  useEffect,
  useRef,
} from "react";
import { Loader2, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { useT } from "../../lib/i18n";
import { useHistoryLayer } from "../../lib/native";

// Small shadcn-style primitives, styled with the Talorys tokens.

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "icon";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:opacity-90",
  secondary: "bg-muted text-fg hover:bg-border",
  ghost: "text-fg-muted hover:bg-subtle hover:text-fg",
  outline: "border border-border bg-surface text-fg hover:bg-subtle",
  danger: "bg-danger text-white hover:opacity-90",
};
const sizes: Record<Size, string> = {
  sm: "h-9 px-3.5 text-sm gap-1.5",
  md: "h-11 px-4 text-[15px] gap-2",
  icon: "h-10 w-10 justify-center",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading, className, children, disabled, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        "pressable inline-flex shrink-0 items-center rounded-xl font-semibold disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

const field =
  "w-full rounded-xl border border-border bg-subtle px-3.5 text-[15px] text-fg placeholder:text-fg-subtle transition-colors focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-60";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(field, "h-11", className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref,
) {
  return <textarea ref={ref} className={cn(field, "py-2 leading-6", className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...props },
  ref,
) {
  return (
    <select ref={ref} className={cn(field, "h-11 pe-8", className)} {...props}>
      {children}
    </select>
  );
});

export function Label({ children, htmlFor, hint }: { children: ReactNode; htmlFor?: string; hint?: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-fg">
      {children}
      {hint && <span className="mt-0.5 block text-xs font-normal text-fg-subtle">{hint}</span>}
    </label>
  );
}

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "accent" | "danger" | "warning" | "success"; className?: string }) {
  const tones = {
    neutral: "bg-muted text-fg-muted",
    accent: "bg-accent-soft text-accent",
    danger: "bg-danger-soft text-danger",
    warning: "bg-warning/15 text-warning",
    success: "bg-success/15 text-success",
  };
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold", tones[tone], className)}>{children}</span>;
}

export function Spinner({ className }: { className?: string }) {
  const t = useT();
  return <Loader2 className={cn("h-5 w-5 animate-spin text-fg-subtle", className)} aria-label={t("common.loading")} />;
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center animate-fade-in">
      {icon && <div className="mb-4 text-fg-subtle">{icon}</div>}
      <h3 className="text-base font-semibold text-fg">{title}</h3>
      {children && <p className="mt-1.5 max-w-sm text-sm leading-6 text-fg-muted">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 pb-6">
      <div className="min-w-0">
        {/* On phones the shell's top bar already carries the page title. */}
        <h1 className="hidden text-[28px] font-semibold leading-tight tracking-[-0.01em] text-fg lg:block">{title}</h1>
        {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useT();
  const message = error instanceof Error ? error.message : t("common.somethingWrong");
  return (
    <div role="alert" className="flex items-start justify-between gap-3 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="shrink-0 font-medium underline underline-offset-2" onClick={onRetry}>
          {t("common.retry")}
        </button>
      )}
    </div>
  );
}

/** Accessible modal dialog built on the native <dialog> element. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const t = useT();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  // The Android back button / gesture closes the sheet instead of leaving the app.
  useHistoryLayer(open, onClose);
  return (
    <dialog
      ref={ref}
      // Only user-initiated closes; the effect's own el.close() (open → false) must not re-trigger onClose.
      onClose={() => {
        if (open) onClose();
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        // A bottom sheet on phones, a centered card from the tablet width up.
        "fixed inset-x-0 bottom-0 top-auto m-0 w-full max-w-none rounded-t-3xl border-0 bg-surface p-0 text-fg shadow-card backdrop:bg-[var(--scrim)] sm:inset-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[calc(100%-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl sm:border sm:border-border",
        wide ? "sm:max-w-2xl" : "sm:max-w-md",
      )}
    >
      {open && (
        <div className="animate-sheet-up sm:animate-slide-up">
          <div className="mx-auto mt-2 h-1 w-9 rounded-full bg-border-strong sm:hidden" aria-hidden />
          <div className="flex items-center justify-between px-5 pb-2 pt-3 sm:pt-4">
            <h2 className="text-[17px] font-semibold">{title}</h2>
            <button type="button" onClick={onClose} className="pressable rounded-full bg-subtle p-1.5 text-fg-muted hover:text-fg" aria-label={t("common.close")}>
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="max-h-[70dvh] overflow-y-auto px-5 py-3">{children}</div>
          {footer ? (
            <div className="flex justify-end gap-2 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-2 sm:pb-4">{footer}</div>
          ) : (
            <div className="h-[max(0.75rem,env(safe-area-inset-bottom))] sm:h-2" />
          )}
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  loading,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}) {
  const t = useT();
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={loading}>
            {confirmLabel ?? t("common.delete")}
          </Button>
        </>
      }
    >
      <div className="text-sm leading-6 text-fg-muted">{message}</div>
    </Dialog>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-[26px] w-11 shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-50",
        checked ? "bg-success" : "bg-border-strong",
      )}
    >
      <span className={cn("inline-block h-5 w-5 rounded-full bg-white shadow transition-transform duration-200", checked ? "translate-x-[21px] rtl:-translate-x-[21px]" : "translate-x-[3px] rtl:-translate-x-[3px]")} />
    </button>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn("rounded-2xl border border-border bg-surface", className)}>{children}</section>;
}
