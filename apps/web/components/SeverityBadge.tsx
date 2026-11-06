import type { Severity } from "@ironnews/shared";

export function SeverityBadge({ severity, label }: { severity: Severity; label: string }) {
  return (
    <span className={`badge badge--${severity}`}>
      <span className="badge__dot" aria-hidden="true" />
      {label}
    </span>
  );
}
