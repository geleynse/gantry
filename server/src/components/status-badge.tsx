import { getStateColor, getStateLabel } from '@/lib/agent-display-state';
import type { AgentDisplayState } from '@/lib/agent-display-state';
import { cn } from '@/lib/utils';

interface StatusBadgeProps {
  state: AgentDisplayState;
  size?: 'sm' | 'md' | 'lg';
  subLabel?: string;
}

const sizeClasses = {
  sm: 'px-2 py-0.5 text-[10px]',
  md: 'px-2.5 py-1 text-sm',
  lg: 'px-3 py-1.5 text-base',
};

export function StatusBadge({ state, size = 'md', subLabel }: StatusBadgeProps) {
  return (
    <span
      data-testid="status-badge"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md font-medium whitespace-nowrap',
        getStateColor(state),
        sizeClasses[size],
      )}
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-current opacity-80" />
      <span>
        {getStateLabel(state)}
        {subLabel && (
          <span className="ml-1 opacity-80 font-normal">
            ({subLabel})
          </span>
        )}
      </span>
    </span>
  );
}
