/** A two-state segmented control: the Active/All switch. */

import { cn } from '../../lib/utils.js';

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string; count?: number }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md bg-muted p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
            value === option.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
          {option.count === undefined ? null : (
            <span className="ml-1 tabular-nums opacity-60">{option.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
