import type { ComponentType, ReactNode } from "react";
import { BellRing } from "lucide-react";
import { useT } from "../lib/i18n";

/**
 * Settings → "Device notifications". Phase 2 (PWA + Web Push, branch feat/pwa-push) replaces the
 * body of this component with the real enable button, per-type toggles and the test button; the
 * redesign only reserves the group so the Settings screen already has its final shape.
 */
export function DeviceNotificationsSection({
  Section,
  Row,
}: {
  Section: ComponentType<{ title?: string; children: ReactNode }>;
  Row: ComponentType<{ label: string; hint?: ReactNode; children: ReactNode }>;
}) {
  const t = useT();
  return (
    <Section title={t("settings.deviceNotifications")}>
      <Row label={t("settings.deviceNotifications")} hint={t("settings.deviceNotificationsHint")}>
        <div className="flex justify-end text-fg-subtle">
          <BellRing className="h-[19px] w-[19px]" aria-hidden />
        </div>
      </Row>
    </Section>
  );
}
