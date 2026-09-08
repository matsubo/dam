import { Dam, GitBranch, type LucideIcon, WavesHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';

export type EntityKind = 'dam' | 'river' | 'watershed';

export const ENTITY_ICONS: Record<EntityKind, LucideIcon> = {
  dam: Dam,
  river: WavesHorizontal,
  watershed: GitBranch,
};

const ENTITY_LABELS: Record<EntityKind, string> = {
  dam: 'ダム',
  river: '河川',
  watershed: '水系',
};

export function EntityIcon({
  kind,
  size = 16,
  className,
  decorative = false,
}: {
  kind: EntityKind;
  size?: number;
  className?: string;
  /** Hide from assistive tech when a visible text label sits next to the icon. */
  decorative?: boolean;
}) {
  const Icon = ENTITY_ICONS[kind];
  return (
    <Icon
      size={size}
      className={className ?? 'text-on-surface-variant'}
      {...(decorative ? { 'aria-hidden': true } : { 'aria-label': ENTITY_LABELS[kind] })}
    />
  );
}

export function EntityLabel({
  kind,
  children,
  size = 16,
  iconClassName,
  className = 'inline-flex items-center gap-1.5',
}: {
  kind: EntityKind;
  children: ReactNode;
  size?: number;
  iconClassName?: string;
  className?: string;
}) {
  return (
    <span className={className}>
      <EntityIcon
        kind={kind}
        size={size}
        {...(iconClassName ? { className: iconClassName } : {})}
      />
      {children}
    </span>
  );
}
